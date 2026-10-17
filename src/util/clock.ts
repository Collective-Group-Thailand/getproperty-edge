/** Time source used by the scheduler, queue metrics and commands so tests can run an accelerated clock. */
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
}

let realIds = 0;
const realTimers = new Map<number, NodeJS.Timeout>();

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const id = ++realIds;
    const t = setTimeout(
      () => {
        realTimers.delete(id);
        fn();
      },
      Math.max(0, ms),
    );
    t.unref?.();
    realTimers.set(id, t);
    return { id };
  },
  clearTimeout(handle) {
    if (!handle) return;
    const t = realTimers.get(handle.id);
    if (t) clearTimeout(t);
    realTimers.delete(handle.id);
  },
};

interface VirtualTimer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

/**
 * Deterministic clock for tests and the soak run: timers fire only when `advance`/`runUntil` moves time.
 * Between timers the event loop is yielded so promise chains started by a timer can settle.
 */
export class VirtualClock implements Clock {
  private t: number;
  private nextId = 0;
  private seq = 0;
  private timers: VirtualTimer[] = [];

  constructor(startMs: number) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.nextId;
    this.timers.push({ id, at: this.t + Math.max(0, ms), seq: ++this.seq, fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle | undefined): void {
    if (!handle) return;
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  /** Moves time forward by `ms`, firing every due timer in order and letting async work settle after each. */
  async advance(ms: number, settle: () => Promise<void> = flushMicrotasks): Promise<void> {
    await this.runUntil(this.t + ms, settle);
  }

  async runUntil(target: number, settle: () => Promise<void> = flushMicrotasks): Promise<void> {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await settle();
    }
    this.t = Math.max(this.t, target);
    await settle();
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}
