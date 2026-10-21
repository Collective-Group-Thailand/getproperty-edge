import { EventEmitter } from 'node:events';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { lwtPayload, topic } from '../../protocol/envelopes.js';
import type { TopicSuffix } from '../../protocol/types.js';
import { Backoff } from '../../util/backoff.js';
import { type Clock, systemClock, type TimerHandle } from '../../util/clock.js';
import type { Logger } from '../../util/logger.js';
import type { Link } from '../link.js';

export interface MqttCredentials {
  key: string;
  cert: string;
  ca: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Broker URLs must be TLS (`mqtts://`, `wss://`): the gateway authenticates with its client certificate and verifies
 * the broker against the bootstrap CA only. Plain `mqtt://` / `ws://` is accepted for a loopback dev broker alone —
 * never a silent downgrade to an unauthenticated path (D-230, O-012).
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

export interface MqttLinkOptions {
  gatewayId: string;
  /** Primary broker URL: EMQX's mutual-TLS listener, e.g. `mqtts://mqtt.getproperty.co:8883` (D-230). */
  url: string;
  /**
   * WebSocket fallback for buildings that block 8883 (protocol §1). **Not available on the R1 platform** (O-012):
   * the agent passes it only when `GP_MQTT_WS_FALLBACK=on`, and the WSS endpoint is held to the same rules as 8883
   * (server certificate from the bootstrap CA, client certificate presented) — it fails closed otherwise.
   */
  wsUrl?: string;
  credentials: () => MqttCredentials;
  keepaliveS?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  connectTimeoutMs?: number;
  /** Consecutive failures on one URL before trying the other. */
  failoverAfter?: number;
  servername?: string;
  /** Custom DNS lookup (tests inject DNS failures). */
  lookup?: LookupFunction;
  logger: Logger;
  clock?: Clock;
  random?: () => number;
}

/**
 * MQTT 5 over TLS with the gateway's client certificate (protocol §1): keepalive 30 s, LWT on /health,
 * exponential backoff with jitter, retained /config and /cmd subscriptions re-established on every
 * connect (clean start). QoS 1 publishes resolve on PUBACK; on link loss every unacknowledged publish
 * is rejected so the caller re-sends from its on-disk queue (no hidden in-memory redelivery).
 */
export class MqttLink extends EventEmitter implements Link {
  private client: MqttClient | undefined;
  private readonly backoff: Backoff;
  private reconnectTimer: TimerHandle | undefined;
  private stopped = true;
  private failuresOnUrl = 0;
  private useWs = false;
  private isConnected = false;
  private lastConnectedAt: number | null = null;
  private readonly clock: Clock;

  constructor(private readonly opts: MqttLinkOptions) {
    super();
    this.clock = opts.clock ?? systemClock;
    this.backoff = new Backoff(opts.backoffBaseMs ?? 1000, opts.backoffMaxMs ?? 120_000, opts.random);
    assertSecureBrokerUrl(opts.url);
    if (opts.wsUrl) assertSecureBrokerUrl(opts.wsUrl);
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get lastConnected(): number | null {
    return this.lastConnectedAt;
  }

  get currentUrl(): string {
    return this.useWs && this.opts.wsUrl ? this.opts.wsUrl : this.opts.url;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Re-reads the credentials (after certificate renewal) and reconnects. */
  restart(): void {
    this.teardown();
    this.backoff.reset();
    if (!this.stopped) this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clock.clearTimeout(this.reconnectTimer);
    const c = this.client;
    this.client = undefined;
    if (c) {
      this.failInflight(c);
      await new Promise<void>((resolve) => c.end(false, {}, () => resolve()));
    }
    this.setConnected(false);
  }

  publish(suffix: TopicSuffix, payload: string): Promise<void> {
    const c = this.client;
    if (!c || !this.isConnected) return Promise.reject(new Error('mqtt: not connected'));
    return new Promise((resolve, reject) => {
      c.publish(topic(this.opts.gatewayId, suffix), payload, { qos: 1, retain: false }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private connect(): void {
    const creds = this.opts.credentials();
    const gw = this.opts.gatewayId;
    const options: IClientOptions = {
      protocolVersion: 5,
      clientId: `gw-${gw}`,
      clean: true,
      keepalive: this.opts.keepaliveS ?? 30,
      reconnectPeriod: 0,
      connectTimeout: this.opts.connectTimeoutMs ?? 15_000,
      resubscribe: false,
      queueQoSZero: false,
      key: creds.key,
      cert: creds.cert,
      // the bootstrap CA chain is the only trust anchor (no system roots); hostname checked against the SAN
      ca: creds.ca,
      rejectUnauthorized: true,
      will: { topic: topic(gw, 'health'), payload: Buffer.from(lwtPayload()), qos: 1, retain: false },
    };
    if (this.opts.servername) options.servername = this.opts.servername;
    (options as IClientOptions & { minVersion?: string }).minVersion = 'TLSv1.2';
    if (this.opts.lookup) (options as IClientOptions & { lookup?: LookupFunction }).lookup = this.opts.lookup;
    const url = this.currentUrl;
    if (url.startsWith('wss:')) {
      const host = new URL(url).hostname;
      options.wsOptions = {
        key: creds.key,
        cert: creds.cert,
        ca: creds.ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...(this.opts.servername ? { servername: this.opts.servername } : isIP(host) === 0 ? { servername: host } : {}),
        ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
      };
    }
    const c = mqtt.connect(url, options);
    this.client = c;

    c.on('connect', () => {
      if (this.client !== c) return;
      this.failuresOnUrl = 0;
      this.backoff.reset();
      c.subscribe([topic(gw, 'config'), topic(gw, 'cmd')], { qos: 1 }, (err, granted) => {
        if (err || granted?.some((g) => g.qos > 1)) {
          this.opts.logger.error({ err, granted }, 'mqtt subscribe rejected');
        }
      });
      this.lastConnectedAt = this.clock.now();
      this.setConnected(true);
      this.opts.logger.info({ url }, 'mqtt connected');
    });
    c.on('message', (t, payload) => {
      const prefix = `gp/v1/${gw}/`;
      if (!t.startsWith(prefix)) return;
      this.emit('message', t.slice(prefix.length), payload);
    });
    c.on('error', (err) => {
      this.opts.logger.warn({ err: err.message, url }, 'mqtt error');
    });
    c.on('close', () => {
      if (this.client !== c) return;
      this.failInflight(c);
      const wasConnected = this.isConnected;
      this.setConnected(false);
      if (!wasConnected) this.failuresOnUrl++;
      if (this.opts.wsUrl && this.failuresOnUrl >= (this.opts.failoverAfter ?? 3)) {
        this.useWs = !this.useWs;
        this.failuresOnUrl = 0;
        this.opts.logger.warn({ url: this.currentUrl }, 'mqtt failing over');
      }
      this.scheduleReconnect();
    });
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

  private teardown(): void {
    const c = this.client;
    this.client = undefined;
    if (c) {
      this.failInflight(c);
      c.removeAllListeners();
      c.on('error', () => undefined);
      c.end(true);
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
