/**
 * ed25519 public keys trusted for OTA manifests, baked in at build time:
 * `GP_OTA_PUBKEYS='{"gp-ota-2026":"-----BEGIN PUBLIC KEY-----…"}' pnpm build:sea` (esbuild define).
 * A build without keys refuses every OTA (fail closed) — production images are always built with the
 * platform key (docs/SECURITY.md, key custody).
 */
declare const __GP_OTA_PUBKEYS__: string | undefined;

export function bakedOtaKeys(): Record<string, string> {
  try {
    const raw = typeof __GP_OTA_PUBKEYS__ === 'string' ? __GP_OTA_PUBKEYS__ : '';
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
