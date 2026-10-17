import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from '../util/logger.js';
import { renderStatusPage, type StatusView, STYLE_HASH } from './render.js';

export interface StatusPageOptions {
  host: string;
  port: number;
  view: () => Promise<StatusView>;
  /** Accepts a one-time provisioning code; only offered while the gateway is not provisioned. */
  submitCode: (code: string) => boolean;
  provisioned: () => boolean;
  logger: Logger;
  /** Requests per minute per client address. */
  ratePerMinute?: number;
}

const SECURITY_HEADERS = {
  'content-security-policy': `default-src 'none'; style-src '${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/**
 * LAN status page on :8080 — read-only: meters, last reads, queue depth, config version, link, agent
 * version. The only write is the one-time provisioning code, accepted only while unprovisioned.
 * Exposes no secrets (no keys, tokens, codes or certificates); rate-limited per client.
 */
export class StatusPageServer {
  private server: Server | undefined;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private flash: string | undefined;

  constructor(private readonly o: StatusPageOptions) {}

  async start(): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.o.port, this.o.host, () => resolve());
    });
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections();
  }

  private allow(ip: string): boolean {
    const rate = this.o.ratePerMinute ?? 60;
    const now = Date.now();
    const b = this.buckets.get(ip) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate);
    b.at = now;
    if (this.buckets.size > 1000) this.buckets.clear();
    this.buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private send(
    res: ServerResponse,
    status: number,
    type: string,
    body: string,
    extra: Record<string, string> = {},
  ): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.allow(req.socket.remoteAddress ?? '?'))
        return this.send(res, 429, 'text/plain; charset=utf-8', 'Too many requests\n', { 'retry-after': '10' });
      const url = new URL(req.url ?? '/', 'http://gateway.local');
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname === '/') {
          const flash = this.flash;
          this.flash = undefined;
          return this.send(res, 200, 'text/html; charset=utf-8', renderStatusPage(await this.o.view(), flash));
        }
        if (url.pathname === '/status.json')
          return this.send(res, 200, 'application/json', JSON.stringify(await this.o.view(), null, 2));
        if (url.pathname === '/healthz') return this.send(res, 200, 'text/plain; charset=utf-8', 'ok\n');
        return this.send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
      }
      if (req.method === 'POST' && url.pathname === '/provision') {
        if (this.o.provisioned()) return this.send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
        const body = await readBody(req, 1024);
        const code = new URLSearchParams(body).get('code') ?? '';
        const ok = this.o.submitCode(code);
        this.o.logger.info({ accepted: ok }, 'provisioning code submitted on the status page');
        this.flash = ok ? 'Code received — registering…' : 'That does not look like a provisioning code.';
        res.writeHead(303, { ...SECURITY_HEADERS, location: '/' });
        return void res.end();
      }
      return this.send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed\n', { allow: 'GET, HEAD' });
    } catch (err) {
      this.o.logger.warn({ err: (err as Error).message }, 'status page error');
      if (!res.headersSent) this.send(res, 500, 'text/plain; charset=utf-8', 'Error\n');
    }
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
