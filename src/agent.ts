import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { LookupFunction } from 'node:net';
import { join } from 'node:path';

import { CommandDispatcher, type CommandHandler } from './commands/dispatcher.js';
import { blinkIdentify, type Led, SimLed, SysfsLed } from './commands/led.js';
import { LogUploader } from './commands/log-upload.js';
import { ConfigManager } from './config/config-manager.js';
import type { Runtime } from './config/runtime.js';
import { LinuxTtyTransport, type SerialTransport } from './drivers/modbus/serial.js';
import { GpiomonPulseSource, type PulseSource } from './drivers/pulse/pulse-source.js';
import { parseSimConfig, type SimConfig } from './drivers/simulator/sim-config.js';
import { SimulatorDriver } from './drivers/simulator/simulator-driver.js';
import type { AgentEnv } from './env.js';
import { HealthReporter } from './health/health-reporter.js';
import { MeterStatusTracker } from './health/meter-status.js';
import { type HostProbe, realHost, SystemMetrics } from './health/system-metrics.js';
import { ensureIdentity, ProvisioningCodeSource } from './identity/bootstrap.js';
import type { Identity } from './identity/identity-store.js';
import { IdentityStore } from './identity/identity-store.js';
import { CertificateRenewer } from './identity/renewal.js';
import { DeviceTokenCache } from './identity/token.js';
import { NodeOtaFs, type OtaFs } from './ota/ota-fs.js';
import { AbSlots } from './ota/slots.js';
import { bakedOtaKeys } from './ota/trusted-keys.js';
import { OtaUpdater } from './ota/updater.js';
import { buildEvent } from './protocol/envelopes.js';
import type { BusConfig, CommandAck, DeviceEventSeverity, DeviceEventType, TopicSuffix } from './protocol/types.js';
import { Outbox } from './queue/outbox.js';
import { type NewReading, ReadingQueue } from './queue/reading-queue.js';
import { alwaysSynced, type ClockSync } from './scheduler/clock-sync.js';
import { processRegister } from './scheduler/register-math.js';
import type { ReadResult } from './scheduler/scheduler.js';
import type { StatusView } from './status-page/render.js';
import { bindsBeyondLoopback, StatusPageServer } from './status-page/server.js';
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
  host?: HostProbe;
  clockSync?: ClockSync;
  serialFactory?: (bus: BusConfig) => SerialTransport;
  pulseSourceFactory?: () => PulseSource;
  led?: Led;
  /** Overrides the broker link (tests). */
  linkFactory?: (identity: Identity) => Link & { start(): void; stop(): Promise<void>; restart?(): void };
  /** Extra or replacement command handlers (tests). */
  extraHandlers?: Partial<Record<string, CommandHandler>>;
  /** Called when a command asks for a process restart (systemd restarts the service). */
  requestExit?: (code: number) => void;
  simConfig?: SimConfig;
  /** Poll jitter per bus (ms); 0 in tests. */
  jitterMaxMs?: number;
  heartbeatS?: number;
  /** OTA: trusted manifest keys (default: baked into the build), filesystem, gate. */
  ota?: { trustedKeys?: Record<string, string>; fs?: OtaFs; gateMs?: number; arch?: string; currentVersion?: string };
  forwarder?: { maxInflight?: number; retryBaseMs?: number; retryMaxMs?: number };
  mqtt?: {
    keepaliveS?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    connectTimeoutMs?: number;
    lookup?: LookupFunction;
  };
  statusPage?: boolean;
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
  readonly led: Led;
  identity: Identity | undefined;
  link: (Link & { start(): void; stop(): Promise<void>; restart?(): void }) | undefined;
  forwarder: Forwarder | undefined;
  health: HealthReporter | undefined;
  commands: CommandDispatcher | undefined;
  statusPage: StatusPageServer | undefined;
  statusPort: number | undefined;
  ota: OtaUpdater | undefined;
  private renewer: CertificateRenewer | undefined;
  private configPullTimer: NodeJS.Timeout | undefined;
  private readonly metrics: SystemMetrics;
  private readonly startedAt: number;
  private provisioningState: StatusView['provisioning'] = 'waiting_for_code';
  private provisioningDetail: string | undefined;
  private readonly uncleanStart: boolean;
  private readonly lastRegister = new Map<string, string>();
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
    this.metrics = new SystemMetrics(d.host ?? realHost, env.stateDir);
    this.led = d.led ?? (env.ledName ? new SysfsLed(env.ledName) : new SimLed());
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
        serialFactory:
          d.serialFactory ??
          ((bus) =>
            new LinuxTtyTransport({ device: bus.device!, baud: bus.baud ?? 9600, parity: bus.parity ?? 'none' })),
        pulseSourceFactory: d.pulseSourceFactory ?? (() => new GpiomonPulseSource(env.gpioChip, d.logger)),
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
          this.health?.setInterval(rt.config.heartbeatS);
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

  /**
   * The status page's local admin token (review #12): GP_STATUS_TOKEN, else — when the page listens beyond this host —
   * a random token kept in `<stateDir>/status-token` (0600, readable on the gateway only; the path is logged, never the
   * token). Loopback-only pages need none.
   */
  private statusToken(env: AgentEnv): string | undefined {
    if (env.statusToken) return env.statusToken;
    if (!bindsBeyondLoopback(env.statusHost)) return undefined;
    const file = join(env.stateDir, 'status-token');
    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing.length >= 16) return existing;
    } catch {
      /* first start */
    }
    const token = randomBytes(24).toString('base64url');
    mkdirSync(env.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    this.d.logger.warn({ file }, 'status page listens on the LAN: local admin token written (show it with sudo cat)');
    return token;
  }

  /** Boots the agent; resolves once the identity exists and the link is started. */
  async start(): Promise<void> {
    const env = this.d.env;
    if (this.d.statusPage !== false) {
      this.statusPage = new StatusPageServer({
        host: env.statusHost,
        port: env.statusPort,
        token: this.statusToken(env),
        view: () => this.statusView(),
        submitCode: (c) => this.codes.submit(c),
        provisioned: () => !!this.identity,
        logger: this.d.logger,
      });
      this.statusPort = await this.statusPage.start();
    }
    this.identity = await ensureIdentity({
      api: this.api,
      store: this.identityStore,
      codes: this.codes,
      agentVersion: AGENT_VERSION,
      serial: env.serialNumber,
      logger: this.d.logger,
      onToken: (t) => this.tokens.seed(t),
      onStatus: (s, detail) => {
        this.provisioningState = s === 'done' ? 'provisioned' : s;
        this.provisioningDetail = detail;
      },
    });
    this.provisioningState = 'provisioned';
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
    this.health = new HealthReporter(
      {
        gatewayId: id.gatewayId,
        agentVersion: AGENT_VERSION,
        configVersion: () => this.config.version(),
        bufferedReadings: () => this.queue.metrics().depth,
        meters: () => this.statuses.snapshot((this.config.current()?.meters ?? []).map((m) => m.meterId)),
        uptimeS: () => (this.clock.now() - this.startedAt) / 1000,
      },
      this.metrics,
      link,
      this.clock,
      this.d.logger,
      this.d.heartbeatS ?? this.config.current()?.heartbeatS ?? 60,
    );
    this.commands = new CommandDispatcher({
      db: this.db,
      clock: this.clock,
      timeZone: env.timeZone,
      logger: this.d.logger,
      sendAck: (ack: CommandAck) => this.pushOutbox('cmd/ack', ack),
      handlers: { ...this.builtinHandlers(), ...this.d.extraHandlers },
    });
    this.ota = new OtaUpdater({
      slots: new AbSlots(this.d.ota?.fs ?? new NodeOtaFs(), env.otaRoot, env.stateDir),
      trustedKeys: this.d.ota?.trustedKeys ?? bakedOtaKeys(),
      currentVersion: this.d.ota?.currentVersion ?? AGENT_VERSION,
      arch: this.d.ota?.arch ?? process.arch,
      fetchManifest: async (url) => {
        // `manifestUrl` is `<api>/v1/device/ota/manifest?releaseId=…` (protocol §6); a relative URL is
        // resolved against the API origin.
        const abs = new URL(url, env.apiBaseUrl);
        const same = abs.origin === new URL(env.apiBaseUrl).origin;
        return this.api.json('GET', abs.href, undefined, {
          mtls: same,
          ...(same ? { bearer: await this.tokens.get() } : {}),
        });
      },
      download: async (url) => this.api.stream(new URL(url), new URL(url).origin === new URL(env.apiBaseUrl).origin),
      clock: this.clock,
      logger: this.d.logger,
      event: (type, severity, message, data) => this.emitEvent(type, severity, { message, data }),
      requestRestart: () => this.requestRestart(1000),
      firstHealthAck: () => this.health!.firstAck(),
      ...(this.d.ota?.gateMs !== undefined ? { gateMs: this.d.ota.gateMs } : {}),
    });
    this.commands.addHandler('ota_apply', async (args) => {
      if (typeof args.manifestUrl !== 'string') throw new Error('args.manifestUrl required');
      return this.ota!.apply(args.manifestUrl);
    });
    link.on('message', (suffix: string, payload: Buffer) => {
      if (suffix === 'config') void this.config.apply(payload);
      else if (suffix === 'cmd') void this.commands?.handle(payload);
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
    if (env.configPullAfterS > 0) this.scheduleConfigPull(env.configPullAfterS * 1000);
    this.forwarder.start();
    this.health.start();
    link.start();
    this.renewer.start();
    void this.ota
      .onBoot()
      .catch((err: unknown) => this.d.logger.error({ err: (err as Error).message }, 'OTA boot check failed'));
  }

  /**
   * Cold start without MQTT (protocol §6): when no config is applied `configPullAfterS` after start (the
   * retained `/config` normally arrives within a second of connecting), fetch the latest compiled config
   * over HTTPS and apply it like an MQTT one; retried every 5 min until a config is active.
   */
  private scheduleConfigPull(delayMs: number): void {
    if (this.stopped || this.config.current()) return;
    this.configPullTimer = setTimeout(() => void this.pullConfig(), delayMs);
    this.configPullTimer.unref();
  }

  private async pullConfig(): Promise<void> {
    if (this.stopped || this.config.current()) return;
    try {
      const cfg = await this.api.json<unknown>('GET', '/v1/device/config', undefined, {
        mtls: true,
        bearer: await this.tokens.get(),
      });
      const outcome = await this.config.apply(cfg);
      this.d.logger.info({ outcome }, 'config fetched over HTTPS (cold start without MQTT)');
    } catch (err) {
      this.d.logger.warn({ err: (err as Error).message }, 'config pull over HTTPS failed');
    }
    this.scheduleConfigPull(5 * 60_000);
  }

  /** Graceful stop, then exit so systemd starts `current` again (restart command, OTA switch/rollback). */
  requestRestart(delayMs: number): void {
    setTimeout(() => {
      void this.stop().finally(() => (this.d.requestExit ?? ((c) => process.exit(c)))(0));
    }, delayMs).unref();
  }

  /** Graceful stop: pollers, pulse flush, link; marks the shutdown clean. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.renewer?.stop();
    clearTimeout(this.configPullTimer);
    this.health?.stop();
    await this.config.stop();
    this.forwarder?.stop();
    await this.link?.stop();
    await this.statusPage?.stop();
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
      this.lastRegister.set(r.meter.meterId, register);
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

  private builtinHandlers(): Partial<Record<string, CommandHandler>> {
    return {
      read_now: async (args) => {
        const rt = this.config.active();
        if (!rt) throw new Error('no config applied');
        const ids = Array.isArray(args.meterIds) ? args.meterIds.map(String) : undefined;
        const res = await rt.scheduler.readNow(ids);
        return {
          read: res.filter((r) => r.ok).map((r) => r.meter.meterId),
          failed: res.filter((r) => !r.ok).map((r) => ({ meterId: r.meter.meterId, status: r.ok ? 'ok' : r.status })),
        };
      },
      restart: async () => {
        this.requestRestart(2000);
        return { restartInS: 2 };
      },
      identify: async (args) => {
        const durationS = Math.min(Math.max(Number(args.durationS ?? 30) || 30, 1), 600);
        void blinkIdentify(this.led, durationS);
        return { durationS };
      },
      set_log_level: async (args) => {
        const level = typeof args.level === 'string' ? args.level : '';
        if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(level))
          throw new Error(`bad level ${level}`);
        const previous = this.d.logger.level;
        this.d.logger.level = level;
        const durationS = Number(args.durationS ?? 0);
        if (durationS > 0)
          this.clock.setTimeout(() => {
            this.d.logger.level = previous;
          }, durationS * 1000);
        return { level, previous, ...(durationS > 0 ? { revertAfterS: durationS } : {}) };
      },
      upload_logs: async (args) => {
        if (!this.d.logRing) throw new Error('log ring not available');
        const hours = Math.min(Math.max(Number(args.sinceHours ?? 24) || 24, 1), 168);
        return new LogUploader(this.api, this.tokens, this.d.logRing).upload(hours);
      },
    };
  }

  async statusView(): Promise<StatusView> {
    const cfg = this.config.current();
    const sys = await this.metrics.snapshot().catch(() => ({ link: 'ethernet', rssi: null }));
    const q = this.queue.metrics();
    return {
      agentVersion: AGENT_VERSION,
      gatewayId: this.identity?.gatewayId ?? null,
      provisioning: this.identity ? 'provisioned' : this.provisioningState,
      ...(this.provisioningDetail ? { provisioningDetail: this.provisioningDetail } : {}),
      configVersion: this.config.version(),
      link: {
        broker: this.link?.connected ? 'connected' : 'disconnected',
        type: sys.link,
        rssi: sys.rssi,
        httpsFallback: this.forwarder?.usingHttpsFallback ?? false,
      },
      queue: { depth: q.depth, oldestReadAt: q.oldestReadAt, evictedTotal: q.evictedTotal },
      uptimeS: Math.floor((this.clock.now() - this.startedAt) / 1000),
      now: isoWithOffset(this.clock.now(), this.d.env.timeZone),
      meters: (cfg?.meters ?? []).map((m) => {
        const s = this.statuses.get(m.meterId);
        return {
          meterId: m.meterId,
          roomCode: m.roomCode,
          driver: m.driver,
          bus: m.bus,
          address: m.address !== undefined ? String(m.address) : m.pin !== undefined ? `pin ${m.pin}` : '—',
          status: s.status,
          lastReadAt: s.lastReadAt,
          lastRegister: this.lastRegister.get(m.meterId) ?? null,
          unit: m.unit,
        };
      }),
    };
  }
}
