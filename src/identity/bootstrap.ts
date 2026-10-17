import { arch, hostname } from 'node:os';

import { ApiError, type DeviceApi } from '../transport/https/device-api.js';
import type { Logger } from '../util/logger.js';
import { generateKeyAndCsr } from './csr.js';
import type { Identity, IdentityStore } from './identity-store.js';

/**
 * `POST /v1/device/bootstrap` request/response as documented in `docs/contract-requests.md` (CR-001).
 * The endpoint is not yet in getproperty-api's openapi.json; this shape is what the agent sends.
 */
export interface BootstrapRequest {
  provisioningCode: string;
  csrPem: string;
  agentVersion: string;
  hardware: { arch: string; hostname: string; serial: string | null };
}

export interface BootstrapResponse {
  gatewayId: string;
  certificatePem: string;
  caChainPem: string;
  mqtt: { url: string; wsUrl?: string };
  deviceToken?: { accessToken: string; expiresAt: string };
}

export const PROVISIONING_CODE_RE = /^[A-Z0-9-]{8,64}$/;

export function normaliseProvisioningCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** One-time provisioning code from `GP_PROVISIONING_CODE` or the status page's one-time entry. */
export class ProvisioningCodeSource {
  private waiters: Array<(code: string) => void> = [];
  private pending: string | undefined;

  constructor(envCode?: string) {
    if (envCode) this.pending = normaliseProvisioningCode(envCode);
  }

  submit(raw: string): boolean {
    const code = normaliseProvisioningCode(raw);
    if (!PROVISIONING_CODE_RE.test(code)) return false;
    const w = this.waiters.shift();
    if (w) w(code);
    else this.pending = code;
    return true;
  }

  next(): Promise<string> {
    if (this.pending) {
      const c = this.pending;
      this.pending = undefined;
      return Promise.resolve(c);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get waiting(): boolean {
    return this.waiters.length > 0;
  }
}

export interface BootstrapDeps {
  api: DeviceApi;
  store: IdentityStore;
  codes: ProvisioningCodeSource;
  agentVersion: string;
  serial: string | null;
  logger: Logger;
  onToken?: (token: { accessToken: string; expiresAt: string }) => void;
  onStatus?: (status: 'waiting_for_code' | 'bootstrapping' | 'rejected' | 'done', detail?: string) => void;
}

/**
 * Loads the stored identity, or provisions the gateway: CSR generated locally (the key never leaves),
 * certificate + CA chain stored 0600. A rejected code (4xx) waits for a new one; network errors retry.
 */
export async function ensureIdentity(deps: BootstrapDeps, retryDelayMs = 10_000): Promise<Identity> {
  const existing = deps.store.load();
  if (existing) return existing;
  for (;;) {
    deps.onStatus?.('waiting_for_code');
    const code = await deps.codes.next();
    deps.onStatus?.('bootstrapping');
    for (;;) {
      try {
        const id = await bootstrapOnce(deps, code);
        deps.onStatus?.('done');
        return id;
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          deps.logger.error({ status: err.status }, 'provisioning code rejected');
          deps.onStatus?.('rejected', `rejected (${err.status})`);
          break; // ask for a new code
        }
        deps.logger.warn({ err: (err as Error).message }, 'bootstrap failed, retrying');
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
}

export async function bootstrapOnce(deps: BootstrapDeps, code: string): Promise<Identity> {
  const { keyPem, csrPem } = await generateKeyAndCsr('gw-provisioning');
  const body: BootstrapRequest = {
    provisioningCode: code,
    csrPem,
    agentVersion: deps.agentVersion,
    hardware: { arch: arch(), hostname: hostname(), serial: deps.serial },
  };
  const res = await deps.api.json<BootstrapResponse>('POST', '/v1/device/bootstrap', body, { mtls: false });
  const id = deps.store.save({
    gatewayId: res.gatewayId,
    mqttUrl: res.mqtt.url,
    ...(res.mqtt.wsUrl ? { mqttWsUrl: res.mqtt.wsUrl } : {}),
    certPem: res.certificatePem,
    keyPem,
    caPem: res.caChainPem,
  });
  if (res.deviceToken) deps.onToken?.(res.deviceToken);
  deps.logger.info({ gatewayId: id.gatewayId }, 'gateway bootstrapped');
  return id;
}
