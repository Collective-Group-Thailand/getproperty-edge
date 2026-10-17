import type { MeterUnit } from '../../protocol/types.js';
import { hashSeed, seededRandom } from '../../util/random.js';
import { localDayHour, tzOffsetMinutes } from '../../util/time.js';

/** Residential hourly load shape (weights, local time) — night base, morning bump, evening peak. */
const ELECTRIC_SHAPE = [
  3, 2.6, 2.4, 2.3, 2.3, 2.6, 3.4, 4.2, 3.8, 3.0, 2.8, 2.8, 3.0, 3.0, 2.9, 3.0, 3.4, 4.4, 5.6, 6.4, 6.6, 6.0, 5.0, 3.8,
];
const WATER_SHAPE = [
  0.2, 0.1, 0.1, 0.1, 0.3, 1.5, 4.0, 5.0, 3.0, 1.5, 1, 1, 1.5, 1, 0.8, 0.8, 1, 2, 3.5, 4.5, 4, 3, 1.5, 0.6,
];

function normalised(shape: number[]): number[] {
  const sum = shape.reduce((a, b) => a + b, 0);
  return shape.map((v) => v / sum);
}
const E_SHAPE = normalised(ELECTRIC_SHAPE);
const W_SHAPE = normalised(WATER_SHAPE);
const cumulativeShape = (s: number[]) => s.reduce<number[]>((acc, v) => [...acc, (acc.at(-1) ?? 0) + v], [0]);
const E_CUM = cumulativeShape(E_SHAPE);
const W_CUM = cumulativeShape(W_SHAPE);

export interface ProfileParams {
  meterId: string;
  unit: MeterUnit;
  occupied: boolean;
  dailyMean: number;
  /** Milli-units at `epochMs`. */
  initialMilli: bigint;
  epochMs: number;
  timeZone: string;
  seed: string;
}

/**
 * Deterministic cumulative register for a simulated meter: Σ daily totals (weekday/weekend, occupancy,
 * per-day noise seeded by meter+day) + the current day's share along the hourly shape.
 * Same inputs → same register at the same instant, on every machine (tests and `sim:gateway`).
 */
export class ConsumptionProfile {
  private readonly epochDay: number;
  private readonly prefix: number[] = [0]; // prefix[k] = consumption (units) of days epochDay..epochDay+k-1
  private readonly shape: number[];
  private readonly cum: number[];

  constructor(readonly p: ProfileParams) {
    this.epochDay = localDayHour(p.epochMs, p.timeZone).dayIndex;
    this.shape = p.unit === 'kwh' ? E_SHAPE : W_SHAPE;
    this.cum = p.unit === 'kwh' ? E_CUM : W_CUM;
  }

  dailyTotal(dayIndex: number): number {
    const weekday = new Date(dayIndex * 86_400_000).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const rnd = seededRandom(hashSeed(`${this.p.seed}:${this.p.meterId}:${dayIndex}`))();
    if (!this.p.occupied) return this.p.unit === 'kwh' ? 0.15 + 0.1 * rnd : 0; // standby only
    const factor = (weekend ? 1.2 : 1) * (0.75 + 0.5 * rnd);
    return this.p.dailyMean * factor;
  }

  /** Cumulative consumption in units since the epoch at instant `ms`. */
  consumedAt(ms: number): number {
    const local = ms + tzOffsetMinutes(ms, this.p.timeZone) * 60_000;
    const dayIndex = Math.floor(local / 86_400_000);
    const k = dayIndex - this.epochDay;
    if (k < 0) return 0;
    while (this.prefix.length <= k) {
      const d = this.epochDay + this.prefix.length - 1;
      this.prefix.push(this.prefix[this.prefix.length - 1]! + this.dailyTotal(d));
    }
    const secOfDay = (local - dayIndex * 86_400_000) / 1000;
    const hour = Math.floor(secOfDay / 3600);
    const frac = (secOfDay - hour * 3600) / 3600;
    const dayShare = this.cum[hour]! + this.shape[hour]! * frac;
    return this.prefix[k]! + this.dailyTotal(dayIndex) * dayShare;
  }

  /** Instant power (W) or flow (L/min) implied by the profile — for `extra`. */
  instantRate(ms: number): number {
    const { dayIndex, hour } = localDayHour(ms, this.p.timeZone);
    const perHour = this.dailyTotal(dayIndex) * this.shape[hour]!;
    return this.p.unit === 'kwh' ? perHour * 1000 : (perHour * 1000) / 60;
  }

  registerMilliAt(ms: number): bigint {
    return this.p.initialMilli + BigInt(Math.floor(this.consumedAt(ms) * 1000));
  }
}
