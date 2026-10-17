import type { DeviceApi } from '../transport/https/device-api.js';
import type { Clock, TimerHandle } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import { generateKeyAndCsr } from './csr.js';
import type { Identity, IdentityStore } from './identity-store.js';
import type { DeviceTokenCache } from './token.js';

const DAY = 86_400_000;

/** Renewal is due 11 calendar months after issue, or 30 days before expiry, whichever is first (protocol §1). */
export function renewalDueAt(notBefore: number, notAfter: number): number {
  const d = new Date(notBefore);
  d.setUTCMonth(d.getUTCMonth() + 11);
  return Math.min(d.getTime(), notAfter - 30 * DAY);
}

/** `POST /v1/device/certificate/renew` answer (CR-003, done in api A `13be5a7`). */
export interface RenewResponse {
  certificatePem: string;
  caChainPem: string;
  /** Informational; the agent reads validity from the certificate itself. */
  notAfter?: string;
}

/** Checks daily; renews with a fresh key + CSR over mTLS (`POST /v1/device/certificate/renew`, CR-003). */
export class CertificateRenewer {
  private timer: TimerHandle | undefined;

  constructor(
    private readonly deps: {
      api: DeviceApi;
      store: IdentityStore;
      tokens: DeviceTokenCache;
      clock: Clock;
      logger: Logger;
      onRenewed: (id: Identity) => void;
    },
  ) {}

  start(): void {
    void this.check();
  }

  stop(): void {
    this.deps.clock.clearTimeout(this.timer);
  }

  async check(): Promise<boolean> {
    const id = this.deps.store.load();
    let renewed = false;
    if (id && this.deps.clock.now() >= renewalDueAt(id.notBefore, id.notAfter)) {
      try {
        await this.renew(id);
        renewed = true;
      } catch (err) {
        this.deps.logger.error({ err: (err as Error).message }, 'certificate renewal failed; retrying in 1 h');
        this.schedule(3_600_000);
        return false;
      }
    }
    this.schedule(DAY);
    return renewed;
  }

  async renew(id: Identity): Promise<Identity> {
    const { keyPem, csrPem } = await generateKeyAndCsr(`gw-${id.gatewayId}`);
    const bearer = await this.deps.tokens.get();
    const res = await this.deps.api.json<RenewResponse>(
      'POST',
      '/v1/device/certificate/renew',
      { csrPem },
      { mtls: true, bearer },
    );
    const next = this.deps.store.save({
      gatewayId: id.gatewayId,
      mqttUrl: id.mqttUrl,
      ...(id.mqttWsUrl ? { mqttWsUrl: id.mqttWsUrl } : {}),
      certPem: res.certificatePem,
      keyPem,
      caPem: res.caChainPem,
    });
    this.deps.logger.info({ notAfter: new Date(next.notAfter).toISOString() }, 'device certificate renewed');
    this.deps.onRenewed(next);
    return next;
  }

  private schedule(ms: number): void {
    this.deps.clock.clearTimeout(this.timer);
    this.timer = this.deps.clock.setTimeout(() => void this.check(), ms);
  }
}
