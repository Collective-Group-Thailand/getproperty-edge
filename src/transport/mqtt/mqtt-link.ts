import { EventEmitter } from 'node:events';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import type { MqttAcl } from '../../identity/identity-store.js';
import { lwtPayload, topic } from '../../protocol/envelopes.js';
import { MQTT_ACL, type TopicSuffix } from '../../protocol/types.js';
import { Backoff } from '../../util/backoff.js';
import { type Clock, systemClock, type TimerHandle } from '../../util/clock.js';
import type { Logger } from '../../util/logger.js';
import type { Link } from '../link.js';

export interface MqttCredentials {
  key: string;
  cert: string;
  ca: string;
}

/** A device JWT used as the MQTT password (protocol 1.2). */
export interface MqttPassword {
  accessToken: string;
  expiresAt: string;
}

/** `mtls` = EMQX 8883 with the client certificate; `wss` = the per-gateway WebSocket fallback behind Caddy (D-239). */
export type MqttTransport = 'mtls' | 'wss';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** CONNACK reason codes of a refused login (MQTT 5): bad user name or password, not authorized, bad auth method. */
const AUTH_REFUSED = new Set([0x86, 0x87, 0x8c]);

/**
 * Broker URLs must be TLS (`mqtts://`, `wss://`): the gateway verifies the broker against the bootstrap CA only.
 * Plain `mqtt://` / `ws://` is accepted for a loopback dev broker alone — never a silent downgrade to an
 * unauthenticated path (D-230, D-239).
 */
export function assertSecureBrokerUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('broker URL is not a URL');
  }
  if (u.protocol === 'mqtts:' || u.protocol === 'wss:') return;
  if ((u.protocol === 'mqtt:' || u.protocol === 'ws:') && LOOPBACK.has(u.hostname)) return;
  throw new Error(`refusing non-TLS broker URL ${u.protocol}//${u.host}`);
}

/** Topic suffixes the link may publish / subscribe to: the contract's `x-acl` ∩ the bootstrap ACL (when stored). */
export function effectiveAcl(acl?: MqttAcl): { publish: Set<string>; subscribe: Set<string> } {
  const narrow = (base: readonly string[], granted?: string[]) =>
    new Set(granted ? base.filter((t) => granted.includes(t)) : base);
  return { publish: narrow(MQTT_ACL.publish, acl?.publish), subscribe: narrow(MQTT_ACL.subscribe, acl?.subscribe) };
}

export interface MqttLinkOptions {
  gatewayId: string;
  /** Primary broker URL: EMQX's mutual-TLS listener, e.g. `mqtts://mqtt.getproperty.co:8883` (D-230). */
  url: string;
  /**
   * WebSocket fallback `wss://<MQTT_HOST>/mqtt` (D-239): passed only when the API enabled it for this gateway (bootstrap
   * `mqtt.wsUrl`) **and** `GP_MQTT_WS_FALLBACK=on`. TLS ends at the platform's Caddy, whose certificate must chain to
   * the bootstrap CA (fails closed otherwise); no client certificate on that path — the device JWT alone.
   */
  wsUrl?: string;
  credentials: () => MqttCredentials;
  /**
   * Protocol 1.2: the MQTT password is a device JWT of this gateway, obtained before every (re)connect (`fresh` after a
   * refused CONNECT and for the rotation before expiry). Without a token the link does not connect.
   */
  password: (opts: { fresh: boolean }) => Promise<MqttPassword>;
  /** Bootstrap ACL (protocol 1.2); absent for older identities — the contract's `x-acl` applies. */
  acl?: MqttAcl;
  keepaliveS?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  connectTimeoutMs?: number;
  /** Consecutive transport failures on one URL before trying the other. */
  failoverAfter?: number;
  /** Rotate the password this long before the token expires (capped at a quarter of its lifetime). Default 5 min. */
  rotateLeadMs?: number;
  /** Extra random lead (spreads a fleet's reconnects; capped at a tenth of the lifetime). Default 2 min. */
  rotateJitterMs?: number;
  /** While on the WebSocket fallback, the first rotation after this long tries 8883 once again. Default 1 h. */
  primaryRetryMs?: number;
  servername?: string;
  /** Custom DNS lookup (tests inject DNS failures). */
  lookup?: LookupFunction;
  logger: Logger;
  clock?: Clock;
  random?: () => number;
}

/**
 * MQTT 5 over TLS (protocol §1, revision 1.2): client id = username = `gw-<gatewayId>` (= certificate CN on 8883),
 * password = a device JWT fetched before every (re)connect and rotated (graceful DISCONNECT + reconnect, so no LWT)
 * shortly before it expires; keepalive 30 s, LWT on /health, exponential backoff with jitter, /config (retained) and
 * /cmd re-subscribed on every connect (clean start). Publishes only to the four ACL topics. QoS 1 publishes resolve on
 * PUBACK; on link loss every unacknowledged publish is rejected so the caller re-sends from its on-disk queue (no
 * hidden in-memory redelivery).
 */
export class MqttLink extends EventEmitter implements Link {
  private client: MqttClient | undefined;
  private readonly backoff: Backoff;
  private reconnectTimer: TimerHandle | undefined;
  private rotateTimer: TimerHandle | undefined;
  private stopped = true;
  private gen = 0;
  private failuresOnUrl = 0;
  private useWs = false;
  private wsSince = 0;
  private probingPrimary = false;
  private nextFresh = false;
  private authRefused = false;
  private passwordExp = 0;
  private isConnected = false;
  private lastConnectedAt: number | null = null;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly acl: { publish: Set<string>; subscribe: Set<string> };
  private wsUrl: string | undefined;

  constructor(private readonly opts: MqttLinkOptions) {
    super();
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;
    this.backoff = new Backoff(opts.backoffBaseMs ?? 1000, opts.backoffMaxMs ?? 120_000, opts.random);
    assertSecureBrokerUrl(opts.url);
    if (opts.wsUrl) assertSecureBrokerUrl(opts.wsUrl);
    this.wsUrl = opts.wsUrl;
    this.acl = effectiveAcl(opts.acl);
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get lastConnected(): number | null {
    return this.lastConnectedAt;
  }

  get transport(): MqttTransport {
    return this.useWs && this.wsUrl ? 'wss' : 'mtls';
  }

  get currentUrl(): string {
    return this.transport === 'wss' ? this.wsUrl! : this.opts.url;
  }

  /** Expiry (epoch ms) of the device JWT the current session logged in with; 0 before the first connect. */
  get passwordExpiresAt(): number {
    return this.passwordExp;
  }

  /** The WebSocket fallback URL the link may use right now (undefined = 8883 only). */
  get fallbackUrl(): string | undefined {
    return this.wsUrl;
  }

  /**
   * Applies a WebSocket fallback URL announced after bootstrap (token refresh, CR-015 / api D-249) — the caller passes
   * it only when the API announces it **and** `GP_MQTT_WS_FALLBACK=on`. Takes effect on the next connect: a new URL
   * joins the 8883 → WSS failover; a removed one sends the next connect back to 8883 (a live WSS session ends at the
   * latest with its JWT rotation, and the broker refuses the WebSocket login anyway). A non-TLS URL is refused (throws)
   * and the previous value stays — fail closed. TLS verification stays the bootstrap CA's either way.
   */
  setWsUrl(wsUrl: string | undefined): void {
    if (wsUrl) assertSecureBrokerUrl(wsUrl);
    if (wsUrl === this.wsUrl) return;
    this.wsUrl = wsUrl;
    this.failuresOnUrl = 0;
    if (!wsUrl) {
      this.useWs = false;
      this.probingPrimary = false;
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Re-reads the credentials (after certificate renewal) and reconnects — gracefully, so the broker sends no LWT. */
  restart(): void {
    this.teardown(true);
    this.backoff.reset();
    if (!this.stopped) this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.gen++;
    this.clock.clearTimeout(this.reconnectTimer);
    this.clock.clearTimeout(this.rotateTimer);
    const c = this.client;
    this.client = undefined;
    if (c) {
      this.failInflight(c);
      await new Promise<void>((resolve) => c.end(false, {}, () => resolve()));
    }
    this.setConnected(false);
  }

  publish(suffix: TopicSuffix, payload: string): Promise<void> {
    // protocol 1.2: anything outside the four publish topics disconnects the gateway (EMQX deny_action = disconnect)
    if (!this.acl.publish.has(suffix)) return Promise.reject(new Error(`mqtt: ${suffix} is not in the gateway ACL`));
    const c = this.client;
    if (!c || !this.isConnected) return Promise.reject(new Error('mqtt: not connected'));
    return new Promise((resolve, reject) => {
      c.publish(topic(this.opts.gatewayId, suffix), payload, { qos: 1, retain: false }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Fetches a device JWT, then opens the connection; a missing token means no connect (retried with back-off). */
  private connect(): void {
    const gen = ++this.gen;
    const fresh = this.nextFresh;
    this.nextFresh = false;
    this.opts.password({ fresh }).then(
      (pw) => {
        if (gen === this.gen && !this.stopped) this.open(pw);
      },
      (err: unknown) => {
        if (gen !== this.gen || this.stopped) return;
        this.nextFresh = true;
        this.opts.logger.warn(
          { err: (err as Error).message },
          'mqtt: no device token for the broker login (protocol 1.2) — retrying',
        );
        this.scheduleReconnect();
      },
    );
  }

  private open(pw: MqttPassword): void {
    const gw = this.opts.gatewayId;
    const clientId = `gw-${gw}`;
    const transport = this.transport;
    const url = this.currentUrl;
    const creds = this.opts.credentials();
    this.authRefused = false;
    const options: IClientOptions = {
      protocolVersion: 5,
      clientId,
      username: clientId,
      password: pw.accessToken,
      clean: true,
      keepalive: this.opts.keepaliveS ?? 30,
      reconnectPeriod: 0,
      connectTimeout: this.opts.connectTimeoutMs ?? 15_000,
      resubscribe: false,
      queueQoSZero: false,
      // the bootstrap CA chain is the only trust anchor (no system roots); hostname checked against the SAN
      ca: creds.ca,
      rejectUnauthorized: true,
      will: { topic: topic(gw, 'health'), payload: Buffer.from(lwtPayload()), qos: 1, retain: false },
    };
    if (this.opts.servername) options.servername = this.opts.servername;
    (options as IClientOptions & { minVersion?: string }).minVersion = 'TLSv1.2';
    if (this.opts.lookup) (options as IClientOptions & { lookup?: LookupFunction }).lookup = this.opts.lookup;
    if (transport === 'mtls') {
      options.key = creds.key;
      options.cert = creds.cert;
    } else {
      // D-239: TLS ends at Caddy — its certificate must chain to the bootstrap CA; no client certificate is sent (the
      // device JWT is the only credential on this path). key/cert stay unset so mqtt.js copies none into wsOptions.
      const host = new URL(url).hostname;
      options.wsOptions = {
        ca: creds.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...(this.opts.servername ? { servername: this.opts.servername } : isIP(host) === 0 ? { servername: host } : {}),
        ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
      };
    }
    this.passwordExp = Date.parse(pw.expiresAt);
    const c = mqtt.connect(url, options);
    this.client = c;

    c.on('connect', () => {
      if (this.client !== c) return;
      this.failuresOnUrl = 0;
      this.backoff.reset();
      if (this.probingPrimary) {
        this.probingPrimary = false;
        this.opts.logger.info({ url }, 'mqtt: 8883 reachable again — left the WebSocket fallback');
      }
      const subs = [...this.acl.subscribe].map((s) => topic(gw, s as TopicSuffix));
      c.subscribe(subs, { qos: 1 }, (err, granted) => {
        if (err || granted?.some((g) => g.qos > 1)) {
          this.opts.logger.error({ err, granted }, 'mqtt subscribe rejected');
        }
      });
      this.lastConnectedAt = this.clock.now();
      this.scheduleRotation();
      this.setConnected(true);
      this.opts.logger.info({ url, transport }, 'mqtt connected');
    });
    c.on('message', (t, payload) => {
      const prefix = `gp/v1/${gw}/`;
      if (!t.startsWith(prefix)) return;
      this.emit('message', t.slice(prefix.length), payload);
    });
    c.on('error', (err) => {
      const code = (err as Error & { code?: unknown }).code;
      if (typeof code === 'number' && AUTH_REFUSED.has(code)) {
        // protocol §1: on a refused login fetch a new token and retry with back-off
        this.authRefused = true;
        this.nextFresh = true;
        this.opts.logger.warn({ code, url, transport }, 'mqtt: broker refused the login — will retry with a new token');
        return;
      }
      this.opts.logger.warn({ err: err.message, url }, 'mqtt error');
    });
    c.on('close', () => {
      if (this.client !== c) return;
      this.clock.clearTimeout(this.rotateTimer);
      this.failInflight(c);
      const wasConnected = this.isConnected;
      this.setConnected(false);
      if (!wasConnected) this.onConnectFailed(transport);
      this.scheduleReconnect();
    });
  }

  /**
   * A connect that never reached CONNACK 0. Transport failures count towards failover; a refused login on 8883 does
   * not (the WebSocket path checks the same token), but one on the fallback does (the admin may have switched it off).
   */
  private onConnectFailed(transport: MqttTransport): void {
    if (transport === 'mtls' && this.authRefused) return;
    if (!this.wsUrl) return;
    if (this.probingPrimary) {
      this.probingPrimary = false;
      this.useWs = true;
      this.wsSince = this.clock.now();
      this.opts.logger.warn({ url: this.currentUrl }, 'mqtt: 8883 still unreachable — back on the WebSocket fallback');
      return;
    }
    this.failuresOnUrl++;
    if (this.failuresOnUrl < (this.opts.failoverAfter ?? 3)) return;
    this.failuresOnUrl = 0;
    this.useWs = !this.useWs;
    if (this.useWs) {
      this.wsSince = this.clock.now();
      this.opts.logger.warn(
        { url: this.currentUrl },
        'mqtt: 8883 unreachable — switching to the WebSocket fallback enabled for this gateway (device JWT only, no client certificate; D-239)',
      );
    } else {
      this.opts.logger.warn({ url: this.currentUrl }, 'mqtt: WebSocket fallback failing — back to 8883');
    }
  }

  /** Rotation before the password expires: fetch first, then reconnect; a failed fetch keeps the live session. */
  private scheduleRotation(): void {
    this.clock.clearTimeout(this.rotateTimer);
    if (!Number.isFinite(this.passwordExp)) return;
    const lifetime = this.passwordExp - this.clock.now();
    const lead = Math.min(this.opts.rotateLeadMs ?? 5 * 60_000, Math.max(0, lifetime / 4));
    const jitter = this.random() * Math.min(this.opts.rotateJitterMs ?? 2 * 60_000, Math.max(0, lifetime / 10));
    this.armRotation(Math.max(1000, lifetime - lead - jitter));
  }

  private armRotation(delayMs: number): void {
    this.clock.clearTimeout(this.rotateTimer);
    this.rotateTimer = this.clock.setTimeout(() => void this.rotate(), delayMs);
  }

  private async rotate(): Promise<void> {
    const c = this.client;
    if (this.stopped || !c || !this.isConnected) return;
    const gen = this.gen;
    let pw: MqttPassword;
    try {
      pw = await this.opts.password({ fresh: true });
    } catch (err) {
      if (gen !== this.gen || this.client !== c) return;
      // the broker checks the password only at CONNECT: keep the working session, try again soon
      const left = this.passwordExp - this.clock.now();
      const retry = Math.min(60_000, Math.max(5_000, left / 2));
      this.opts.logger.warn(
        { err: (err as Error).message, retryInMs: retry },
        'mqtt: device token refresh failed — keeping the session',
      );
      this.armRotation(retry);
      return;
    }
    if (gen !== this.gen || this.client !== c || this.stopped) return;
    if (this.useWs && this.clock.now() - this.wsSince >= (this.opts.primaryRetryMs ?? 3_600_000)) {
      this.useWs = false;
      this.probingPrimary = true;
    }
    this.opts.logger.info({ transport: this.transport }, 'mqtt: device token rotated — reconnecting with it');
    this.teardown(true);
    this.backoff.reset();
    this.gen++;
    this.open(pw);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clock.clearTimeout(this.reconnectTimer);
    const delay = this.backoff.next();
    this.opts.logger.debug({ delay }, 'mqtt reconnect scheduled');
    this.reconnectTimer = this.clock.setTimeout(() => {
      if (this.stopped) return;
      this.teardown();
      this.connect();
    }, delay);
  }

  /** Drops the client; `graceful` sends DISCONNECT (normal) first so the broker does not publish the LWT. */
  private teardown(graceful = false): void {
    this.clock.clearTimeout(this.rotateTimer);
    const c = this.client;
    this.client = undefined;
    if (c) {
      this.failInflight(c);
      c.removeAllListeners();
      c.on('error', () => undefined);
      if (graceful && c.connected) c.end(false, { reasonCode: 0 });
      else c.end(true);
    }
    this.setConnected(false);
  }

  /** Rejects every publish still waiting for PUBACK; the on-disk queue re-sends them after reconnect. */
  private failInflight(c: MqttClient): void {
    for (const id of Object.keys(c.outgoing)) {
      try {
        c.removeOutgoingMessage(Number(id));
      } catch {
        /* already gone */
      }
    }
  }

  private setConnected(v: boolean): void {
    if (this.isConnected === v) return;
    this.isConnected = v;
    this.emit(v ? 'connect' : 'close');
  }
}
