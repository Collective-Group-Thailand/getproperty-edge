#!/usr/bin/env node
// Bundles the agent into one CommonJS file (dist/getproperty-edge.cjs) — the input of the SEA binary.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(root, 'dist/getproperty-edge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  // Optional native/worker transports of pino and mqtt's browser shims are never used by the agent.
  external: ['pino-pretty', 'bufferutil', 'utf-8-validate'],
  // OTA trust anchors baked in (fail closed when absent): GP_OTA_PUBKEYS='{"keyId":"-----BEGIN PUBLIC KEY-----…"}'
  define: { __GP_OTA_PUBKEYS__: JSON.stringify(process.env.GP_OTA_PUBKEYS ?? '') },
});

const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
const keys = process.env.GP_OTA_PUBKEYS ? Object.keys(JSON.parse(process.env.GP_OTA_PUBKEYS)) : [];
console.log(
  `build: dist/getproperty-edge.cjs (${(bytes / 1024).toFixed(0)} KiB), OTA keys: ${keys.length ? keys.join(', ') : 'none (OTA disabled)'}`,
);
