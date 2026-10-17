import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/**
 * OTA manifest (served by getproperty-api at `/v1/device/ota/manifest`, CR-011). Signed with ed25519 over
 * the canonical JSON of the manifest without `signature` (keys sorted, no whitespace) — the same
 * primitive as minisign, with node:crypto only.
 */
/** Release channel of the artefact (protocol §6); the rollout ring (canary → pilot → all, D-183) is the api's. */
export const OTA_CHANNELS = ['stable', 'beta', 'canary'] as const;
export const OTA_ARCHES = ['arm64', 'x64', 'armv7'] as const;

export interface OtaManifest {
  schema: 1;
  version: string;
  channel: (typeof OTA_CHANNELS)[number];
  arch: (typeof OTA_ARCHES)[number];
  artifact: { url: string; sha256: string; size: number };
  minAgentVersion?: string;
  releasedAt: string;
  notes?: string;
  signature?: { alg: 'ed25519'; keyId: string; value: string };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function signingPayload(m: OtaManifest): Buffer {
  const { signature: _s, ...rest } = m;
  return Buffer.from(canonicalJson(rest));
}

export function signManifest(m: OtaManifest, privateKeyPem: string, keyId: string): OtaManifest {
  const value = sign(null, signingPayload(m), createPrivateKey(privateKeyPem)).toString('base64');
  return { ...m, signature: { alg: 'ed25519', keyId, value } };
}

export class OtaVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtaVerifyError';
  }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** semver precedence (pre-release < release; numeric identifiers compared numerically). */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) throw new OtaVerifyError(`not semver: ${!ma ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d) return Math.sign(d);
  }
  if (ma[4] === mb[4]) return 0;
  if (!ma[4]) return 1;
  if (!mb[4]) return -1;
  const pa = ma[4].split('.');
  const pb = mb[4].split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]!);
    const nb = /^\d+$/.test(pb[i]!);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Math.sign(Number(pa[i]) - Number(pb[i]));
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * Verifies signature (trusted key ids only), shape, architecture and that it is an upgrade.
 * Returns the manifest typed; throws OtaVerifyError otherwise.
 */
export function verifyManifest(
  raw: unknown,
  trustedKeys: Record<string, string>,
  ctx: { currentVersion: string; arch: string },
): OtaManifest {
  if (!raw || typeof raw !== 'object') throw new OtaVerifyError('manifest is not an object');
  const m = raw as OtaManifest;
  const sig = m.signature;
  if (!sig || sig.alg !== 'ed25519' || typeof sig.value !== 'string')
    throw new OtaVerifyError('manifest is not signed');
  const pem = trustedKeys[sig.keyId];
  if (!pem) throw new OtaVerifyError(`signing key ${String(sig.keyId)} is not trusted by this build`);
  let ok: boolean;
  try {
    ok = verify(null, signingPayload(m), createPublicKey(pem), Buffer.from(sig.value, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) throw new OtaVerifyError('manifest signature invalid');
  if (m.schema !== 1) throw new OtaVerifyError(`unsupported manifest schema ${String(m.schema)}`);
  if (!SEMVER.test(m.version)) throw new OtaVerifyError('bad version');
  if (!(OTA_CHANNELS as readonly string[]).includes(m.channel))
    throw new OtaVerifyError(`unknown channel ${String(m.channel)}`);
  if (!(OTA_ARCHES as readonly string[]).includes(m.arch)) throw new OtaVerifyError(`unknown arch ${String(m.arch)}`);
  if (!m.artifact || !/^[0-9a-f]{64}$/.test(m.artifact.sha256) || !(m.artifact.size > 0))
    throw new OtaVerifyError('bad artifact');
  if (!/^https:\/\//.test(m.artifact.url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(m.artifact.url))
    throw new OtaVerifyError('artifact URL must be HTTPS');
  if (m.arch !== ctx.arch) throw new OtaVerifyError(`artifact is for ${m.arch}, this gateway is ${ctx.arch}`);
  if (compareSemver(m.version, ctx.currentVersion) <= 0)
    throw new OtaVerifyError(`version ${m.version} is not newer than ${ctx.currentVersion}`);
  if (m.minAgentVersion && compareSemver(ctx.currentVersion, m.minAgentVersion) < 0)
    throw new OtaVerifyError(`requires agent ≥ ${m.minAgentVersion}`);
  return m;
}
