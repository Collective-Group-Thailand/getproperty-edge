import { describe, expect, it } from 'vitest';

import { type DriverReading, type MeterDriver, MeterReadError } from '../../src/drivers/types.js';
import type { MeterConfig } from '../../src/protocol/types.js';
import { processRegister } from '../../src/scheduler/register-math.js';
import { type ReadResult, Scheduler } from '../../src/scheduler/scheduler.js';
import { VirtualClock } from '../../src/util/clock.js';
import { formatMilli } from '../../src/util/decimal.js';
import { silentLogger } from '../../src/util/logger.js';
import { isoWithOffset } from '../../src/util/time.js';

const TZ = 'Asia/Bangkok';
const T0 = Date.parse('2026-11-01T00:07:12+07:00');
const iso = (ms: number) => isoWithOffset(ms, TZ);

const meter = (n: number, bus = 'rs485-1'): MeterConfig => ({
  meterId: `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  roomCode: `A-${n}`,
  driver: 'eastron_sdm120',
  bus,
  address: n,
  unit: 'kwh',
});

/** Fake bus driver: each read takes `ms` of *real* time and records overlap per bus. */
class FakeDriver implements MeterDriver {
  readonly name = 'fake';
  inFlight = new Map<string, number>();
  maxConcurrentPerBus = new Map<string, number>();
  readonly order: string[] = [];
  failing = new Set<string>();
  constructor(private readonly ms = 2) {}
  async read(m: MeterConfig): Promise<DriverReading> {
    const n = (this.inFlight.get(m.bus) ?? 0) + 1;
    this.inFlight.set(m.bus, n);
    this.maxConcurrentPerBus.set(m.bus, Math.max(n, this.maxConcurrentPerBus.get(m.bus) ?? 0));
    this.order.push(m.meterId);
    await new Promise((r) => setTimeout(r, this.ms));
    this.inFlight.set(m.bus, n - 1);
    if (this.failing.has(m.meterId)) throw new MeterReadError('timeout', 'no answer');
    return { registerMilli: 1000n, unit: 'kwh' };
  }
}

function setup(meters: MeterConfig[], opts: { pollIntervalS?: number; driver?: FakeDriver } = {}) {
  const clock = new VirtualClock(T0);
  const driver = opts.driver ?? new FakeDriver();
  const results: ReadResult[] = [];
  const s = new Scheduler({
    clock,
    timeZone: TZ,
    pollIntervalS: opts.pollIntervalS ?? 900,
    meters,
    driverFor: () => driver,
    logger: silentLogger(),
    onResults: (r) => results.push(...r),
    jitterMaxMs: 0,
  });
  return { clock, driver, results, s };
}

/** Advance in small steps so real-time reads inside a cycle complete. */
async function advanceTo(clock: VirtualClock, s: Scheduler, target: number) {
  while (clock.now() < target) {
    await clock.advance(Math.min(60_000, target - clock.now()));
    await s.idle();
  }
}

describe('Scheduler', () => {
  it('aligns reads to :00/:15/:30/:45 local wall clock', async () => {
    const { clock, s, results } = setup([meter(1)]);
    s.start();
    await advanceTo(clock, s, Date.parse('2026-11-01T01:05:00+07:00'));
    expect(s.tickTimes.map(iso)).toEqual([
      '2026-11-01T00:15:00+07:00',
      '2026-11-01T00:30:00+07:00',
      '2026-11-01T00:45:00+07:00',
      '2026-11-01T01:00:00+07:00',
    ]);
    expect(results.map((r) => iso(r.readAtMs))).toEqual(s.tickTimes.map(iso));
    await s.stop();
  });

  it('honours other intervals (hourly) and does a boot read', async () => {
    const { clock, s, results } = setup([meter(1)], { pollIntervalS: 3600 });
    s.start({ bootRead: true });
    await s.idle();
    await advanceTo(clock, s, Date.parse('2026-11-01T02:30:00+07:00'));
    expect(results.map((r) => iso(r.readAtMs))).toEqual([
      iso(T0),
      '2026-11-01T01:00:00+07:00',
      '2026-11-01T02:00:00+07:00',
    ]);
    await s.stop();
  });

  it('keeps one request in flight per bus; buses run in parallel', async () => {
    const meters = [1, 2, 3, 4, 5].map((n) => meter(n)).concat([6, 7, 8].map((n) => meter(n, 'rs485-2')));
    const { clock, s, driver } = setup(meters);
    s.start();
    await advanceTo(clock, s, Date.parse('2026-11-01T00:16:00+07:00'));
    expect(driver.maxConcurrentPerBus.get('rs485-1')).toBe(1);
    expect(driver.maxConcurrentPerBus.get('rs485-2')).toBe(1);
    // the order within a bus is the config order
    expect(driver.order.filter((id) => meters.slice(0, 5).some((m) => m.meterId === id))).toEqual(
      meters.slice(0, 5).map((m) => m.meterId),
    );
    await s.stop();
  });

  it('backs off a failing meter but still tries it at least every 4 ticks', async () => {
    const m1 = meter(1);
    const m2 = meter(2);
    const driver = new FakeDriver();
    driver.failing.add(m1.meterId);
    const { clock, s, results } = setup([m1, m2], { driver });
    s.start();
    await advanceTo(clock, s, T0 + 12 * 900_000 + 60_000);
    const attempts = results.filter((r) => r.meter.meterId === m1.meterId);
    const healthy = results.filter((r) => r.meter.meterId === m2.meterId);
    expect(healthy).toHaveLength(12);
    expect(attempts.length).toBeLessThan(12);
    expect(attempts.length).toBeGreaterThanOrEqual(5);
    expect(attempts.every((a) => !a.ok && a.status === 'timeout')).toBe(true);
    // once it answers again, it is polled every tick
    driver.failing.clear();
    await advanceTo(clock, s, clock.now() + 8 * 900_000);
    const after = results.filter((r) => r.meter.meterId === m1.meterId && r.ok);
    expect(after.length).toBeGreaterThanOrEqual(5);
    await s.stop();
  });

  it('read_now reads selected meters through the bus queue, ignoring backoff', async () => {
    const meters = [meter(1), meter(2), meter(3)];
    const { s, results } = setup(meters);
    const r = await s.readNow([meters[1]!.meterId]);
    expect(r.map((x) => x.meter.meterId)).toEqual([meters[1]!.meterId]);
    expect(results).toHaveLength(1);
    expect(await s.readNow()).toHaveLength(3);
  });

  it('skips a tick on a bus whose previous cycle is still running', async () => {
    const slow = new FakeDriver(50);
    const meters = [1, 2, 3].map((n) => meter(n));
    const { clock, s } = setup(meters, { driver: slow, pollIntervalS: 60 });
    s.start();
    await clock.advance(60_000 - (T0 % 60_000) + 1); // first tick starts (150 ms real)
    await clock.advance(60_000); // next tick while the first still runs
    await s.idle();
    expect(slow.order).toHaveLength(3);
    await s.stop();
  });
});

describe('register maths', () => {
  const base = { lastRawMilli: null, rolloverOffsetMilli: 0n, lastRegisterMilli: null };
  it('passes a normal increasing register as good', () => {
    const p = processRegister({ registerMilli: 5000n, unit: 'kwh' }, base, { clockSuspect: false });
    expect(p).toMatchObject({ registerMilli: 5000n, quality: 'good' });
    expect(p.decrease).toBeUndefined();
  });
  it('detects a rollover, keeps the offset and flags overflow_corrected once', () => {
    const wrap = 100_000_000n; // 100000.000
    const a = processRegister({ registerMilli: 99_999_500n, unit: 'kwh', rolloverAtMilli: wrap }, base, {
      clockSuspect: false,
    });
    const st = {
      lastRawMilli: a.rawMilli,
      rolloverOffsetMilli: a.rolloverOffsetMilli,
      lastRegisterMilli: a.registerMilli,
    };
    const b = processRegister({ registerMilli: 1_200n, unit: 'kwh', rolloverAtMilli: wrap }, st, {
      clockSuspect: false,
    });
    expect(b.quality).toBe('overflow_corrected');
    expect(formatMilli(b.registerMilli)).toBe('100001.200');
    const st2 = {
      lastRawMilli: b.rawMilli,
      rolloverOffsetMilli: b.rolloverOffsetMilli,
      lastRegisterMilli: b.registerMilli,
    };
    const c = processRegister({ registerMilli: 2_000n, unit: 'kwh', rolloverAtMilli: wrap }, st2, {
      clockSuspect: false,
    });
    expect(c.quality).toBe('good');
    expect(formatMilli(c.registerMilli)).toBe('100002.000');
  });
  it('sends a decrease unchanged and flags it (never dropped)', () => {
    const p = processRegister(
      { registerMilli: 4000n, unit: 'kwh' },
      { lastRawMilli: 5000n, rolloverOffsetMilli: 0n, lastRegisterMilli: 5000n },
      { clockSuspect: false },
    );
    expect(p.registerMilli).toBe(4000n);
    expect(p.decrease).toEqual({ previousMilli: 5000n, currentMilli: 4000n });
  });
  it('a small drop on a meter with rollover is a decrease, not a wrap', () => {
    const p = processRegister(
      { registerMilli: 4000n, unit: 'kwh', rolloverAtMilli: 100_000_000n },
      { lastRawMilli: 5000n, rolloverOffsetMilli: 0n, lastRegisterMilli: 5000n },
      { clockSuspect: false },
    );
    expect(p.quality).toBe('good');
    expect(p.decrease).toBeDefined();
  });
  it('quality precedence: estimated > overflow > clock_suspect > good', () => {
    expect(
      processRegister({ registerMilli: 1n, unit: 'm3', estimated: true }, base, { clockSuspect: true }).quality,
    ).toBe('estimated_by_gateway');
    expect(processRegister({ registerMilli: 1n, unit: 'kwh' }, base, { clockSuspect: true }).quality).toBe(
      'clock_suspect',
    );
  });
});
