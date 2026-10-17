import { mkdirSync, writeFileSync } from 'node:fs';
import type { LookupFunction } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SimConfig } from '../../src/drivers/simulator/sim-config.js';
import { VirtualClock } from '../../src/util/clock.js';
import { meterIds, simConfig, Testbed, waitFor } from '../../tools/testbed.js';

/**
 * Soak (master plan §5 / E1.4): 300 simulated meters × 15-min polling × 30 simulated days on an
 * accelerated clock, against the in-process MQTT 5 broker (mTLS) and the reference ingest, with network
 * chaos — a 2-day outage, broker restarts (also during drains), a 6-hour DNS failure and a day of lost
 * PUBACKs. Proves: zero lost readings, zero duplicates accepted, no buffer eviction, bounded memory/CPU.
 */
const METERS = 300;
const DAYS = 30;
const TICK = 15 * 60_000;
const TICKS_PER_DAY = 96;
const T0 = Date.parse('2026-11-01T00:00:30+07:00');

type Chaos = { at: number; what: string; run: () => Promise<void> | void };

describe('soak: 300 meters × 15 min × 30 days with network chaos', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed({ keepReadings: false }).start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  it('delivers every reading exactly once within the resource budget', async () => {
    const started = Date.now();
    const cpu0 = process.cpuUsage();
    const clock = new VirtualClock(T0);
    const ids = meterIds(METERS, '0192a000-0000-7000-8099');
    let dnsDown = false;
    const lookup: LookupFunction = (_host, options, cb) => {
      if (dnsDown) {
        const err = Object.assign(new Error('getaddrinfo ENOTFOUND broker.soak.test'), { code: 'ENOTFOUND' });
        if ((options as { all?: boolean }).all) (cb as (e: Error, a: unknown[]) => void)(err, []);
        else (cb as (e: Error, a: string, f: number) => void)(err, '', 4);
        return;
      }
      if ((options as { all?: boolean }).all)
        (cb as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
          { address: '127.0.0.1', family: 4 },
        ]);
      else (cb as (e: null, a: string, f: number) => void)(null, '127.0.0.1', 4);
    };
    // a few meters with scripted faults (rollover, swap, intermittent CRC errors)
    const sim: SimConfig = {
      seed: 'soak',
      meters: {
        // a 2-digit-display style register that wraps every 100 kWh (≈ every 8 days at 12 kWh/day)
        [ids[0]!]: { dailyMean: 12, faults: [{ type: 'rollover', at: '100' }] },
        [ids[1]!]: { faults: [{ type: 'crc_error', probability: 0.05 }] },
        [ids[2]!]: { faults: [{ type: 'swap', at: '2026-11-20T10:00:00+07:00', newInitialRegister: '0.000' }] },
      },
    };
    const { agent, gatewayId } = tb.agent({
      clock,
      simConfig: sim,
      env: { mqttUrlOverride: `mqtts://broker.soak.test:${tb.broker.port}`, mqttServername: 'localhost' },
      mqtt: { backoffBaseMs: 20, backoffMaxMs: 200, connectTimeoutMs: 2000, lookup },
      forwarder: { maxInflight: 4, retryBaseMs: 20, retryMaxMs: 200 },
    });
    tb.pushConfig(gatewayId, { ...simConfig(ids, 1), heartbeatS: 3600 });
    await agent.start();
    await waitFor(() => tb.ingest.meters() === METERS, 30_000);

    let peakRss = process.memoryUsage().rss;
    let peakDepth = 0;
    const day = (d: number, h = 0) => d * TICKS_PER_DAY + h * 4;
    const chaos: Chaos[] = [
      { at: day(5, 10), what: 'broker restart', run: () => tb.broker.restart() },
      { at: day(10), what: 'outage start (2 days)', run: () => tb.broker.kill() },
      { at: day(12), what: 'outage end', run: () => tb.broker.start().then(() => undefined) },
      { at: day(12) + 2, what: 'broker restart during drain', run: () => tb.broker.restart() },
      {
        at: day(15),
        what: 'DNS failure (6 h)',
        run: async () => {
          dnsDown = true;
          await tb.broker.restart();
        },
      },
      { at: day(15, 6), what: 'DNS restored', run: () => void (dnsDown = false) },
      {
        at: day(20),
        what: 'lost PUBACKs (1 day)',
        run: () => {
          tb.broker.dropPubackTopic = /\/telemetry$/;
          tb.broker.dropPubackProbability = 0.1;
        },
      },
      { at: day(21), what: 'PUBACKs normal', run: () => void (tb.broker.dropPubackProbability = 0) },
      { at: day(25, 8), what: 'broker restart', run: () => tb.broker.restart() },
      { at: day(25, 9), what: 'broker restart', run: () => tb.broker.restart() },
      { at: day(25, 10), what: 'broker restart', run: () => tb.broker.restart() },
    ];
    const log: string[] = [];
    for (let tick = 1; tick <= DAYS * TICKS_PER_DAY; tick++) {
      for (const c of chaos.filter((x) => x.at === tick)) {
        await c.run();
        log.push(`day ${(tick / TICKS_PER_DAY).toFixed(2)} ${c.what}: queue ${agent.queue.metrics().depth}`);
      }
      await clock.advance(TICK);
      await agent.config.active()!.scheduler.idle();
      const depth = agent.queue.metrics().depth;
      peakDepth = Math.max(peakDepth, depth);
      if (tick % 48 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
      // while the link is up, let the forwarder keep pace (as it would in 15 real minutes)
      if (agent.link!.connected && depth > 2000)
        await waitFor(() => agent.queue.metrics().depth < 600 || !agent.link!.connected, 60_000, 5);
    }
    tb.broker.dropPubackProbability = 0;
    dnsDown = false;
    await waitFor(() => agent.link!.connected, 30_000);
    await waitFor(() => agent.queue.metrics().depth === 0, 120_000, 20);
    const appended = agent.queue.metrics().appendedTotal;
    await waitFor(() => tb.ingest.accepted >= appended, 30_000);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const wallMs = Date.now() - started;
    const q = agent.queue.metrics();
    const report = {
      simulatedDays: DAYS,
      meters: METERS,
      readingsAppended: appended,
      accepted: tb.ingest.accepted,
      duplicatesDeduped: tb.ingest.duplicates,
      outOfOrderRedeliveries: tb.ingest.outOfOrder,
      batches: tb.ingest.batches,
      peakQueueDepth: peakDepth,
      evicted: q.evictedTotal,
      brokerConnects: tb.broker.stats.connects,
      droppedPubacks: tb.broker.stats.droppedPubacks,
      qualities: Object.fromEntries(tb.ingest.qualities),
      peakRssMb: Math.round(peakRss / 1024 / 1024),
      cpuMs: Math.round(cpuMs),
      cpuMsPerPollCycle: Math.round((cpuMs / (DAYS * TICKS_PER_DAY)) * 10) / 10,
      wallS: Math.round(wallMs / 1000),
    };
    console.log(`soak chaos:\n  ${log.join('\n  ')}\nsoak report ${JSON.stringify(report, null, 2)}`);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/soak-report.json', JSON.stringify({ chaos: log, ...report }, null, 2) + '\n');

    // zero lost, zero duplicates accepted
    expect(tb.ingest.accepted).toBe(appended);
    expect(tb.ingest.gaps()).toEqual([]);
    expect(tb.ingest.meters()).toBe(METERS);
    expect(tb.ingest.invalid).toBe(0);
    expect(tb.ingest.identityMismatch).toBe(0);
    // every poll produced a reading except the scripted CRC errors (≈5 % of one meter)
    const expected = METERS * (DAYS * TICKS_PER_DAY + 1);
    expect(appended).toBeGreaterThan(expected - 400);
    expect(appended).toBeLessThanOrEqual(expected);
    // the 2-day outage (57,600 readings) fits the buffer: nothing evicted
    expect(q.evictedTotal).toBe(0);
    expect(peakDepth).toBeGreaterThanOrEqual(2 * TICKS_PER_DAY * METERS - METERS); // ± one tick at the edges
    // chaos really happened
    expect(tb.ingest.duplicates).toBeGreaterThan(0);
    expect(tb.ingest.qualities.get('overflow_corrected')).toBeGreaterThan(0);
    expect(tb.ingest.events.some((e) => e.type === 'tamper' && e.meterId === ids[2])).toBe(true);
    // resource budgets (master plan §5). This process also hosts the broker, the TLS server side, the
    // reference ingest and the test runner, so its RSS is only bounded loosely here (no leak over 30
    // days); the agent process alone is measured against 200 MB in budget.test.ts. CPU per 15-min cycle (everything included) × 10 for a
    // Cortex-A53 must stay far below 10 % of 900 s.
    expect(report.peakRssMb).toBeLessThan(640);
    expect((report.cpuMsPerPollCycle * 10) / 900_000).toBeLessThan(0.1);
    expect(wallMs).toBeLessThan(5 * 60_000);
    await agent.stop();
  });
});
