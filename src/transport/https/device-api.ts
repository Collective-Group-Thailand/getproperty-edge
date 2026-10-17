import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import type { Logger } from '../../util/logger.js';
import type { MqttCredentials } from '../mqtt/mqtt-link.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface DeviceApiOptions {
  baseUrl: string;
  /** Extra CA bundle (PEM) trusted for the API server in addition to the system store. */
  ca?: string;
  /** Client certificate for mTLS calls (absent before bootstrap). */
  credentials?: () => MqttCredentials | undefined;
  timeoutMs?: number;
  logger: Logger;
}

export interface CallOptions {
  bearer?: string;
  /** Present the device certificate (every call except bootstrap). */
  mtls?: boolean;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Plain HTTP is accepted only for loopback (local dev stub); everything else must be HTTPS. */
export function assertSecureUrl(url: URL): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return;
  throw new Error(`refusing non-HTTPS URL ${url.origin}`);
}

/** HTTPS client for the `/v1/device/*` surface (api-conventions §7). */
export class DeviceApi {
  constructor(private readonly opts: DeviceApiOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async json<T>(method: string, path: string, body: unknown, call: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...call.headers };
    let payload: Buffer | undefined;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['content-type'] = 'application/json';
    }
    if (call.bearer) headers.authorization = `Bearer ${call.bearer}`;
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
    const res = await this.raw(method, new URL(path, this.opts.baseUrl), payload, headers, call.mtls ?? true);
    const text = res.body.toString('utf8');
    const parsed: unknown = text ? safeJson(text) : undefined;
    if (res.status < 200 || res.status >= 300) {
      const title = parsed && typeof parsed === 'object' && 'title' in parsed ? String(parsed.title) : '';
      throw new ApiError(res.status, parsed, `${method} ${path} → ${res.status} ${title}`.trim());
    }
    return parsed as T;
  }

  /** GET streamed (OTA artefacts): resolves with the response once headers arrive; non-2xx rejects. */
  stream(url: URL, mtls: boolean, headers: Record<string, string> = {}): Promise<IncomingMessage> {
    assertSecureUrl(url);
    const creds = mtls ? this.opts.credentials?.() : undefined;
    const options: RequestOptions = { method: 'GET', headers, timeout: this.opts.timeoutMs ?? 30_000 };
    if (url.protocol === 'https:') {
      if (this.opts.ca) options.ca = this.opts.ca;
      if (creds) {
        options.key = creds.key;
        options.cert = creds.cert;
      }
    }
    const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = fn(url, options, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new ApiError(status, null, `GET ${url.pathname} → ${status}`));
        } else resolve(res);
      });
      req.on('timeout', () => req.destroy(new Error(`timeout after ${options.timeout} ms`)));
      req.on('error', reject);
      req.end();
    });
  }

  /** Raw request; `mtls` presents the device certificate. Used for presigned PUTs (mtls=false). */
  raw(
    method: string,
    url: URL,
    body: Buffer | undefined,
    headers: Record<string, string>,
    mtls: boolean,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    assertSecureUrl(url);
    const creds = mtls ? this.opts.credentials?.() : undefined;
    const options: RequestOptions = {
      method,
      headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
      timeout: this.opts.timeoutMs ?? 30_000,
    };
    if (url.protocol === 'https:') {
      if (this.opts.ca) options.ca = this.opts.ca;
      if (creds) {
        options.key = creds.key;
        options.cert = creds.cert;
      }
    }
    const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = fn(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`timeout after ${options.timeout} ms`)));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
