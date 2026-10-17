#!/usr/bin/env node
// Generates an ed25519 OTA signing key pair: <dir>/<keyId>.key (private, 0600 — keep offline / in the
// release secret store) and <dir>/<keyId>.pub (bake into builds via GP_OTA_PUBKEYS).
//   pnpm ota:keygen --key-id gp-ota-2026 --out ~/keys
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const keyId = opt('key-id', 'gp-ota-dev');
const out = resolve(opt('out', '.'));
if (!/^[a-z0-9-]{3,64}$/.test(keyId)) throw new Error('key id: lowercase letters, digits, dashes');
mkdirSync(out, { recursive: true, mode: 0o700 });
const priv = join(out, `${keyId}.key`);
if (existsSync(priv)) throw new Error(`${priv} exists — refusing to overwrite a signing key`);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
writeFileSync(join(out, `${keyId}.pub`), pub);
console.log(`ota:keygen: wrote ${priv} (0600) and ${keyId}.pub`);
console.log(`build with: GP_OTA_PUBKEYS='${JSON.stringify({ [keyId]: pub })}'`);
