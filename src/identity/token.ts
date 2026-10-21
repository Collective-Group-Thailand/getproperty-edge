import type { DeviceApi } from '../transport/https/device-api.js';
import type { Clock } from '../util/clock.js';

export interface DeviceToken {
  accessToken: string;
  expiresAt: string;
}

/**
 * Short-lived device JWT (api-conventions §4/§7), kept in memory only — no tokens on disk. Refreshed over mTLS with
 * `POST /v1/device/token` (CR-002). Used as the bearer of HTTPS calls (refreshed one minute before expiry) and, since
 * device protocol 1.2 (D-235, D-244), as the **MQTT password** (`mqttPassword`: a token with enough life left for
 * the connect, else a fresh one).
 */
export class DeviceTokenCache {
  private token: { value: string; exp: number; expiresAt: string } | undefined;
  private inflight: Promise<DeviceToken> | undefined;

  constructor(
    private readonly api: DeviceApi,
    private readonly clock: Clock,
  ) {}

  seed(t: DeviceToken): void {
    const exp = Date.parse(t.expiresAt);
    if (!t.accessToken || !Number.isFinite(exp)) throw new Error('device token without accessToken / expiresAt');
    this.token = { value: t.accessToken, exp, expiresAt: t.expiresAt };
  }

  /** Drops the cached token (e.g. the broker refused it): the next caller fetches a new one. */
  invalidate(): void {
    this.token = undefined;
  }

  /** Bearer for HTTPS calls: the cached token while it is valid for at least another minute. */
  async get(): Promise<string> {
    return (await this.valid(60_000)).accessToken;
  }

  /**
   * MQTT password (protocol 1.2): a device JWT valid for at least `minValidityMs` more (default 5 min, so it cannot
   * expire between fetch and CONNECT), else a freshly issued one; `fresh` always asks the API for a new token (token
   * rotation, a refused CONNECT).
   */
  async mqttPassword(opts: { fresh?: boolean; minValidityMs?: number } = {}): Promise<DeviceToken> {
    if (opts.fresh) this.invalidate();
    return this.valid(opts.minValidityMs ?? 5 * 60_000);
  }

  private valid(minValidityMs: number): Promise<DeviceToken> {
    const t = this.token;
    if (t && t.exp - minValidityMs > this.clock.now())
      return Promise.resolve({ accessToken: t.value, expiresAt: t.expiresAt });
    this.inflight ??= this.api
      .json<DeviceToken>('POST', '/v1/device/token', {}, { mtls: true })
      .then((fresh) => {
        this.seed(fresh);
        return fresh;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
