import { arch, hostname } from 'node:os';

import { MQTT_ACL } from '../protocol/types.js';
import { ApiError, type DeviceApi } from '../transport/https/device-api.js';
import type { Logger } from '../util/logger.js';
import { generateKeyAndCsr } from './csr.js';
import type { Identity, IdentityStore, MqttAcl } from './identity-store.js';

/**
 * `POST /v1/device/bootstrap` request/response (CR-001; getproperty-api `DeviceBootstrapRequestDto` /
 * `DeviceBootstrapDto`, device protocol 1.2 for `mqtt.username`, `mqtt.password`, `mqtt.acl`). Only the fields the
 * agent uses are typed; the token pair of the answer is not kept (the agent renews its JWT over mTLS).
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
  mqtt: {
    url: string;
    /** Present only when the platform admin enabled this gateway's WebSocket fallback (D-239). */
    wsUrl?: string;
    clientId?: string;
    username?: string;
    /** `MqttPasswordMode` — `device_jwt` (protocol 1.2). */
    password?: string;
    acl?: Array<{ action: 'publish' | 'subscribe'; topic: string }>;
  };
  deviceToken?: { accessToken: string; expiresAt: string };
}

/** The only MQTT password mode this agent speaks (protocol 1.2, `MqttPasswordMode`). */
export const SUPPORTED_PASSWORD_MODE = 'device_jwt';

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
  const acl = bootstrapAcl(res, deps.logger);
  // The certificate is issued and the code consumed at this point: store the identity even when the answer looks odd
  // (a refusal here would brick the gateway until a new code is issued) — but say loudly what the broker will refuse.
  const expected = `gw-${res.gatewayId}`;
  for (const [field, v] of [
    ['clientId', res.mqtt.clientId],
    ['username', res.mqtt.username],
  ] as const)
    if (v !== undefined && v !== expected)
      deps.logger.error({ field, expected }, 'bootstrap mqtt login differs from the certificate CN — using the CN');
  if (res.mqtt.password !== undefined && res.mqtt.password !== SUPPORTED_PASSWORD_MODE)
    deps.logger.error(
      { mode: res.mqtt.password },
      'bootstrap asks for an MQTT password mode this agent does not support — sending the device JWT (update the agent)',
    );
  const id = deps.store.save({
    gatewayId: res.gatewayId,
    mqttUrl: res.mqtt.url,
    ...(res.mqtt.wsUrl ? { mqttWsUrl: res.mqtt.wsUrl } : {}),
    ...(acl ? { mqttAcl: acl } : {}),
    certPem: res.certificatePem,
    keyPem,
    caPem: res.caChainPem,
  });
  if (res.deviceToken) deps.onToken?.(res.deviceToken);
  deps.logger.info({ gatewayId: id.gatewayId, wsFallbackOffered: !!id.mqttWsUrl }, 'gateway bootstrapped');
  return id;
}

/**
 * The broker ACL of the bootstrap answer (protocol 1.2), as topic suffixes of this gateway. Entries outside
 * `gp/v1/<gatewayId>/` or with wildcards are ignored (the agent never needs them); a topic the agent needs but the
 * answer lacks is logged — the broker would disconnect the gateway for it (`deny_action = disconnect`).
 */
export function bootstrapAcl(res: BootstrapResponse, logger: Logger): MqttAcl | undefined {
  if (!Array.isArray(res.mqtt.acl)) return undefined;
  const prefix = `gp/v1/${res.gatewayId}/`;
  const acl: MqttAcl = { publish: [], subscribe: [] };
  for (const e of res.mqtt.acl) {
    if (!e || typeof e.topic !== 'string' || !e.topic.startsWith(prefix) || /[+#]/.test(e.topic)) continue;
    const suffix = e.topic.slice(prefix.length);
    if (e.action === 'publish' && !acl.publish.includes(suffix)) acl.publish.push(suffix);
    if (e.action === 'subscribe' && !acl.subscribe.includes(suffix)) acl.subscribe.push(suffix);
  }
  const missing = [
    ...MQTT_ACL.publish.filter((t) => !acl.publish.includes(t)).map((t) => `publish ${t}`),
    ...MQTT_ACL.subscribe.filter((t) => !acl.subscribe.includes(t)).map((t) => `subscribe ${t}`),
  ];
  if (missing.length)
    logger.error({ missing }, 'bootstrap ACL lacks topics of the protocol — those messages stay queued');
  return acl;
}
