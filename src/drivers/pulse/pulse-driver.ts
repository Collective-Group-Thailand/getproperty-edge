import type { StatementSync } from 'node:sqlite';

import type { MeterConfig } from '../../protocol/types.js';
import type { Db } from '../../storage/db.js';
import { type Clock, systemClock, type TimerHandle } from '../../util/clock.js';
import { formatMilli, parseMilli } from '../../util/decimal.js';
import type { Logger } from '../../util/logger.js';
import { type DriverReading, type MeterDriver, MeterReadError } from '../types.js';
import type { PulseSource } from './pulse-source.js';

export interface PulseDriverOptions {
  db: Db;
  source: PulseSource;
  logger: Logger;
  clock?: Clock;
  /** Persist after this many new pulses on a meter (protocol §4: every pulse batch). */
  flushEveryPulses?: number;
  /** …or after this long with unpersisted pulses. */
  flushIntervalMs?: number;
  /** Software debounce: edges closer than this to the last accepted edge on the pin are ignored. */
  debounceMs?: number;
  /** Above this pulse rate (sustained over 10 s) a `pulse_overflow` event is raised. */
  maxHz?: number;
  /** The previous run did not shut down cleanly: first reading per meter is `estimated_by_gateway`. */
  uncleanStart: boolean;
  onOverflow?: (meterId: string, hz: number) => void;
}

interface Channel {
  meter: MeterConfig;
  pin: number;
  configInitial: string;
  baselineMilli: bigint;
  litresPerPulse: number;
  persisted: number;
  pending: number;
  lastEdgeMs: number;
  window: number[];
  lastOverflowAt: number;
  estimatedPending: boolean;
}

/**
 * Water meters with a pulse output (reed / open collector): the gateway holds the register
 * `initialRegister + pulses × litresPerPulse` (1 L = 0.001 m³ = 1 milli-m³) and persists the pulse
 * count every N pulses / T seconds, before every reading and on shutdown (protocol §4, D-033).
 */
export class PulseDriver implements MeterDriver {
  readonly name = 'pulse_counter';
  private readonly clock: Clock;
  private readonly byPin = new Map<number, Channel>();
  private readonly byMeter = new Map<string, Channel>();
  private flushTimer: TimerHandle | undefined;
  private readonly stmt: { get: StatementSync; put: StatementSync };
  edgesSeen = 0;
  edgesDebounced = 0;

  constructor(private readonly o: PulseDriverOptions) {
    this.clock = o.clock ?? systemClock;
    this.stmt = {
      get: o.db.prepare('SELECT * FROM pulse_state WHERE meter_id = ?'),
      put: o.db.prepare(
        `INSERT INTO pulse_state (meter_id, config_initial, initial_register, litres_per_pulse, pulses, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(meter_id) DO UPDATE SET config_initial = excluded.config_initial,
           initial_register = excluded.initial_register, litres_per_pulse = excluded.litres_per_pulse,
           pulses = excluded.pulses, updated_at_ms = excluded.updated_at_ms`,
      ),
    };
  }

  /** Binds the pulse meters of a config and starts edge counting on their pins. */
  async start(meters: MeterConfig[]): Promise<void> {
    for (const m of meters) {
      if (m.pin === undefined || m.litresPerPulse === undefined || m.initialRegister === undefined)
        throw new Error(`pulse meter ${m.meterId} needs pin, litresPerPulse and initialRegister`);
      const row = this.stmt.get.get(m.meterId) as
        { config_initial: string; initial_register: string; litres_per_pulse: number; pulses: number } | undefined;
      let baseline = parseMilli(m.initialRegister);
      let pulses = 0;
      if (row && row.config_initial === m.initialRegister) {
        if (row.litres_per_pulse === m.litresPerPulse) {
          baseline = parseMilli(row.initial_register);
          pulses = row.pulses;
        } else {
          // Pulse weight changed without a new staff reading: re-baseline at the current register.
          baseline = parseMilli(row.initial_register) + BigInt(row.pulses) * BigInt(row.litres_per_pulse);
        }
      }
      const ch: Channel = {
        meter: m,
        pin: m.pin,
        configInitial: m.initialRegister,
        baselineMilli: baseline,
        litresPerPulse: m.litresPerPulse,
        persisted: pulses,
        pending: 0,
        lastEdgeMs: -Infinity,
        window: [],
        lastOverflowAt: -Infinity,
        estimatedPending: this.o.uncleanStart && !!row,
      };
      this.persist(ch);
      this.byPin.set(ch.pin, ch);
      this.byMeter.set(m.meterId, ch);
    }
    await this.o.source.start([...this.byPin.keys()], (pin, ts) => this.onEdge(pin, ts));
    this.scheduleFlush();
  }

  async close(): Promise<void> {
    this.clock.clearTimeout(this.flushTimer);
    await this.o.source.stop();
    this.flushAll();
  }

  registerMilli(meterId: string): bigint | undefined {
    const ch = this.byMeter.get(meterId);
    return ch ? ch.baselineMilli + BigInt(ch.persisted + ch.pending) * BigInt(ch.litresPerPulse) : undefined;
  }

  async read(meter: MeterConfig): Promise<DriverReading> {
    const ch = this.byMeter.get(meter.meterId);
    if (!ch) throw new MeterReadError('not_found', `pulse meter ${meter.meterId} not bound`);
    this.flush(ch);
    const out: DriverReading = {
      registerMilli: ch.baselineMilli + BigInt(ch.persisted) * BigInt(ch.litresPerPulse),
      unit: meter.unit,
    };
    if (ch.estimatedPending) {
      out.estimated = true;
      ch.estimatedPending = false;
    }
    return out;
  }

  async probe(meter: MeterConfig): Promise<void> {
    if (meter.pin === undefined) throw new MeterReadError('not_found', 'no pin');
  }

  flushAll(): void {
    for (const ch of this.byMeter.values()) this.flush(ch);
  }

  private onEdge(pin: number, tsMs: number): void {
    const ch = this.byPin.get(pin);
    if (!ch) return;
    this.edgesSeen++;
    if (tsMs - ch.lastEdgeMs < (this.o.debounceMs ?? 30)) {
      this.edgesDebounced++;
      return;
    }
    ch.lastEdgeMs = tsMs;
    ch.pending++;
    this.checkRate(ch, tsMs);
    if (ch.pending >= (this.o.flushEveryPulses ?? 10)) this.flush(ch);
  }

  private checkRate(ch: Channel, tsMs: number): void {
    const maxHz = this.o.maxHz ?? 5;
    ch.window.push(tsMs);
    while (ch.window.length && ch.window[0]! < tsMs - 10_000) ch.window.shift();
    const hz = ch.window.length / 10;
    if (hz > maxHz && tsMs - ch.lastOverflowAt > 300_000) {
      ch.lastOverflowAt = tsMs;
      this.o.logger.warn({ meterId: ch.meter.meterId, hz }, 'pulse rate above plausibility limit');
      this.o.onOverflow?.(ch.meter.meterId, hz);
    }
  }

  private flush(ch: Channel): void {
    if (ch.pending === 0) return;
    ch.persisted += ch.pending;
    ch.pending = 0;
    this.persist(ch);
  }

  private persist(ch: Channel): void {
    this.stmt.put.run(
      ch.meter.meterId,
      ch.configInitial,
      formatMilli(ch.baselineMilli),
      ch.litresPerPulse,
      ch.persisted,
      this.clock.now(),
    );
  }

  private scheduleFlush(): void {
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushAll();
      this.scheduleFlush();
    }, this.o.flushIntervalMs ?? 30_000);
  }
}
