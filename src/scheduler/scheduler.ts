import { type DriverReading, type MeterDriver, MeterReadError, type ReadFailure } from '../drivers/types.js';
import type { MeterConfig } from '../protocol/types.js';
import { type Clock, sleep, type TimerHandle } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import { nextAlignedTick } from '../util/time.js';

export type ReadResult =
  | { meter: MeterConfig; ok: true; reading: DriverReading; readAtMs: number }
  | { meter: MeterConfig; ok: false; status: ReadFailure; message: string; readAtMs: number };

export interface SchedulerOptions {
  clock: Clock;
  timeZone: string;
  pollIntervalS: number;
  meters: MeterConfig[];
  driverFor: (meter: MeterConfig) => MeterDriver;
  logger: Logger;
  /** Called after each bus chunk with its results (≤ chunkSize) — the agent persists them in one transaction. */
  onResults: (results: ReadResult[]) => void;
  /** Random delay before each bus starts a cycle so buses and gateways do not hit the cloud in lockstep. */
  jitterMaxMs?: number;
  random?: () => number;
  chunkSize?: number;
  /** Consecutive failures before a meter is polled less often. */
  backoffAfter?: number;
  /** Max ticks skipped for a failing meter (it is still tried at least every (maxSkip+1) ticks). */
  maxSkip?: number;
}

/** Serialises work on one bus: RS485 carries one request at a time. */
class BusQueue {
  private chain: Promise<unknown> = Promise.resolve();
  busy = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.chain = p.catch(() => undefined);
    return p;
  }
}

/**
 * Polling plan: reads aligned to the local wall clock (:00/:15/:30/:45 for 900 s) so a reading exists
 * at every billing cut-off (D-031), one cycle per bus in parallel, meters within a bus strictly
 * sequential, per-meter backoff on repeated failures, plus a boot read and `read_now`.
 */
export class Scheduler {
  private timer: TimerHandle | undefined;
  private stopped = true;
  private tickIndex = 0;
  private readonly buses = new Map<string, { queue: BusQueue; meters: MeterConfig[]; cycleRunning: boolean }>();
  private readonly failures = new Map<string, { count: number; skipUntil: number }>();
  readonly tickTimes: number[] = [];
  private cycles = new Set<Promise<void>>();

  constructor(private readonly o: SchedulerOptions) {
    for (const m of o.meters) {
      let b = this.buses.get(m.bus);
      if (!b) {
        b = { queue: new BusQueue(), meters: [], cycleRunning: false };
        this.buses.set(m.bus, b);
      }
      b.meters.push(m);
    }
  }

  start(opts: { bootRead?: boolean } = {}): void {
    this.stopped = false;
    if (opts.bootRead) this.runCycle(false);
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.o.clock.clearTimeout(this.timer);
    await Promise.allSettled([...this.cycles]);
  }

  /** Resolves when every cycle started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.cycles.size) await Promise.allSettled([...this.cycles]);
  }

  nextTickAt(): number {
    return nextAlignedTick(this.o.clock.now(), this.o.pollIntervalS, this.o.timeZone);
  }

  /** `read_now`: reads the given meters (all when omitted) through their bus queues, ignoring backoff. */
  async readNow(meterIds?: string[]): Promise<ReadResult[]> {
    const wanted = meterIds ? new Set(meterIds) : null;
    const jobs: Array<Promise<ReadResult[]>> = [];
    for (const b of this.buses.values()) {
      const meters = b.meters.filter((m) => !wanted || wanted.has(m.meterId));
      if (meters.length) jobs.push(b.queue.run(() => this.readMeters(meters, true)));
    }
    return (await Promise.all(jobs)).flat();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const at = this.nextTickAt();
    this.timer = this.o.clock.setTimeout(() => {
      this.tickTimes.push(this.o.clock.now());
      this.tickIndex++;
      this.runCycle(true);
      this.scheduleNext();
    }, at - this.o.clock.now());
  }

  private runCycle(withJitter: boolean): void {
    for (const [busId, b] of this.buses) {
      if (b.cycleRunning) {
        this.o.logger.warn({ bus: busId }, 'previous poll cycle still running — tick skipped on this bus');
        continue;
      }
      b.cycleRunning = true;
      const p = (async () => {
        try {
          const jitter = withJitter ? Math.floor((this.o.random ?? Math.random)() * (this.o.jitterMaxMs ?? 0)) : 0;
          if (jitter > 0) await sleep(this.o.clock, jitter);
          if (this.stopped) return;
          const due = b.meters.filter((m) => this.due(m.meterId));
          await b.queue.run(() => this.readMeters(due, false));
        } catch (err) {
          this.o.logger.error({ err: (err as Error).message, bus: busId }, 'poll cycle failed');
        } finally {
          b.cycleRunning = false;
        }
      })();
      this.cycles.add(p);
      void p.finally(() => this.cycles.delete(p));
    }
  }

  private due(meterId: string): boolean {
    const f = this.failures.get(meterId);
    return !f || this.tickIndex >= f.skipUntil;
  }

  private async readMeters(meters: MeterConfig[], manual: boolean): Promise<ReadResult[]> {
    const all: ReadResult[] = [];
    let chunk: ReadResult[] = [];
    const flush = () => {
      if (chunk.length) this.o.onResults(chunk);
      chunk = [];
    };
    for (const m of meters) {
      if (this.stopped && !manual) break;
      const readAtMs = this.o.clock.now();
      let r: ReadResult;
      try {
        const reading = await this.o.driverFor(m).read(m);
        r = { meter: m, ok: true, reading, readAtMs };
        this.failures.delete(m.meterId);
      } catch (err) {
        const status: ReadFailure = err instanceof MeterReadError ? err.status : 'timeout';
        r = { meter: m, ok: false, status, message: (err as Error).message, readAtMs };
        this.noteFailure(m.meterId);
      }
      all.push(r);
      chunk.push(r);
      if (chunk.length >= (this.o.chunkSize ?? 50)) flush();
    }
    flush();
    return all;
  }

  private noteFailure(meterId: string): void {
    const f = this.failures.get(meterId) ?? { count: 0, skipUntil: 0 };
    f.count++;
    const after = this.o.backoffAfter ?? 3;
    if (f.count >= after) {
      const skip = Math.min(2 ** (f.count - after), this.o.maxSkip ?? 3);
      f.skipUntil = this.tickIndex + 1 + skip;
    }
    this.failures.set(meterId, f);
  }
}
