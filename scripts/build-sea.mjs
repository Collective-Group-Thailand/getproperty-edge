#!/usr/bin/env node
// Single executable (Node SEA): bundle → SEA blob → copy of a Node 24 binary → postject.
//
//   pnpm build:sea                                   # linux-x64 (this machine's node)
//   pnpm build:sea --arch arm64 --node ./node-v24.x-linux-arm64/bin/node   # cross build for the gateway
//
// The blob is architecture-independent (no snapshot, no code cache), so an arm64 binary is produced on
// any host by injecting it into the official linux-arm64 `node` (verify its SHASUMS256 first — see
// docs/HARDWARE.md "Image build").
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { arch as hostArch, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const arch = opt('arch', hostArch());
const nodeBin = resolve(opt('node', process.execPath));
if (platform() !== 'linux') throw new Error('build:sea targets Linux gateways; run it on Linux');
if (arch !== hostArch() && nodeBin === process.execPath)
  throw new Error(`--arch ${arch} needs --node <path to the linux-${arch} node binary>`);

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit' });

const blob = resolve(root, 'dist/sea-prep.blob');
const seaConfig = resolve(root, 'dist/sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: resolve(root, 'dist/getproperty-edge.cjs'),
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const out = resolve(root, `dist/getproperty-edge-${version}-linux-${arch}`);
copyFileSync(nodeBin, out);
chmodSync(out, 0o755);
execFileSync(
  process.execPath,
  [
    resolve(root, 'node_modules/postject/dist/cli.js'),
    out,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit' },
);
if (arch === hostArch()) {
  const v = execFileSync(out, ['--version'], { encoding: 'utf8' }).trim();
  if (v !== version) throw new Error(`smoke test: binary reports ${v}, expected ${version}`);
  console.log(`build:sea: ${out} (smoke test --version = ${v})`);
} else {
  console.log(`build:sea: ${out} (cross-built; smoke-test on the gateway with --version)`);
}
