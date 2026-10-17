import type { DeviceApi } from '../transport/https/device-api.js';
import type { Clock } from '../util/clock.js';

export interface DeviceToken {
  accessToken: string;
  expiresAt: string;
}

/**
 * Short-lived device JWT for HTTPS calls (api-conventions §4/§7), kept in memory only — no tokens on
 * disk. Refreshed over mTLS with `POST /v1/device/token` (CR-002) one minute before expiry.
 */
export class DeviceTokenCache {
  private token: { value: string; exp: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly api: DeviceApi,
    private readonly clock: Clock,
  ) {}

  seed(t: DeviceToken): void {
    this.token = { value: t.accessToken, exp: Date.parse(t.expiresAt) };
  }

  invalidate(): void {
    this.token = undefined;
  }

  async get(): Promise<string> {
    if (this.token && this.token.exp - 60_000 > this.clock.now()) return this.token.value;
    this.inflight ??= this.api
      .json<DeviceToken>('POST', '/v1/device/token', {}, { mtls: true })
      .then((t) => {
        this.seed(t);
        return t.accessToken;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
