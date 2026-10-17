import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigManager } from './config/config-manager.js';
import type { Runtime } from './config/runtime.js';
import { parseSimConfig, type SimConfig } from './drivers/simulator/sim-config.js';
import { SimulatorDriver } from './drivers/simulator/simulator-driver.js';
import type { AgentEnv } from './env.js';
import { MeterStatusTracker } from './health/meter-status.js';
import { ensureIdentity, ProvisioningCodeSource } from './identity/bootstrap.js';
import type { Identity } from './identity/identity-store.js';
import { IdentityStore } from './identity/identity-store.js';
import { CertificateRenewer } from './identity/renewal.js';
import { DeviceTokenCache } from './identity/token.js';
import { buildEvent } from './protocol/envelopes.js';
import type { DeviceEventSeverity, DeviceEventType, TopicSuffix } from './protocol/types.js';
import { Outbox } from './queue/outbox.js';
import { type NewReading, ReadingQueue } from './queue/reading-queue.js';
import { alwaysSynced, type ClockSync } from './scheduler/clock-sync.js';
import { processRegister } from './scheduler/register-math.js';
import type { ReadResult } from './scheduler/scheduler.js';
import { type Db, KvStore, openDb } from './storage/db.js';
import { Forwarder } from './transport/forwarder.js';
import { DeviceApi } from './transport/https/device-api.js';
import type { Link } from './transport/link.js';
import { MqttLink } from './transport/mqtt/mqtt-link.js';
import { type Clock, systemClock } from './util/clock.js';
import { formatMilli } from './util/decimal.js';
import type { Logger, LogRing } from './util/logger.js';
import { isoWithOffset } from './util/time.js';
import { AGENT_VERSION } from './version.js';

export interface AgentDeps {
  env: AgentEnv;
  logger: Logger;
  logRing?: LogRing;
  clock?: Clock;
  clockSync?: ClockSync;
  /** Overrides the broker link (tests). */
  linkFactory?: (identity: Identity) => Link & { start(): void; stop(): Promise<void>; restart?(): void };
  simConfig?: SimConfig;
  /** Poll jitter per bus (ms); 0 in tests. */
  jitterMaxMs?: number;
  forwarder?: { maxInflight?: number; retryBaseMs?: number; retryMaxMs?: number };
  mqtt?: { keepaliveS?: number; backoffBaseMs?: number; backoffMaxMs?: number; connectTimeoutMs?: number };
}

/**
 * The gateway agent: identity → broker link → config → pollers → store-and-forward, plus health,
 * commands and the LAN status page. `main.ts` builds it from the environment; tests build it directly.
 */
export class Agent {
  readonly clock: Clock;
  readonly db: Db;
  readonly kv: KvStore;
  readonly queue: ReadingQueue;
  readonly outbox: Outbox;
  readonly identityStore: IdentityStore;
  readonly codes: ProvisioningCodeSource;
  readonly api: DeviceApi;
  readonly tokens: DeviceTokenCache;
  readonly statuses: MeterStatusTracker;
  readonly config: ConfigManager;
  readonly simulator: SimulatorDriver | undefined;
  identity: Identity | undefined;
  link: (Link & { start(): void; stop(): Promise<void>; restart?(): void }) | undefined;
  forwarder: Forwarder | undefined;
  private renewer: CertificateRenewer | undefined;
  private readonly startedAt: number;
  private readonly uncleanStart: boolean;
  private stopped = false;

  constructor(private readonly d: AgentDeps) {
    const env = d.env;
    this.clock = d.clock ?? systemClock;
    this.startedAt = this.clock.now();
    this.db = openDb(join(env.stateDir, 'agent.db'));
    this.kv = new KvStore(this.db);
    // Clean-shutdown marker: false while running, true after a graceful stop.
    this.uncleanStart = this.kv.get<boolean>('boot.clean') === false;
    this.kv.set('boot.clean', false);
    this.outbox = new Outbox(this.db, 10_000, () => this.clock.now());
    this.queue = new ReadingQueue(this.db, {
      capacity: env.queueCapacity,
      now: () => this.clock.now(),
      onSeqGap: (g) =>
        this.emitEvent('seq_gap', g.reason === 'buffer_hard_limit' ? 'critical' : 'warning', {
          meterId: g.meterId,
          message: `${g.evicted} buffered readings evicted (${g.reason})`,
          data: { fromSeq: g.fromSeq, toSeq: g.toSeq, evicted: g.evicted, reason: g.reason },
        }),
    });
    this.identityStore = new IdentityStore(env.stateDir, d.logger);
    this.codes = new ProvisioningCodeSource(env.provisioningCode);
    this.api = new DeviceApi({
      baseUrl: env.apiBaseUrl,
      ...(env.apiCaFile ? { ca: readFileSync(env.apiCaFile, 'utf8') } : {}),
      credentials: () => this.identityStore.credentials(),
      logger: d.logger,
    });
    this.tokens = new DeviceTokenCache(this.api, this.clock);
    this.statuses = new MeterStatusTracker(3, (meterId, status, failures) =>
      this.emitEvent('meter_offline', 'warning', {
        meterId,
        message: `meter not answering (${status}) after ${failures} attempts`,
        data: { status, failures },
      }),
    );
    if (env.driverMode === 'simulator') {
      const sim = d.simConfig ?? parseSimConfig(env.simConfig, (p) => readFileSync(p, 'utf8'));
      this.simulator = new SimulatorDriver(sim, this.clock, env.timeZone);
    }
    this.config = new ConfigManager(
      this.kv,
      {
        db: this.db,
        clock: this.clock,
        timeZone: env.timeZone,
        logger: d.logger,
        mode: env.driverMode,
        ...(this.simulator ? { simulator: this.simulator } : {}),
        jitterMaxMs: d.jitterMaxMs ?? 3000,
        uncleanStart: () => this.uncleanStart,
        onResults: (r) => this.onResults(r),
        onPulseOverflow: (meterId, hz) =>
          this.emitEvent('pulse_overflow', 'warning', {
            meterId,
            message: `pulse rate ${hz.toFixed(1)} Hz above plausibility limit`,
            data: { hz },
          }),
      },
      {
        applied: (version, info) =>
          this.emitEvent('config_applied', 'info', {
            configVersion: String(version),
            data: { durationMs: info.durationMs, unreachableMeterIds: info.unreachable.slice(0, 50) },
          }),
        rejected: (version, error) =>
          this.emitEvent('config_rejected', 'warning', {
            ...(version !== null ? { configVersion: String(version) } : {}),
            message: error,
          }),
        activated: (rt: Runtime) => {
          this.statuses.reset(rt.config.meters.map((m) => m.meterId));
        },
      },
      d.logger,
    );
  }

  get gatewayId(): string | undefined {
    return this.identity?.gatewayId;
  }

  get wasUncleanStart(): boolean {
    return this.uncleanStart;
  }

  /** Boots the agent; resolves once the identity exists and the link is started. */
  async start(): Promise<void> {
    const env = this.d.env;
    this.identity = await ensureIdentity({
      api: this.api,
      store: this.identityStore,
      codes: this.codes,
      agentVersion: AGENT_VERSION,
      serial: env.serialNumber,
      logger: this.d.logger,
      onToken: (t) => this.tokens.seed(t),
    });
    if (this.stopped) return;
    const id = this.identity;

    this.emitEvent('restart', 'info', {
      message: this.uncleanStart ? 'agent started after an unclean shutdown' : 'agent started',
      data: { agentVersion: AGENT_VERSION, clean: !this.uncleanStart },
    });
    if (this.uncleanStart)
      this.emitEvent('power_loss', 'warning', { message: 'previous run ended without a clean shutdown' });

    const link =
      this.d.linkFactory?.(id) ??
      new MqttLink({
        gatewayId: id.gatewayId,
        url: env.mqttUrlOverride ?? id.mqttUrl,
        ...(id.mqttWsUrl ? { wsUrl: id.mqttWsUrl } : {}),
        credentials: () => this.identityStore.credentials()!,
        logger: this.d.logger,
        clock: systemClock,
        ...(env.mqttServername ? { servername: env.mqttServername } : {}),
        ...this.d.mqtt,
      });
    this.link = link;
    this.forwarder = new Forwarder({
      gatewayId: id.gatewayId,
      queue: this.queue,
      outbox: this.outbox,
      link,
      logger: this.d.logger,
      timeZone: env.timeZone,
      clock: systemClock,
      httpsFallbackAfterMs: env.httpsFallbackAfterS * 1000,
      api: this.api,
      tokens: this.tokens,
      ...this.d.forwarder,
    });
    link.on('message', (suffix: string, payload: Buffer) => {
      if (suffix === 'config') void this.config.apply(payload);
    });
    this.renewer = new CertificateRenewer({
      api: this.api,
      store: this.identityStore,
      tokens: this.tokens,
      clock: this.clock,
      logger: this.d.logger,
      onRenewed: () => link.restart?.(),
    });

    await this.config.boot();
    this.forwarder.start();
    link.start();
    this.renewer.start();
  }

  /** Graceful stop: pollers, pulse flush, link; marks the shutdown clean. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.renewer?.stop();
    await this.config.stop();
    this.forwarder?.stop();
    await this.link?.stop();
    this.kv.set('boot.clean', true);
    this.db.close();
  }

  emitEvent(
    type: DeviceEventType,
    severity: DeviceEventSeverity,
    extra: { meterId?: string; message?: string; data?: Record<string, unknown>; configVersion?: string } = {},
  ): void {
    const gw = this.identity?.gatewayId;
    if (!gw) return;
    const ev = buildEvent(gw, type, severity, isoWithOffset(this.clock.now(), this.d.env.timeZone), extra);
    this.pushOutbox('events', ev);
  }

  private pushOutbox(suffix: TopicSuffix, payload: unknown): void {
    if (this.stopped) return;
    this.outbox.push(suffix, payload);
    this.forwarder?.kick();
  }

  /** Register maths + persist (one transaction per chunk) + health status, then wake the forwarder. */
  onResults(results: ReadResult[]): void {
    if (this.stopped) return;
    const cfgVersion = this.config.version();
    const clockSuspect = (this.d.clockSync ?? alwaysSynced).suspect();
    const pending = new Map<string, ReturnType<ReadingQueue['meterState']>>();
    const rows: NewReading[] = [];
    for (const r of results) {
      const iso = isoWithOffset(r.readAtMs, this.d.env.timeZone);
      if (!r.ok) {
        this.statuses.failed(r.meter.meterId, r.status);
        continue;
      }
      const st = pending.get(r.meter.meterId) ?? this.queue.meterState(r.meter.meterId);
      const p = processRegister(r.reading, st, { clockSuspect });
      pending.set(r.meter.meterId, {
        ...st,
        lastRawMilli: p.rawMilli,
        rolloverOffsetMilli: p.rolloverOffsetMilli,
        lastRegisterMilli: p.registerMilli,
      });
      const register = formatMilli(p.registerMilli);
      rows.push({
        meterId: r.meter.meterId,
        readAtMs: r.readAtMs,
        readAt: iso,
        register,
        unit: r.reading.unit,
        quality: p.quality,
        ...(r.reading.extra ? { extra: r.reading.extra } : {}),
        configVersion: cfgVersion,
        state: { rawMilli: p.rawMilli, rolloverOffsetMilli: p.rolloverOffsetMilli, registerMilli: p.registerMilli },
      });
      this.statuses.ok(r.meter.meterId, r.readAtMs, iso);
      if (p.decrease) {
        this.emitEvent('tamper', 'warning', {
          meterId: r.meter.meterId,
          message: 'register decreased (meter swap, reset or tampering?) — reading sent unchanged',
          data: {
            reason: 'register_decrease',
            previous: formatMilli(p.decrease.previousMilli),
            current: formatMilli(p.decrease.currentMilli),
          },
        });
      }
    }
    this.queue.append(rows);
    this.forwarder?.kick();
  }
}
