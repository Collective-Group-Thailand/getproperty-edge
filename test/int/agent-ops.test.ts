import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SimLed } from '../../src/commands/led.js';
import { SimulatedPulseSource } from '../../src/drivers/pulse/pulse-source.js';
import type { GatewayConfig } from '../../src/protocol/types.js';
import { VirtualClock } from '../../src/util/clock.js';
import { createLogger, LogRing } from '../../src/util/logger.js';
import { meterIds, simConfig, Testbed, waitFor } from '../../tools/testbed.js';

const T0 = Date.parse('2026-11-01T00:10:00+07:00');
const MIN = 60_000;

describe('E1.3 — commands, config, health and pulse meters through the broker', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed().start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  const command = (gw: string, type: string, args: Record<string, unknown> = {}) => {
    const cmdId = randomUUID();
    tb.broker.publish(`gp/v1/${gw}/cmd`, JSON.stringify({ cmdId, type, args, issuedAt: new Date().toISOString() }));
    return cmdId;
  };
  const acksOf = (cmdId: string) => tb.ingest.acks.filter((a) => a.cmdId === cmdId).map((a) => a.status);

  it('read_now, identify, set_log_level and upload_logs are acked accepted → done', async () => {
    const ring = new LogRing();
    const logger = createLogger('info', ring, false);
    const led = new SimLed();
    const ids = meterIds(4, '0192a000-0000-7000-8020');
    const { agent, gatewayId } = tb.agent({ logger, logRing: ring, led });
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    await waitFor(() => ids.every((id) => tb.ingest.maxSeq(id) === 1), 15_000);

    const rn = command(gatewayId, 'read_now', { meterIds: [ids[2]] });
    await waitFor(() => acksOf(rn).includes('done'));
    expect(acksOf(rn)).toEqual(['accepted', 'done']);
    expect(tb.ingest.acks.find((a) => a.cmdId === rn && a.status === 'done')!.result).toEqual({
      read: [ids[2]],
      failed: [],
    });
    await waitFor(() => tb.ingest.maxSeq(ids[2]!) === 2);
    expect(tb.ingest.maxSeq(ids[0]!)).toBe(1);

    const id = command(gatewayId, 'identify', { durationS: 1 });
    await waitFor(() => acksOf(id).includes('done'));
    await waitFor(() => led.transitions.length >= 8, 5000);

    const ll = command(gatewayId, 'set_log_level', { level: 'debug' });
    await waitFor(() => acksOf(ll).includes('done'));
    expect(logger.level).toBe('debug');

    const ul = command(gatewayId, 'upload_logs', { sinceHours: 1 });
    await waitFor(() => acksOf(ul).includes('done'), 10_000);
    const body = [...tb.api.uploads.values()].at(-1)!;
    const text = gunzipSync(body).toString();
    expect(text).toContain('getproperty-edge log bundle');
    expect(text).toContain('config applied');
    expect(text).not.toMatch(/PRIVATE KEY|provisioningCode":"[A-Z]/);

    const bad = command(gatewayId, 'set_log_level', { level: 'loud' });
    await waitFor(() => acksOf(bad).includes('failed'));
    await agent.stop();
  });

  it('config: rejected config keeps the old one; health reports the applied version', async () => {
    const ids = meterIds(3, '0192a000-0000-7000-8021');
    const { agent, gatewayId } = tb.agent({ heartbeatS: 1 });
    tb.pushConfig(gatewayId, simConfig(ids, 4));
    await agent.start();
    await waitFor(() =>
      tb.ingest.events.some((e) => e.type === 'config_applied' && e.gatewayId === gatewayId && e.configVersion === '4'),
    );
    const bad: GatewayConfig = { ...simConfig(ids, 5), pollIntervalS: 5 };
    tb.pushConfig(gatewayId, bad);
    await waitFor(() =>
      tb.ingest.events.some(
        (e) => e.type === 'config_rejected' && e.gatewayId === gatewayId && e.configVersion === '5',
      ),
    );
    expect(agent.config.version()).toBe(4);
    // heartbeatS from the test (1 s) — the first beat after the apply carries version 4
    await waitFor(() =>
      tb.ingest.health.some(
        (h) =>
          (h as { gatewayId: string; configVersion: number }).gatewayId === gatewayId &&
          (h as { configVersion: number }).configVersion === 4,
      ),
    );
    const h = tb.ingest.health.filter((x) => (x as { gatewayId: string }).gatewayId === gatewayId).at(-1) as {
      configVersion: number;
      meters: unknown[];
      agentVersion: string;
    };
    expect(h.configVersion).toBe(4);
    expect(h.meters).toHaveLength(3);
    expect(h.agentVersion).toBe('0.1.0');
    await agent.stop();
  });

  it('pulse meter power cut: persisted register survives, first reading after restart is estimated_by_gateway', async () => {
    const clock = new VirtualClock(T0);
    const source = new SimulatedPulseSource();
    const waterId = '0192a000-0000-7000-8022-000000000001';
    const cfg: GatewayConfig = {
      version: 1,
      pollIntervalS: 900,
      heartbeatS: 60,
      buses: [{ id: 'gpio', type: 'gpio' }],
      meters: [
        {
          meterId: waterId,
          roomCode: 'A-201W',
          driver: 'pulse_counter',
          bus: 'gpio',
          pin: 17,
          unit: 'm3',
          litresPerPulse: 10,
          initialRegister: '1532.040',
        },
      ],
    };
    const { agent, gatewayId } = tb.agent({ clock, env: { driverMode: 'hardware' }, pulseSourceFactory: () => source });
    tb.pushConfig(gatewayId, cfg);
    await agent.start();
    await waitFor(() => tb.ingest.maxSeq(waterId) === 1, 15_000);
    for (let i = 0; i < 35; i++) source.emit(17, i * 2000); // 35 pulses: 30 persisted (every 10), 5 pending
    await clock.advance(5 * MIN);
    await waitFor(() => tb.ingest.maxSeq(waterId) === 2);
    for (let i = 0; i < 7; i++) source.emit(17, 100_000 + i * 2000); // 7 more, never flushed
    // power cut: drop everything without a clean stop
    const env = agent['d'].env;
    await agent.link!.stop();
    agent.forwarder!.stop();
    await agent.config.active()!.scheduler.stop();
    agent.db.close();

    const { Agent } = await import('../../src/agent.js');
    const { silentLogger } = await import('../../src/util/logger.js');
    const source2 = new SimulatedPulseSource();
    const again = new Agent({
      env,
      logger: silentLogger(),
      clock,
      jitterMaxMs: 0,
      statusPage: false,
      pulseSourceFactory: () => source2,
      mqtt: { backoffBaseMs: 50, backoffMaxMs: 300 },
    });
    expect(again.wasUncleanStart).toBe(true);
    await again.start();
    await waitFor(() => tb.ingest.maxSeq(waterId) === 3, 15_000);
    const rs = tb.ingest.keep!.filter((r) => r.meterId === waterId);
    expect(rs.map((r) => [r.seq, r.register, r.quality])).toEqual([
      [1, '1532.040', 'good'],
      [2, '1532.390', 'good'],
      [3, '1532.390', 'estimated_by_gateway'], // the 7 unflushed pulses after seq 2 were lost — flagged
    ]);
    await waitFor(() => tb.ingest.events.some((e) => e.type === 'power_loss' && e.gatewayId === gatewayId));
    await again.stop();
  });
});
