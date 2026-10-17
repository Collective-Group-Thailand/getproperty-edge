import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import type { DeviceTokenCache } from '../identity/token.js';
import type { DeviceApi } from '../transport/https/device-api.js';
import type { LogRing } from '../util/logger.js';

/** `POST /v1/device/logs/presign` answer (CR-004, done in api A `13be5a7`). */
export interface PresignResponse {
  /** The `core.document` (kind `log_bundle`) the bundle becomes. */
  fileId?: string;
  uploadUrl: string;
  method?: 'PUT';
  headers?: Record<string, string>;
  expiresAt?: string;
}

/** The api refuses presigns above 50 MB (CR-004). */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

/**
 * `upload_logs`: bundles the in-memory log ring plus the last 24 h of the systemd journal (when present),
 * gzips it, asks `POST /v1/device/logs/presign` (CR-004) for an upload URL and PUTs the bundle there.
 * Logs never contain secrets (pino redaction list).
 */
export class LogUploader {
  constructor(
    private readonly api: DeviceApi,
    private readonly tokens: DeviceTokenCache,
    private readonly ring: LogRing,
    private readonly journal: (sinceHours: number) => Promise<string> = async (h) =>
      (
        await promisify(execFile)('journalctl', ['-u', 'getproperty-edge', '--since', `-${h}h`, '-o', 'short-iso'], {
          maxBuffer: 32 * 1024 * 1024,
        })
      ).stdout,
  ) {}

  async bundle(sinceHours = 24): Promise<Buffer> {
    let journal: string;
    try {
      journal = await this.journal(sinceHours);
    } catch {
      journal = '(journal unavailable)\n';
    }
    const text = `# getproperty-edge log bundle\n## journal (${sinceHours} h)\n${journal}\n## agent ring buffer\n${this.ring.snapshot()}`;
    return gzipSync(Buffer.from(text));
  }

  async upload(sinceHours = 24): Promise<{ bytes: number; sha256: string; fileId?: string }> {
    const body = await this.bundle(sinceHours);
    if (body.length > MAX_BUNDLE_BYTES) throw new Error(`log bundle ${body.length} B exceeds the 50 MB presign limit`);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const bearer = await this.tokens.get();
    const pre = await this.api.json<PresignResponse>(
      'POST',
      '/v1/device/logs/presign',
      { contentType: 'application/gzip', sizeBytes: body.length, sha256 },
      { mtls: true, bearer },
    );
    const res = await this.api.raw(
      pre.method ?? 'PUT',
      new URL(pre.uploadUrl),
      body,
      { 'content-type': 'application/gzip', ...pre.headers },
      false,
    );
    if (res.status < 200 || res.status >= 300) throw new Error(`log upload PUT → ${res.status}`);
    return { bytes: body.length, sha256, ...(pre.fileId ? { fileId: pre.fileId } : {}) };
  }
}
