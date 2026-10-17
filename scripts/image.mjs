#!/usr/bin/env node
// `pnpm image` — release artefact for the api's OTA rollout: SEA binary + signed manifest + SHA256SUMS
// in dist/release/<version>/.
//
//   OTA_SIGNING_KEY_FILE=~/keys/gp-ota-2026.key OTA_KEY_ID=gp-ota-2026 \
//   GP_OTA_PUBKEYS="$(cat trusted.json)" pnpm image --arch arm64 --node ./node-arm64/bin/node \
//     --base-url https://releases.getproperty.co/edge --channel canary   # stable | beta | canary (protocol §6)
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch as hostArch } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const arch = opt('arch', hostArch());
const channel = opt('channel', 'canary');
const baseUrl = opt('base-url', 'https://releases.getproperty.invalid/edge');
const keyFile = process.env.OTA_SIGNING_KEY_FILE;
const keyId = process.env.OTA_KEY_ID;
if (!keyFile || !keyId) throw new Error('OTA_SIGNING_KEY_FILE and OTA_KEY_ID are required');
if (!['stable', 'beta', 'canary'].includes(channel)) throw new Error('--channel stable | beta | canary');

const privateKey = createPrivateKey(readFileSync(keyFile, 'utf8'));
const pubPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
const baked = process.env.GP_OTA_PUBKEYS ? JSON.parse(process.env.GP_OTA_PUBKEYS) : {};
// The new build must trust the key that signs it, or the *next* update could not be verified.
if (baked[keyId] !== pubPem) baked[keyId] = pubPem;
const env = { ...process.env, GP_OTA_PUBKEYS: JSON.stringify(baked) };

const seaArgs = [resolve(root, 'scripts/build-sea.mjs'), '--arch', arch];
if (opt('node')) seaArgs.push('--node', opt('node'));
execFileSync(process.execPath, seaArgs, { stdio: 'inherit', env });

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const name = `getproperty-edge-${version}-linux-${arch}`;
const outDir = resolve(root, 'dist/release', version);
mkdirSync(outDir, { recursive: true });
copyFileSync(resolve(root, 'dist', name), join(outDir, name));
const bin = readFileSync(join(outDir, name));
const sha256 = createHash('sha256').update(bin).digest('hex');

const canonical = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`;

const manifest = {
  schema: 1,
  version,
  channel,
  arch,
  artifact: {
    url: `${baseUrl.replace(/\/$/, '')}/${version}/${name}`,
    sha256,
    size: statSync(join(outDir, name)).size,
  },
  releasedAt: new Date().toISOString(),
};
manifest.signature = {
  alg: 'ed25519',
  keyId,
  value: sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64'),
};
writeFileSync(join(outDir, `manifest-${arch}.json`), JSON.stringify(manifest, null, 2) + '\n');
const sums = join(outDir, 'SHA256SUMS');
const kept = existsSync(sums)
  ? readFileSync(sums, 'utf8')
      .split('\n')
      .filter((l) => l && !l.endsWith(`  ${name}`))
  : [];
writeFileSync(sums, [...kept, `${sha256}  ${name}`].join('\n') + '\n');
for (const f of ['scripts/install.sh', 'scripts/ota-guard.sh', 'systemd/getproperty-edge.service'])
  copyFileSync(resolve(root, f), join(outDir, basename(f)));
console.log(`image: ${outDir}/${name} sha256 ${sha256.slice(0, 16)}… signed by ${keyId} (${channel})`);
