import { ModbusMaster } from '../drivers/modbus/master.js';
import { ModbusMeterDriver } from '../drivers/modbus/modbus-driver.js';
import { BUILTIN_MAPS, mapForMeter } from '../drivers/modbus/register-map.js';
import type { SerialTransport } from '../drivers/modbus/serial.js';
import { PulseDriver } from '../drivers/pulse/pulse-driver.js';
import type { PulseSource } from '../drivers/pulse/pulse-source.js';
import type { SimulatorDriver } from '../drivers/simulator/simulator-driver.js';
import type { MeterDriver } from '../drivers/types.js';
import type { BusConfig, GatewayConfig, MeterConfig } from '../protocol/types.js';
import type { ReadResult } from '../scheduler/scheduler.js';
import { Scheduler } from '../scheduler/scheduler.js';
import type { Db } from '../storage/db.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import type { DriverCatalogue } from './validate-config.js';

export interface RuntimeDeps {
  db: Db;
  clock: Clock;
  timeZone: string;
  logger: Logger;
  mode: 'hardware' | 'simulator';
  simulator?: SimulatorDriver;
  serialFactory: (bus: BusConfig) => SerialTransport;
  pulseSourceFactory: () => PulseSource;
  modbusTimeoutMs?: number;
  modbusRetries?: number;
  jitterMaxMs?: number;
  uncleanStart: () => boolean;
  onResults: (results: ReadResult[]) => void;
  onPulseOverflow: (meterId: string, hz: number) => void;
}

export function driverCatalogue(): DriverCatalogue {
  return { modbus: new Set(Object.keys(BUILTIN_MAPS)), pulse: new Set(['pulse_counter']) };
}

/** Everything that runs for one applied config: bus masters, drivers, the pulse counter, the scheduler. */
export class Runtime {
  private readonly masters = new Map<string, ModbusMaster>();
  private readonly drivers = new Map<string, MeterDriver>();
  private pulse: PulseDriver | undefined;
  private pulseMeters: MeterConfig[] = [];
  readonly scheduler: Scheduler;
  private opened = false;

  constructor(
    readonly config: GatewayConfig,
    private readonly d: RuntimeDeps,
  ) {
    const buses = new Map(config.buses.map((b) => [b.id, b]));
    const pulseMeters: MeterConfig[] = [];
    for (const m of config.meters) {
      const bus = buses.get(m.bus)!;
      if (d.mode === 'simulator') {
        this.drivers.set(m.meterId, d.simulator!);
        continue;
      }
      if (bus.type === 'modbus_rtu') {
        let master = this.masters.get(bus.id);
        if (!master) {
          master = new ModbusMaster(d.serialFactory(bus), {
            baud: bus.baud ?? 9600,
            timeoutMs: d.modbusTimeoutMs ?? 500,
            retries: d.modbusRetries ?? 2,
            logger: d.logger,
          });
          this.masters.set(bus.id, master);
        }
        this.drivers.set(m.meterId, new ModbusMeterDriver(mapForMeter(m), master));
      } else if (bus.type === 'gpio') {
        pulseMeters.push(m);
      }
    }
    if (pulseMeters.length) {
      this.pulse = new PulseDriver({
        db: d.db,
        source: d.pulseSourceFactory(),
        logger: d.logger,
        clock: d.clock,
        uncleanStart: d.uncleanStart(),
        onOverflow: d.onPulseOverflow,
      });
      for (const m of pulseMeters) this.drivers.set(m.meterId, this.pulse);
      this.pulseMeters = pulseMeters;
    }
    this.scheduler = new Scheduler({
      clock: d.clock,
      timeZone: d.timeZone,
      pollIntervalS: config.pollIntervalS,
      meters: config.meters,
      driverFor: (m) => this.drivers.get(m.meterId)!,
      logger: d.logger,
      onResults: d.onResults,
      jitterMaxMs: d.jitterMaxMs ?? 3000,
    });
  }

  /** Opens the buses and starts pulse counting; throws if a bus cannot be opened. */
  async open(): Promise<void> {
    for (const [id, m] of this.masters) {
      try {
        await m.open();
      } catch (err) {
        throw new Error(`bus ${id}: ${(err as Error).message}`, { cause: err });
      }
    }
    if (this.pulse) await this.pulse.start(this.pulseMeters);
    this.opened = true;
  }

  /**
   * Dry-run: probes the meters that are new or changed against `previous`, within a deadline so a
   * config with hundreds of meters still applies in < 5 s; unanswered probes are warnings, not errors
   * (a meter may be switched off) — they show up as not_found in health.
   */
  async probe(previous: GatewayConfig | null, deadlineMs: number): Promise<{ probed: number; unreachable: string[] }> {
    const before = new Map((previous?.meters ?? []).map((m) => [m.meterId, JSON.stringify(m)]));
    const changed = this.config.meters.filter((m) => before.get(m.meterId) !== JSON.stringify(m));
    const deadline = Date.now() + deadlineMs;
    const unreachable: string[] = [];
    let probed = 0;
    const byBus = new Map<string, MeterConfig[]>();
    for (const m of changed) byBus.set(m.bus, [...(byBus.get(m.bus) ?? []), m]);
    await Promise.all(
      [...byBus.values()].map(async (meters) => {
        for (const m of meters) {
          if (Date.now() > deadline) return;
          probed++;
          try {
            await this.drivers.get(m.meterId)?.probe?.(m);
          } catch {
            unreachable.push(m.meterId);
          }
        }
      }),
    );
    return { probed, unreachable };
  }

  start(bootRead: boolean): void {
    this.scheduler.start({ bootRead });
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
    if (this.pulse) await this.pulse.close();
    if (this.opened) for (const m of this.masters.values()) await m.close().catch(() => undefined);
    this.opened = false;
  }

  pulseDriver(): PulseDriver | undefined {
    return this.pulse;
  }
}
