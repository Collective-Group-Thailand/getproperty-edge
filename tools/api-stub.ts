import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  /**
   * `MQTT_PUBLIC_WS_URL`: the bootstrap answer carries it as `mqtt.wsUrl` only for a gateway whose WebSocket fallback
   * the platform admin enabled (`wsFallback`, D-239).
   */
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
  /** Lifetime of issued device JWTs (`DEVICE_ACCESS_TOKEN_TTL_SECONDS`, ≤ 1 h on the platform). */
  tokenTtlMs = 900_000;
  /** The next N `POST /v1/device/token` calls answer 503 (API outage). */
  tokenOutages = 0;
  /** Gateways whose `smart.device.mqtt_ws_fallback` is on (D-239). */
  readonly wsFallback = new Set<string>();
  /** Retired / revoked gateways: no tokens, every token of theirs invalid. */
  readonly retired = new Set<string>();
  /** Individual tokens whose session was revoked. */
  readonly revokedTokens = new Set<string>();
  /** Every device JWT issued, in order. */
  readonly issued: Array<{ gatewayId: string; token: string; exp: number }> = [];
  private readonly jwtKey = randomBytes(32);

  constructor(private readonly o: ApiStubOptions) {}

  get baseUrl(): string {
    return `https://127.0.0.1:${this.port}`;
  }

  addCode(code: string, gatewayId: string = randomUUID(), opts: { wsFallback?: boolean } = {}): string {
    this.codes.set(code, gatewayId);
    if (opts.wsFallback) this.wsFallback.add(gatewayId);
    return gatewayId;
  }

  /**
   * `mqtt { url, wsUrl? }` as the API computes it (`mqttEndpointOf`, D-239 / D-249): `wsUrl` only while the gateway's
   * fallback is on and `MQTT_PUBLIC_WS_URL` is set. Shared by the bootstrap and the token answers.
   */
  mqttEndpoints(gatewayId: string): { url: string; wsUrl?: string } {
    return this.o.mqttWsUrl && this.wsFallback.has(gatewayId)
      ? { url: this.o.mqttUrl, wsUrl: this.o.mqttWsUrl }
      : { url: this.o.mqttUrl };
  }

  /** A device JWT (HS256, `aud=device`, `sub` = gatewayId) like `POST /v1/device/token`. */
  issueToken(gatewayId: string): { accessToken: string; expiresAt: string } {
    const exp = Date.now() + this.tokenTtlMs;
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      aud: 'device',
      sub: gatewayId,
      jti: `t${++this.tokenSeq}`,
      exp: exp / 1000,
    })}`;
    const token = `${body}.${createHmac('sha256', this.jwtKey).update(body).digest('base64url')}`;
    this.issued.push({ gatewayId, token, exp });
    return { accessToken: token, expiresAt: new Date(exp).toISOString() };
  }

  /** The EMQX authn check of the API: signature, `aud=device`, unexpired, session not revoked → the gateway id. */
  verifyToken(token: string | undefined): string | null {
    if (!token || this.revokedTokens.has(token)) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const sig = createHmac('sha256', this.jwtKey).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2]!, 'base64url');
    if (given.length !== sig.length || !timingSafeEqual(given, sig)) return null;
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as {
      aud?: string;
      sub?: string;
      exp?: number;
    };
    if (claims.aud !== 'device' || typeof claims.sub !== 'string' || !claims.exp || claims.exp * 1000 <= Date.now())
      return null;
    return this.retired.has(claims.sub) ? null : claims.sub;
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
        const login = `gw-${gw}`;
        return this.json(res, 201, {
          gatewayId: gw,
          deviceId: gw,
          certificatePem,
          caChainPem: this.o.ca.certPem,
          mqtt: {
            ...this.mqttEndpoints(gw),
            clientId: login,
            username: login,
            password: 'device_jwt',
            acl: [
              ...['telemetry', 'health', 'events', 'cmd/ack'].map((t) => ({
                action: 'publish',
                topic: `gp/v1/${gw}/${t}`,
              })),
              ...['config', 'cmd'].map((t) => ({ action: 'subscribe', topic: `gp/v1/${gw}/${t}` })),
            ],
          },
          deviceToken: this.issueToken(gw),
        });
      }
      const cn = this.clientCn(req);
      if (url.pathname.startsWith('/v1/device/') && !cn) return this.problem(res, 401, 'auth.unauthenticated');
      if (req.method === 'POST' && url.pathname === '/v1/device/token') {
        if (this.tokenOutages > 0) {
          this.tokenOutages--;
          return this.problem(res, 503, 'service_unavailable');
        }
        const gw = cn!.replace(/^gw-/, '');
        if (this.retired.has(gw)) return this.problem(res, 401, 'auth.unauthenticated');
        // api D-249 (CR-015): the current MQTT endpoints of this gateway with every token
        return this.json(res, 200, { ...this.issueToken(gw), mqtt: this.mqttEndpoints(gw) });
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
