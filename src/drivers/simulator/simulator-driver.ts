import type { MeterConfig } from '../../protocol/types.js';
import type { Clock } from '../../util/clock.js';
import { parseMilli } from '../../util/decimal.js';
import { hashSeed, seededRandom } from '../../util/random.js';
import { type DriverReading, type MeterDriver, MeterReadError } from '../types.js';
import { ConsumptionProfile } from './profile.js';
import type { SimConfig, SimFault, SimMeterConfig } from './sim-config.js';

const DEFAULT_EPOCH = '2026-01-01T00:00:00+07:00';

/**
 * Simulator driver: answers for any meter binding with a deterministic profile and scripted faults
 * (timeout, CRC error, stuck register, rollover, meter swap). Used by `pnpm dev`, the tests, the soak
 * run and getproperty-api's `pnpm sim:gateway`.
 */
export class SimulatorDriver implements MeterDriver {
  readonly name = 'simulator';
  private readonly profiles = new Map<string, ConsumptionProfile>();
  private readonly seed: string;
  private readonly epochMs: number;
  /** Reads served per meter (tests assert serialisation/alignment with it). */
  readonly reads = new Map<string, number[]>();

  constructor(
    private readonly cfg: SimConfig,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {
    this.seed = cfg.seed ?? 'getproperty-sim';
    this.epochMs = Date.parse(cfg.epoch ?? DEFAULT_EPOCH);
  }

  private meterCfg(meterId: string): SimMeterConfig {
    return { ...this.cfg.defaults, ...this.cfg.meters?.[meterId] };
  }

  profile(meter: MeterConfig): ConsumptionProfile {
    let p = this.profiles.get(meter.meterId);
    if (!p) {
      const mc = this.meterCfg(meter.meterId);
      const rnd = seededRandom(`${this.seed}:${meter.meterId}`);
      const occupied = mc.occupied ?? rnd() < (this.cfg.occupancyRate ?? 0.85);
      const dailyMean = mc.dailyMean ?? (meter.unit === 'kwh' ? 4 + 8 * rnd() : 0.15 + 0.25 * rnd());
      const initial = mc.initialRegister ?? meter.initialRegister ?? (100 + Math.floor(rnd() * 9000)).toFixed(3);
      p = new ConsumptionProfile({
        meterId: meter.meterId,
        unit: meter.unit,
        occupied,
        dailyMean,
        initialMilli: parseMilli(initial),
        epochMs: this.epochMs,
        timeZone: this.timeZone,
        seed: this.seed,
      });
      this.profiles.set(meter.meterId, p);
    }
    return p;
  }

  async probe(meter: MeterConfig): Promise<void> {
    this.applyFaults(meter, this.clock.now(), true);
  }

  async read(meter: MeterConfig): Promise<DriverReading> {
    const now = this.clock.now();
    const list = this.reads.get(meter.meterId) ?? [];
    list.push(now);
    if (list.length > 1000) list.splice(0, list.length - 1000);
    this.reads.set(meter.meterId, list);
    if (this.cfg.latencyMs) await new Promise((r) => setTimeout(r, this.cfg.latencyMs));
    const value = this.applyFaults(meter, now, false);
    const p = this.profile(meter);
    const rate = p.instantRate(now);
    const extra: Record<string, number> =
      meter.unit === 'kwh'
        ? {
            voltage: Math.round((226 + 6 * Math.sin(now / 3.6e6)) * 10) / 10,
            powerW: Math.round(rate),
            current: Math.round((rate / 228) * 100) / 100,
          }
        : { flowLpm: Math.round(rate * 100) / 100 };
    return { ...value, unit: meter.unit, extra };
  }

  private applyFaults(meter: MeterConfig, now: number, probeOnly: boolean): Omit<DriverReading, 'unit'> {
    const faults = this.meterCfg(meter.meterId).faults ?? [];
    const rnd = seededRandom(hashSeed(`${this.seed}:${meter.meterId}:${now}`));
    for (const f of faults) {
      if ((f.type === 'timeout' || f.type === 'crc_error' || f.type === 'not_found') && inWindow(f, now)) {
        const prob = 'probability' in f && f.probability !== undefined ? f.probability : 1;
        if (rnd() < prob) throw new MeterReadError(f.type, `simulated ${f.type}`);
      }
    }
    if (probeOnly) return { registerMilli: 0n };
    const p = this.profile(meter);
    let at = now;
    const stuck = faults.find((f): f is Extract<SimFault, { type: 'stuck' }> => f.type === 'stuck' && inWindow(f, now));
    if (stuck) at = Date.parse(stuck.from);
    let reg = p.registerMilliAt(at);
    const swap = faults
      .filter((f): f is Extract<SimFault, { type: 'swap' }> => f.type === 'swap' && Date.parse(f.at) <= at)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (swap) reg = parseMilli(swap.newInitialRegister) + (reg - p.registerMilliAt(Date.parse(swap.at)));
    const out: Omit<DriverReading, 'unit'> = { registerMilli: reg };
    const roll = faults.find((f): f is Extract<SimFault, { type: 'rollover' }> => f.type === 'rollover');
    if (roll) {
      const wrap = parseMilli(roll.at);
      out.registerMilli = reg % wrap;
      out.rolloverAtMilli = wrap;
    }
    return out;
  }
}

function inWindow(f: { from?: string; to?: string }, now: number): boolean {
  if (f.from && now < Date.parse(f.from)) return false;
  if (f.to && now >= Date.parse(f.to)) return false;
  return true;
}
