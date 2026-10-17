import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CommandDispatcher } from '../../src/commands/dispatcher.js';
import { blinkIdentify, SimLed } from '../../src/commands/led.js';
import type { CommandAck } from '../../src/protocol/types.js';
import { openDb } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/util/clock.js';
import { silentLogger } from '../../src/util/logger.js';

const NOW = Date.parse('2026-11-01T00:15:00+07:00');

function setup(handlers: ConstructorParameters<typeof CommandDispatcher>[0]['handlers'] = {}) {
  const acks: CommandAck[] = [];
  const clock = new VirtualClock(NOW);
  const d = new CommandDispatcher({
    db: openDb(':memory:'),
    clock,
    timeZone: 'Asia/Bangkok',
    logger: silentLogger(),
    sendAck: (a) => acks.push(a),
    handlers,
  });
  return { d, acks, clock };
}

const cmd = (type: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ cmdId: randomUUID(), type, issuedAt: '2026-11-01T00:14:00+07:00', ...over });

describe('CommandDispatcher', () => {
  it('acks accepted at once, then done with the result', async () => {
    const { d, acks } = setup({ read_now: async (args) => ({ read: args.meterIds }) });
    const c = cmd('read_now', { args: { meterIds: ['m1'] } });
    await d.handle(c);
    expect(acks.map((a) => a.status)).toEqual(['accepted', 'done']);
    expect(acks[1]).toMatchObject({ result: { read: ['m1'] }, error: null, finishedAt: '2026-11-01T00:15:00+07:00' });
  });

  it('acks failed with the error when the handler throws', async () => {
    const { d, acks } = setup({ identify: async () => Promise.reject(new Error('no LED')) });
    await d.handle(cmd('identify'));
    expect(acks.map((a) => [a.status, a.error])).toEqual([
      ['accepted', null],
      ['failed', 'no LED'],
    ]);
  });

  it('drops expired commands (issuedAt + ttlS) with a failed ack and never runs them', async () => {
    let ran = false;
    const { d, acks } = setup({
      restart: async () => {
        ran = true;
        return {};
      },
    });
    await d.handle(cmd('restart', { issuedAt: '2026-11-01T00:00:00+07:00', ttlS: 300 }));
    expect(ran).toBe(false);
    expect(acks).toEqual([expect.objectContaining({ status: 'failed', error: 'expired' })]);
    // default ttl 300 s
    await d.handle(cmd('restart', { issuedAt: '2026-11-01T00:09:59+07:00' }));
    expect(ran).toBe(false);
  });

  it('never executes a redelivered cmdId twice; re-sends the last ack instead', async () => {
    let runs = 0;
    const { d, acks } = setup({
      read_now: async () => {
        runs++;
        return {};
      },
    });
    const c = cmd('read_now');
    await d.handle(c);
    await d.handle(c);
    await d.handle(c);
    expect(runs).toBe(1);
    expect(acks.map((a) => a.status)).toEqual(['accepted', 'done', 'done', 'done']);
  });

  it('answers unsupported and invalid commands safely', async () => {
    const { d, acks } = setup({});
    await d.handle(cmd('ota_apply'));
    expect(acks[0]).toMatchObject({ status: 'failed', error: 'unsupported command ota_apply' });
    expect(await d.handle('{"cmdId":"x"}')).toBeNull();
    expect(await d.handle('not json')).toBeNull();
    expect(d.invalid).toBe(2);
  });
});

describe('identify LED', () => {
  it('blinks 3 short + 1 long and ends off', async () => {
    const led = new SimLed();
    const cycles = await blinkIdentify(led, 0, async () => undefined);
    expect(cycles).toBe(1);
    expect(led.transitions).toEqual([true, false, true, false, true, false, true, false, false]);
  });
});
