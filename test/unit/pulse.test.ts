import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { PulseDriver } from '../../src/drivers/pulse/pulse-driver.js';
import {
  gpiomonArgs,
  GpiomonPulseSource,
  parseGpiodVersion,
  parseGpiomonLine,
  SimulatedPulseSource,
} from '../../src/drivers/pulse/pulse-source.js';
import type { MeterConfig } from '../../src/protocol/types.js';
import { type Db, openDb } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/util/clock.js';
import { formatMilli } from '../../src/util/decimal.js';
import { silentLogger } from '../../src/util/logger.js';

const M = '0192a000-0000-7000-8000-0000000000w1';
const water = (over: Partial<MeterConfig> = {}): MeterConfig => ({
  meterId: M.replace('w1', 'a1'),
  roomCode: 'A-201W',
  driver: 'pulse_counter',
  bus: 'gpio',
  pin: 17,
  unit: 'm3',
  litresPerPulse: 10,
  initialRegister: '1532.040',
  ...over,
});

function driver(db: Db, unclean = false, extra: Partial<ConstructorParameters<typeof PulseDriver>[0]> = {}) {
  const source = new SimulatedPulseSource();
  const clock = new VirtualClock(Date.parse('2026-11-01T00:00:00+07:00'));
  const overflow: Array<[string, number]> = [];
  const d = new PulseDriver({
    db,
    source,
    logger: silentLogger(),
    clock,
    uncleanStart: unclean,
    flushEveryPulses: 10,
    flushIntervalMs: 30_000,
    debounceMs: 30,
    onOverflow: (m, hz) => overflow.push([m, hz]),
    ...extra,
  });
  return { d, source, clock, overflow };
}

describe('PulseDriver', () => {
  it('register = initialRegister + pulses × litresPerPulse (m³ with 3 decimals)', async () => {
    const { d, source } = driver(openDb(':memory:'));
    await d.start([water()]);
    for (let i = 0; i < 25; i++) source.emit(17, i * 1000);
    const r = await d.read(water());
    expect(formatMilli(r.registerMilli)).toBe('1532.290');
    expect(r.estimated).toBeUndefined();
  });

  it('debounces contact bounce in software', async () => {
    const { d, source } = driver(openDb(':memory:'));
    await d.start([water()]);
    // one real pulse with 4 bounces within 10 ms, then a second pulse 1 s later
    for (const t of [0, 2, 4, 7, 9, 1000, 1003]) source.emit(17, t);
    expect(formatMilli((await d.read(water())).registerMilli)).toBe('1532.060');
    expect(d.edgesDebounced).toBe(5);
  });

  it('power cut: pulses since the last flush are lost, the first reading after restart is estimated_by_gateway', async () => {
    const db = openDb(':memory:');
    const a = driver(db);
    await a.d.start([water()]);
    for (let i = 0; i < 27; i++) a.source.emit(17, i * 1000); // flushed at 10 and 20 → 7 pending
    // power cut: no close(), no flush
    const b = driver(db, true);
    await b.d.start([water()]);
    const first = await b.d.read(water());
    expect(formatMilli(first.registerMilli)).toBe('1532.240'); // 20 pulses persisted
    expect(first.estimated).toBe(true);
    b.source.emit(17, 100_000);
    const second = await b.d.read(water());
    expect(second.estimated).toBeUndefined();
    expect(formatMilli(second.registerMilli)).toBe('1532.250');
  });

  it('flushes on a timer and on clean shutdown (no estimate after a clean restart)', async () => {
    const db = openDb(':memory:');
    const a = driver(db);
    await a.d.start([water()]);
    for (let i = 0; i < 3; i++) a.source.emit(17, i * 1000);
    await a.clock.advance(30_000); // timer flush
    expect((db.prepare('SELECT pulses FROM pulse_state').get() as { pulses: number }).pulses).toBe(3);
    a.source.emit(17, 50_000);
    await a.d.close(); // shutdown flush
    expect((db.prepare('SELECT pulses FROM pulse_state').get() as { pulses: number }).pulses).toBe(4);
    const b = driver(db, false);
    await b.d.start([water()]);
    const r = await b.d.read(water());
    expect(formatMilli(r.registerMilli)).toBe('1532.080');
    expect(r.estimated).toBeUndefined();
  });

  it('re-baselines on a new staff reading (initialRegister) and on a pulse-weight change', async () => {
    const db = openDb(':memory:');
    const a = driver(db);
    await a.d.start([water()]);
    for (let i = 0; i < 10; i++) a.source.emit(17, i * 1000);
    await a.d.close();
    const b = driver(db);
    await b.d.start([water({ litresPerPulse: 1 })]);
    expect(formatMilli((await b.d.read(water({ litresPerPulse: 1 }))).registerMilli)).toBe('1532.140');
    b.source.emit(17, 1);
    expect(formatMilli((await b.d.read(water({ litresPerPulse: 1 }))).registerMilli)).toBe('1532.141');
    await b.d.close();
    const c = driver(db);
    await c.d.start([water({ initialRegister: '20.000', litresPerPulse: 1 })]);
    expect(formatMilli((await c.d.read(water())).registerMilli)).toBe('20.000');
  });

  it('raises pulse_overflow when the rate is implausible (bouncing reed, tamper)', async () => {
    const { d, source, overflow } = driver(openDb(':memory:'), false, { maxHz: 2, debounceMs: 5 });
    await d.start([water()]);
    for (let i = 0; i < 40; i++) source.emit(17, i * 100); // 10 Hz
    expect(overflow).toHaveLength(1);
    expect(overflow[0]![1]).toBeGreaterThan(2);
  });

  it('counts up to 16 channels independently', async () => {
    const { d, source } = driver(openDb(':memory:'));
    const meters = Array.from({ length: 16 }, (_, i) =>
      water({ meterId: `0192a000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`, pin: i + 2 }),
    );
    await d.start(meters);
    meters.forEach((m, i) => {
      for (let k = 0; k <= i; k++) source.emit(m.pin!, k * 1000);
    });
    for (const [i, m] of meters.entries())
      expect((await d.read(m)).registerMilli - 1_532_040n).toBe(BigInt((i + 1) * 10));
  });
});

describe('gpiomon (libgpiod CLI) source', () => {
  it('builds v1 and v2 argument lists and detects the version', () => {
    expect(gpiomonArgs(1, 'gpiochip0', [17, 27])).toEqual([
      '--falling-edge',
      '--format=%o %s %n',
      'gpiochip0',
      '17',
      '27',
    ]);
    expect(gpiomonArgs(2, 'gpiochip0', [17])).toEqual(
      expect.arrayContaining(['--chip', 'gpiochip0', '--edges', 'falling', '--format', '%o %S', '17']),
    );
    expect(parseGpiodVersion('gpiomon (libgpiod) v1.6.3')).toBe(1);
    expect(parseGpiodVersion('gpiomon (libgpiod) v2.1.3')).toBe(2);
  });

  it('parses event lines of both versions', () => {
    expect(parseGpiomonLine('17 1712345678 123456789')).toEqual({ pin: 17, tsMs: 1712345678123.4568 });
    expect(parseGpiomonLine('27 1712345678.500000000')).toEqual({ pin: 27, tsMs: 1712345678500 });
    expect(parseGpiomonLine('garbage')).toBeNull();
  });

  it('streams edges from the child process and restarts it if it exits', async () => {
    const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }> = [];
    const spawn = (_cmd: string, _args: string[]) => {
      const c = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => undefined,
      });
      children.push(c);
      return c as never;
    };
    const src = new GpiomonPulseSource('gpiochip0', silentLogger(), spawn, async () => 'gpiomon (libgpiod) v2.1');
    const edges: Array<[number, number]> = [];
    await src.start([17], (pin, ts) => edges.push([pin, ts]));
    children[0]!.stdout.write('17 100.000000000\n17 100.500000000\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(edges).toEqual([
      [17, 100_000],
      [17, 100_500],
    ]);
    children[0]!.emit('exit', 1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(children).toHaveLength(2);
    await src.stop();
  });
});
