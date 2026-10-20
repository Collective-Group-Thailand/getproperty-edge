import { EventEmitter } from 'node:events';

import type { DeviceTokenCache } from '../identity/token.js';
import { buildTelemetryBatch } from '../protocol/envelopes.js';
import type { Reading } from '../protocol/types.js';
import { isValid } from '../protocol/validate.js';
import type { Outbox } from '../queue/outbox.js';
import type { ReadingQueue } from '../queue/reading-queue.js';
import { Backoff } from '../util/backoff.js';
import { type Clock, systemClock, type TimerHandle } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import { isoWithOffset } from '../util/time.js';
import type { DeviceApi } from './https/device-api.js';
import type { Link } from './link.js';

/** `POST /v1/device/readings/batch` answer (protocol §6, CR-009). */
export interface ReadingsBatchResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ meterId: string; seq: number; reason: string }>;
}

export interface ForwarderOptions {
  gatewayId: string;
  queue: ReadingQueue;
  outbox: Outbox;
  link: Link;
  logger: Logger;
  timeZone: string;
  clock?: Clock;
  batchSize?: number;
  /** Telemetry batches awaiting PUBACK at once (MQTT preserves order on one connection). */
  maxInflight?: number;
  /** HTTPS batch fallback (`POST /v1/device/readings/batch`) after this long without a broker; 0 = off. */
  httpsFallbackAfterMs?: number;
  api?: DeviceApi;
  tokens?: DeviceTokenCache;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/**
 * Drains the on-disk outbox and reading queue to the broker. Readings are deleted only on PUBACK
 * (or HTTPS 2xx in fallback); anything unacknowledged when the link drops is re-sent in order after
 * reconnect — the cloud dedups on (gatewayId, seqEpoch, meterId, seq). Every envelope is schema-validated before it leaves.
 */
export class Forwarder extends EventEmitter {
  private readonly clock: Clock;
  private inflight = 0;
  private draining = false;
  private kicked = false;
  private stopped = true;
  private offlineSince: number;
  private retryTimer: TimerHandle | undefined;
  private fallbackTimer: TimerHandle | undefined;
  private readonly backoff: Backoff;
  private fallbackActive = false;
  private generation = 0;
  rejectedReadings = 0;

  constructor(private readonly o: ForwarderOptions) {
    super();
    this.clock = o.clock ?? systemClock;
    this.offlineSince = this.clock.now();
    this.backoff = new Backoff(o.retryBaseMs ?? 1000, o.retryMaxMs ?? 60_000);
  }

  start(): void {
    this.stopped = false;
    this.o.link.on('connect', this.onConnect);
    this.o.link.on('close', this.onClose);
    if (this.o.link.connected) this.onConnect();
    else this.scheduleFallbackCheck();
  }

  stop(): void {
    this.stopped = true;
    this.o.link.off('connect', this.onConnect);
    this.o.link.off('close', this.onClose);
    this.clock.clearTimeout(this.retryTimer);
    this.clock.clearTimeout(this.fallbackTimer);
  }

  get usingHttpsFallback(): boolean {
    return this.fallbackActive;
  }

  /** New readings or events were persisted: try to send them. */
  kick(): void {
    if (this.stopped) return;
    this.kicked = true;
    if (!this.draining) void this.drain();
  }

  private readonly onConnect = (): void => {
    this.generation++;
    this.fallbackActive = false;
    this.clock.clearTimeout(this.fallbackTimer);
    this.inflight = 0;
    this.o.queue.rewind();
    this.o.outbox.rewind();
    this.backoff.reset();
    this.kick();
  };

  private readonly onClose = (): void => {
    this.generation++;
    this.offlineSince = this.clock.now();
    this.inflight = 0;
    this.o.queue.rewind();
    this.o.outbox.rewind();
    this.scheduleFallbackCheck();
  };

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.kicked && !this.stopped) {
        this.kicked = false;
        if (this.o.link.connected) this.pumpMqtt();
        else if (this.fallbackDue()) await this.pumpHttps();
      }
    } finally {
      this.draining = false;
    }
  }

  private pumpMqtt(): void {
    const gen = this.generation;
    const max = this.o.maxInflight ?? 4;
    for (const item of this.o.outbox.take(Math.max(0, 50 - this.inflight))) {
      this.inflight++;
      this.o.link.publish(item.suffix, item.payload).then(
        () => {
          this.o.outbox.ack(item.id);
          this.settled(gen);
        },
        (err: Error) => this.failed(gen, err),
      );
    }
    while (this.inflight < max) {
      const batch = this.nextValidBatch();
      if (!batch) break;
      this.inflight++;
      const payload = JSON.stringify(
        buildTelemetryBatch(
          this.o.gatewayId,
          batch.configVersion,
          isoWithOffset(this.clock.now(), this.o.timeZone),
          batch.readings,
          this.o.queue.seqEpoch,
        ),
      );
      this.o.link.publish('telemetry', payload).then(
        () => {
          this.o.queue.ack(batch.ids);
          this.emit('acked', batch.readings.length);
          this.settled(gen);
        },
        (err: Error) => this.failed(gen, err),
      );
    }
  }

  private settled(gen: number): void {
    if (gen !== this.generation) return;
    this.inflight--;
    this.backoff.reset();
    this.kick();
  }

  private failed(gen: number, err: Error): void {
    if (gen !== this.generation) return; // the link dropped; onClose already rewound
    this.inflight = 0;
    this.generation++;
    this.o.queue.rewind();
    this.o.outbox.rewind();
    const delay = this.backoff.next();
    this.o.logger.warn({ err: err.message, delay }, 'publish rejected; retrying');
    this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = this.clock.setTimeout(() => this.kick(), delay);
  }

  /**
   * Next batch whose envelope passes the contract schema. Rows that cannot form a valid envelope (disk
   * corruption, a bug) are removed from the queue and counted instead of ever being published.
   */
  private nextValidBatch(): { ids: number[]; configVersion: number; readings: Reading[] } | null {
    for (;;) {
      const batch = this.o.queue.nextBatch(this.o.batchSize ?? 200);
      if (!batch) return null;
      const probe = {
        gatewayId: this.o.gatewayId,
        configVersion: batch.configVersion,
        sentAt: isoWithOffset(this.clock.now(), this.o.timeZone),
        readings: batch.readings,
      };
      if (isValid('TelemetryBatch', probe)) return batch;
      const good: number[] = [];
      const bad: number[] = [];
      batch.readings.forEach((r, i) => {
        (isValid('TelemetryBatch', { ...probe, readings: [r] }) ? good : bad).push(batch.ids[i]!);
      });
      this.o.queue.ack(bad);
      this.rejectedReadings += bad.length;
      this.o.logger.error({ count: bad.length }, 'schema-invalid readings dropped before publish');
      this.o.queue.rewind();
      if (good.length === 0) continue;
      return this.o.queue.nextBatch(this.o.batchSize ?? 200);
    }
  }

  private fallbackDue(): boolean {
    const after = this.o.httpsFallbackAfterMs ?? 0;
    return after > 0 && !!this.o.api && this.clock.now() - this.offlineSince >= after;
  }

  private scheduleFallbackCheck(): void {
    const after = this.o.httpsFallbackAfterMs ?? 0;
    if (!after || !this.o.api || this.stopped) return;
    this.clock.clearTimeout(this.fallbackTimer);
    // First attempt when the fallback becomes due, then a retry every min(30 s, after) while offline;
    // new readings also trigger an attempt through kick().
    const dueIn = this.offlineSince + after - this.clock.now();
    const wait = dueIn > 0 ? dueIn : Math.min(30_000, after);
    this.fallbackTimer = this.clock.setTimeout(() => {
      if (this.o.link.connected || this.stopped) return;
      this.kick();
      this.scheduleFallbackCheck();
    }, wait);
  }

  private async pumpHttps(): Promise<void> {
    const api = this.o.api;
    if (!api) return;
    if (!this.fallbackActive) {
      this.fallbackActive = true;
      this.o.logger.warn('broker unreachable — using HTTPS batch fallback');
    }
    for (;;) {
      if (this.o.link.connected || this.stopped) return;
      const batch = this.nextValidBatch();
      if (!batch) return;
      const env = buildTelemetryBatch(
        this.o.gatewayId,
        batch.configVersion,
        isoWithOffset(this.clock.now(), this.o.timeZone),
        batch.readings,
        this.o.queue.seqEpoch,
      );
      try {
        const bearer = this.o.tokens ? await this.o.tokens.get() : undefined;
        const res = await api.json<ReadingsBatchResult | undefined>('POST', '/v1/device/readings/batch', env, {
          mtls: true,
          ...(bearer ? { bearer } : {}),
          idempotencyKey: `${batch.readings[0]!.meterId}:${batch.readings[0]!.seq}:${batch.ids.length}`,
        });
        // Any 2xx is durable (CR-009): accepted + duplicates are stored; `rejected` readings were refused
        // for good (unbound meter, schema) and kept as dead letters by the api — re-sending cannot help.
        this.o.queue.ack(batch.ids);
        this.emit('acked', batch.readings.length);
        if (res?.rejected?.length)
          this.o.logger.warn(
            { rejected: res.rejected.slice(0, 20), count: res.rejected.length },
            'HTTPS fallback: readings refused by the cloud (dead-lettered there)',
          );
      } catch (err) {
        this.o.queue.rewind();
        this.o.logger.warn({ err: (err as Error).message }, 'HTTPS fallback batch failed');
        return;
      }
    }
  }
}
