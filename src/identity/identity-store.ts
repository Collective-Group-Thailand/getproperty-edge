import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../util/fs-atomic.js';
import type { Logger } from '../util/logger.js';
import { certMatchesKey, parseCert } from './csr.js';

/** Topic suffixes below `gp/v1/<gatewayId>/` the broker lets this gateway use (bootstrap `mqtt.acl`, protocol 1.2). */
export interface MqttAcl {
  publish: string[];
  subscribe: string[];
}

export interface Identity {
  gatewayId: string;
  mqttUrl: string;
  mqttWsUrl?: string;
  /** Absent for identities bootstrapped before protocol 1.2: the contract's `x-acl` applies. */
  mqttAcl?: MqttAcl;
  certPem: string;
  keyPem: string;
  caPem: string;
  notBefore: number;
  notAfter: number;
}

interface IdentityMeta {
  gatewayId: string;
  mqttUrl: string;
  mqttWsUrl?: string;
  mqttAcl?: MqttAcl;
}

/**
 * Device identity on disk: `device.key` (the only secret, 0600), `device.crt`, `ca.pem` and the
 * non-secret `identity.json` (gatewayId, broker URLs). Directory 0700, owned by the service user.
 */
export class IdentityStore {
  readonly dir: string;
  private cached: Identity | null = null;

  constructor(
    stateDir: string,
    private readonly logger: Logger,
  ) {
    this.dir = join(stateDir, 'identity');
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  load(): Identity | null {
    if (this.cached) return this.cached;
    const files = ['device.key', 'device.crt', 'ca.pem', 'identity.json'];
    if (!files.every((f) => existsSync(this.path(f)))) return null;
    for (const f of files) this.enforceMode(this.path(f));
    const meta = JSON.parse(readFileSync(this.path('identity.json'), 'utf8')) as IdentityMeta;
    const certPem = readFileSync(this.path('device.crt'), 'utf8');
    const keyPem = readFileSync(this.path('device.key'), 'utf8');
    const caPem = readFileSync(this.path('ca.pem'), 'utf8');
    if (!certMatchesKey(certPem, keyPem)) throw new Error('device certificate does not match the device key');
    const info = parseCert(certPem);
    // protocol 1.2: the MQTT username / client id is `gw-<gatewayId>` and must equal the certificate CN on 8883
    if (info.subjectCn !== `gw-${meta.gatewayId}`)
      throw new Error(`stored certificate CN ${info.subjectCn ?? '(none)'} is not gw-${meta.gatewayId}`);
    this.cached = { ...meta, certPem, keyPem, caPem, notBefore: info.notBefore, notAfter: info.notAfter };
    return this.cached;
  }

  save(id: Omit<Identity, 'notBefore' | 'notAfter'>): Identity {
    if (!certMatchesKey(id.certPem, id.keyPem)) throw new Error('issued certificate does not match the device key');
    const info = parseCert(id.certPem);
    if (info.subjectCn !== `gw-${id.gatewayId}`)
      throw new Error(`certificate CN ${info.subjectCn ?? '(none)'} is not gw-${id.gatewayId}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Key first, identity.json last: a crash in between leaves no half identity that `load` accepts
    // with a mismatching key (load checks the pair).
    writeFileAtomic(this.path('device.key'), id.keyPem, 0o600);
    writeFileAtomic(this.path('device.crt'), id.certPem, 0o600);
    writeFileAtomic(this.path('ca.pem'), id.caPem, 0o600);
    const meta: IdentityMeta = { gatewayId: id.gatewayId, mqttUrl: id.mqttUrl };
    if (id.mqttWsUrl) meta.mqttWsUrl = id.mqttWsUrl;
    if (id.mqttAcl) meta.mqttAcl = id.mqttAcl;
    writeFileAtomic(this.path('identity.json'), JSON.stringify(meta, null, 2) + '\n', 0o600);
    this.cached = { ...id, notBefore: info.notBefore, notAfter: info.notAfter };
    return this.cached;
  }

  credentials(): { key: string; cert: string; ca: string } | undefined {
    const id = this.load();
    return id ? { key: id.keyPem, cert: id.certPem, ca: id.caPem } : undefined;
  }

  private enforceMode(file: string): void {
    const mode = statSync(file).mode & 0o777;
    if (mode !== 0o600) {
      this.logger.warn({ file, mode: mode.toString(8) }, 'identity file permissions too open — fixing to 0600');
      chmodSync(file, 0o600);
    }
  }
}
