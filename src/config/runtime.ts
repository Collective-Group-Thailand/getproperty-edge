import type { SimulatorDriver } from '../drivers/simulator/simulator-driver.js';
import type { MeterDriver } from '../drivers/types.js';
import type { GatewayConfig } from '../protocol/types.js';
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
  modbusTimeoutMs?: number;
  modbusRetries?: number;
  jitterMaxMs?: number;
  uncleanStart: () => boolean;
  onResults: (results: ReadResult[]) => void;
  onPulseOverflow: (meterId: string, hz: number) => void;
}

export function driverCatalogue(): DriverCatalogue {
  return { modbus: new Set(['eastron_sdm120', 'eastron_sdm230']), pulse: new Set(['pulse_counter']) };
}

/** Everything that runs for one applied config: bus masters, drivers, the pulse counter, the scheduler. */
export class Runtime {
  private readonly drivers = new Map<string, MeterDriver>();
  readonly scheduler: Scheduler;

  constructor(
    readonly config: GatewayConfig,
    d: RuntimeDeps,
  ) {
    for (const m of config.meters) {
      if (d.mode !== 'simulator' || !d.simulator)
        throw new Error(
          'hardware drivers (Modbus RTU, pulse) are not available in this build — use GP_DRIVER_MODE=simulator',
        );
      this.drivers.set(m.meterId, d.simulator);
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

  async open(): Promise<void> {}

  async probe(previous: GatewayConfig | null, deadlineMs: number): Promise<{ probed: number; unreachable: string[] }> {
    const before = new Map((previous?.meters ?? []).map((m) => [m.meterId, JSON.stringify(m)]));
    const changed = this.config.meters.filter((m) => before.get(m.meterId) !== JSON.stringify(m));
    const deadline = Date.now() + deadlineMs;
    const unreachable: string[] = [];
    let probed = 0;
    for (const m of changed) {
      if (Date.now() > deadline) break;
      probed++;
      try {
        await this.drivers.get(m.meterId)?.probe?.(m);
      } catch {
        unreachable.push(m.meterId);
      }
    }
    return { probed, unreachable };
  }

  start(bootRead: boolean): void {
    this.scheduler.start({ bootRead });
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
  }
}
