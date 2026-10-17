import { buildHealth } from '../protocol/envelopes.js';
import type { Health } from '../protocol/types.js';
import type { Link } from '../transport/link.js';
import { type Clock, type TimerHandle } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import type { SystemMetrics } from './system-metrics.js';

export interface HealthSources {
  gatewayId: string;
  agentVersion: string;
  configVersion: () => number;
  bufferedReadings: () => number;
  meters: () => Health['meters'];
  uptimeS: () => number;
}

/** 60-s heartbeat (D-034) with the protocol fields; not queued — only the latest state matters. */
export class HealthReporter {
  private timer: TimerHandle | undefined;
  private intervalMs: number;
  lastPublishedAt: number | null = null;
  private readonly firstAckWaiters: Array<() => void> = [];

  constructor(
    private readonly src: HealthSources,
    private readonly metrics: SystemMetrics,
    private readonly link: Link,
    private readonly clock: Clock,
    private readonly logger: Logger,
    heartbeatS = 60,
  ) {
    this.intervalMs = heartbeatS * 1000;
  }

  setInterval(heartbeatS: number): void {
    this.intervalMs = heartbeatS * 1000;
  }

  async snapshot(): Promise<Health> {
    const sys = await this.metrics.snapshot();
    return buildHealth({
      gatewayId: this.src.gatewayId,
      agentVersion: this.src.agentVersion,
      configVersion: this.src.configVersion(),
      uptimeS: Math.floor(this.src.uptimeS()),
      bufferedReadings: this.src.bufferedReadings(),
      diskFreeMb: sys.diskFreeMb,
      cpuPct: sys.cpuPct,
      memPct: sys.memPct,
      link: sys.link,
      rssi: sys.rssi,
      meters: this.src.meters(),
    });
  }

  start(): void {
    this.link.on('connect', this.onConnect);
    if (this.link.connected) void this.publish();
    this.schedule();
  }

  stop(): void {
    this.link.off('connect', this.onConnect);
    this.clock.clearTimeout(this.timer);
  }

  /** Resolves after the first heartbeat PUBACK (the OTA health gate waits on it). */
  firstAck(): Promise<void> {
    if (this.lastPublishedAt !== null) return Promise.resolve();
    return new Promise((r) => this.firstAckWaiters.push(r));
  }

  private readonly onConnect = (): void => {
    void this.publish();
  };

  async publish(): Promise<boolean> {
    if (!this.link.connected) return false;
    try {
      const h = await this.snapshot();
      await this.link.publish('health', JSON.stringify(h));
      this.lastPublishedAt = this.clock.now();
      for (const w of this.firstAckWaiters.splice(0)) w();
      return true;
    } catch (err) {
      this.logger.debug({ err: (err as Error).message }, 'health publish failed');
      return false;
    }
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      void this.publish();
      this.schedule();
    }, this.intervalMs);
  }
}
