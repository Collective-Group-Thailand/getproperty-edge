import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import type { TelemetryBatch } from '../src/protocol/types.js';
import { assertValid } from '../src/protocol/validate.js';
import type { IngestStub } from './ingest-stub.js';
import { signCsr, type TestCa } from './pki.js';

/**
 * Local stand-in for getproperty-api's `/v1/device/*` surface (contract requests CR-001…CR-004 + the
 * documented readings fallback and OTA manifest): bootstrap with one-time codes signed by the test CA,
 * device tokens, certificate renewal, HTTPS readings fallback, log presign/upload, OTA files.
 */
export interface ApiStubOptions {
  ca: TestCa;
  server: { certPem: string; keyPem: string };
  mqttUrl: string;
  /** `mqtt.wsUrl` of the bootstrap answer — the real api sends one only when MQTT_PUBLIC_WS_URL is set (D-231). */
  mqttWsUrl?: string;
  ingest?: IngestStub;
  /** Validity of issued device certificates. */
  certDays?: number;
  certNotBefore?: () => Date;
}

export class ApiStub {
  private srv: Server | undefined;
  port = 0;
  readonly codes = new Map<string, string>(); // code → gatewayId
  readonly usedCodes = new Set<string>();
  readonly uploads = new Map<string, Buffer>();
  readonly files = new Map<string, { body: Buffer; type: string }>();
  readonly calls: string[] = [];
  /** Latest compiled config per gateway (`GET /v1/device/config`, protocol §6). */
  readonly configs = new Map<string, unknown>();
  readingsDown = false;
  tokenSeq = 0;

  constructor(private readonly o: ApiStubOptions) {}

  get baseUrl(): string {
    return `https://127.0.0.1:${this.port}`;
  }

  addCode(code: string, gatewayId: string = randomUUID()): string {
    this.codes.set(code, gatewayId);
    return gatewayId;
  }

  async start(): Promise<number> {
    this.srv = createServer(
      {
        key: this.o.server.keyPem,
        cert: this.o.server.certPem,
        ca: this.o.ca.certPem,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => void this.handle(req, res),
    );
    await new Promise<void>((r) => this.srv!.listen(0, '127.0.0.1', r));
    this.port = (this.srv.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    this.srv?.closeAllConnections();
    await new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()));
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' });
    res.end(JSON.stringify(body));
  }

  private problem(res: ServerResponse, status: number, code: string): void {
    this.json(res, status, { type: `https://getproperty.co/problems/${code}`, title: code, status, code });
  }

  private clientCn(req: IncomingMessage): string | null {
    const s = req.socket as TLSSocket;
    if (!s.authorized) return null;
    const cn = s.getPeerCertificate().subject?.CN;
    return typeof cn === 'string' ? cn : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    this.calls.push(`${req.method} ${url.pathname}`);
    const body = await read(req);
    try {
      if (req.method === 'POST' && url.pathname === '/v1/device/bootstrap') {
        const b = JSON.parse(body.toString()) as { provisioningCode?: string; csrPem?: string };
        const gw = b.provisioningCode ? this.codes.get(b.provisioningCode) : undefined;
        if (!gw || this.usedCodes.has(b.provisioningCode!))
          return this.problem(res, 401, 'device.provisioning_code_invalid');
        this.usedCodes.add(b.provisioningCode!);
        const certificatePem = await signCsr(this.o.ca, b.csrPem ?? '', gw, {
          days: this.o.certDays ?? 365,
          ...(this.o.certNotBefore ? { notBefore: this.o.certNotBefore() } : {}),
        });
        return this.json(res, 201, {
          gatewayId: gw,
          certificatePem,
          caChainPem: this.o.ca.certPem,
          mqtt: { url: this.o.mqttUrl, ...(this.o.mqttWsUrl ? { wsUrl: this.o.mqttWsUrl } : {}) },
          deviceToken: {
            accessToken: `tok-${++this.tokenSeq}`,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        });
      }
      const cn = this.clientCn(req);
      if (url.pathname.startsWith('/v1/device/') && !cn) return this.problem(res, 401, 'auth.unauthenticated');
      if (req.method === 'POST' && url.pathname === '/v1/device/token') {
        return this.json(res, 200, {
          accessToken: `tok-${++this.tokenSeq}`,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/device/certificate/renew') {
        const b = JSON.parse(body.toString()) as { csrPem: string };
        const gw = cn!.replace(/^gw-/, '');
        return this.json(res, 200, {
          certificatePem: await signCsr(this.o.ca, b.csrPem, gw, { days: this.o.certDays ?? 365 }),
          caChainPem: this.o.ca.certPem,
          notAfter: new Date(Date.now() + (this.o.certDays ?? 365) * 86_400_000).toISOString(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/device/readings/batch') {
        if (this.readingsDown) return this.problem(res, 503, 'service_unavailable');
        const batch: TelemetryBatch = assertValid('TelemetryBatch', JSON.parse(body.toString()));
        if (`gw-${batch.gatewayId}` !== cn) return this.problem(res, 422, 'device.invalid_payload');
        const before = { a: this.o.ingest?.accepted ?? 0, d: this.o.ingest?.duplicates ?? 0 };
        this.o.ingest?.telemetry(batch);
        return this.json(res, 200, {
          accepted: this.o.ingest ? this.o.ingest.accepted - before.a : batch.readings.length,
          duplicates: this.o.ingest ? this.o.ingest.duplicates - before.d : 0,
          rejected: [],
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/device/config') {
        const cfg = this.configs.get(cn!.replace(/^gw-/, ''));
        return cfg ? this.json(res, 200, cfg) : this.problem(res, 404, 'device.config_not_found');
      }
      if (req.method === 'POST' && url.pathname === '/v1/device/logs/presign') {
        const id = randomUUID();
        return this.json(res, 200, {
          fileId: id,
          uploadUrl: `${this.baseUrl}/upload/${id}`,
          method: 'PUT',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
        this.uploads.set(url.pathname.slice('/upload/'.length), body);
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'GET' && (this.files.has(url.pathname + url.search) || this.files.has(url.pathname))) {
        const f = (this.files.get(url.pathname + url.search) ?? this.files.get(url.pathname))!;
        res.writeHead(200, { 'content-type': f.type, 'content-length': String(f.body.length) });
        res.end(f.body);
        return;
      }
      return this.problem(res, 404, 'not_found');
    } catch (err) {
      return this.json(res, 400, { title: (err as Error).message, status: 400 });
    }
  }
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
