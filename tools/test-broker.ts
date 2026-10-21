import { EventEmitter } from 'node:events';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createServer, type Server, type TLSSocket } from 'node:tls';

import mqttPacket, { type IConnectPacket, type IPublishPacket, type Packet } from 'mqtt-packet';
import { createWebSocketStream, WebSocketServer } from 'ws';

/** Where a CONNECT came from: EMQX `ssl:default` 8883 (mTLS) or `ws:default` 8083 behind Caddy (D-239). */
export type BrokerTransport = 'mtls' | 'ws';

export interface ConnectContext {
  transport: BrokerTransport;
  /** Client certificate CN (mtls only; null on ws — TLS ends at the proxy). */
  cn: string | null;
  clientId: string;
  username: string | undefined;
  password: string | undefined;
}

/** Authn verdict: the identity the ACL applies to, or a CONNACK reason code (0x86 bad credentials, 0x87 not authorised). */
export type AuthnResult = { identity: string } | { reasonCode: number };

/**
 * In-process MQTT 5 broker for integration tests (no Docker/EMQX here), shaped like the platform EMQX of device
 * protocol 1.2 (D-235, D-244): TLS with mandatory client certificates (mTLS) on the main port, an optional WebSocket
 * listener behind TLS without client certificates (`wss://…/mqtt`, D-239), a pluggable HTTP-authn stand-in
 * (`authenticate`: username / password = device JWT), the exact 1.2 ACL, QoS 0/1, retained messages, LWT, PUBACK reason
 * codes, and fault injection (kill/restart, lost PUBACKs).
 */
export interface TestBrokerOptions {
  key: string;
  cert: string;
  ca: string;
  port?: number;
  /**
   * WebSocket listener (`wss://<host>:<wsPort>/mqtt`): TLS with this certificate, no client certificate requested — the
   * platform's Caddy in front of EMQX ws 8083. Absent = no WebSocket listener.
   */
  ws?: { key: string; cert: string; port?: number };
  /**
   * The API's `POST /internal/emqx/authn` stand-in. Default: mtls → the certificate CN (no password check), ws → refused.
   */
  authenticate?: (ctx: ConnectContext) => AuthnResult;
  /**
   * What a denied PUBLISH gets: `puback` = PUBACK 0x87 (default), `disconnect` = the connection is closed like the
   * platform EMQX (`authorization.deny_action = disconnect`, D-230).
   */
  denyAction?: 'puback' | 'disconnect';
  /** Called for every authorised PUBLISH before PUBACK; returning a number ≥ 0x80 rejects it. */
  onPublish?: (cn: string, topic: string, payload: Buffer) => number | void;
}

interface Conn {
  socket: Duplex;
  /** The authenticated identity (the CN on mtls, the username on ws) — what the ACL is applied to. */
  cn: string;
  transport: BrokerTransport;
  clientId: string;
  username: string | undefined;
  password: string | undefined;
  subs: Set<string>;
  will: IConnectPacket['will'] | undefined;
  nextId: number;
  cleanClose: boolean;
}

export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** Protocol 1.2 ACL (D-244): gateways publish only to four explicit topics and subscribe only to config and cmd. */
export function aclAllows(cn: string, action: 'publish' | 'subscribe', topic: string): boolean {
  if (cn === 'ingest' || cn === 'cloud') return true;
  const m = /^gw-([0-9a-f-]{36})$/.exec(cn);
  if (!m) return false;
  const gw = m[1];
  const allowed = action === 'publish' ? ['telemetry', 'health', 'events', 'cmd/ack'] : ['config', 'cmd'];
  return allowed.some((s) => topic === `gp/v1/${gw}/${s}`);
}

const SERVICE_IDENTITY = /^gw-[0-9a-f-]{36}$|^ingest$|^cloud$/;

export class TestBroker extends EventEmitter {
  private server: Server | undefined;
  private wsHttps: HttpsServer | undefined;
  private wss: WebSocketServer | undefined;
  wsPort = 0;
  private readonly conns = new Set<Conn>();
  private readonly sockets = new Set<Socket>();
  readonly retained = new Map<string, Buffer>();
  port = 0;
  /** Probability [0..1] that a PUBACK is "lost": the connection is cut right after the message was accepted. */
  dropPubackProbability = 0;
  /** Only PUBACKs of topics matching this are dropped. */
  dropPubackTopic: RegExp = /./;
  random: () => number = Math.random;
  readonly stats = {
    connects: 0,
    wsConnects: 0,
    authDenied: 0,
    publishes: 0,
    pubacks: 0,
    denied: 0,
    droppedPubacks: 0,
    wills: 0,
  };
  /** Every CONNECT seen, accepted or not (password included — tests only). */
  readonly connectLog: Array<ConnectContext & { accepted: boolean; peerCert: boolean }> = [];

  constructor(private readonly o: TestBrokerOptions) {
    super();
  }

  async start(): Promise<number> {
    this.server = createServer(
      {
        key: this.o.key,
        cert: this.o.cert,
        ca: this.o.ca,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      (socket) => this.onSocket(socket),
    );
    this.server.on('tlsClientError', () => this.emit('tlsReject'));
    this.server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(this.o.port ?? this.port ?? 0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    if (this.o.ws) await this.startWs(this.o.ws);
    return this.port;
  }

  /** Caddy-like WSS front: TLS (no client certificate requested) + WebSocket upgrade on `/mqtt`, subprotocol `mqtt`. */
  private async startWs(o: NonNullable<TestBrokerOptions['ws']>): Promise<void> {
    this.wsHttps = createHttpsServer({ key: o.key, cert: o.cert, requestCert: false, minVersion: 'TLSv1.2' }, (_q, r) =>
      r.writeHead(404).end(),
    );
    this.wsHttps.on('tlsClientError', () => this.emit('tlsReject'));
    this.wsHttps.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.wss = new WebSocketServer({
      server: this.wsHttps,
      path: '/mqtt',
      handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false),
    });
    this.wss.on('connection', (ws, req) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate?.();
      const stream = createWebSocketStream(ws);
      this.onStream(stream, 'ws', null, !!peer && Object.keys(peer).length > 0);
    });
    await new Promise<void>((resolve) =>
      this.wsHttps!.listen(o.port ?? (this.wsPort || 0), '127.0.0.1', () => resolve()),
    );
    this.wsPort = (this.wsHttps.address() as AddressInfo).port;
  }

  /** Simulates a broker crash: every connection is cut (no DISCONNECT) and the ports closed. */
  async kill(): Promise<void> {
    const srv = this.server;
    const https = this.wsHttps;
    const wss = this.wss;
    this.server = undefined;
    this.wsHttps = undefined;
    this.wss = undefined;
    for (const s of this.sockets) s.destroy();
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
    if (https) await new Promise<void>((r) => https.close(() => r()));
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }

  /** Disconnects every session of this identity (e.g. the platform admin switched its WebSocket fallback off). */
  kick(identity: string): void {
    for (const c of this.conns) if (c.cn === identity) c.socket.destroy();
  }

  async restart(): Promise<void> {
    await this.kill();
    await this.start();
  }

  connectedClients(): string[] {
    return [...this.conns].map((c) => c.cn);
  }

  /** CONNECT identities as sent by the clients (EMQX on the platform takes the username and client id from the CN). */
  sessions(): Array<{ cn: string; clientId: string; username: string | undefined; transport: BrokerTransport }> {
    return [...this.conns].map((c) => ({
      cn: c.cn,
      clientId: c.clientId,
      username: c.username,
      transport: c.transport,
    }));
  }

  /** Publishes from the cloud side (config, commands). */
  publish(topic: string, payload: string | Buffer, opts: { retain?: boolean; qos?: 0 | 1 } = {}): void {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (opts.retain) {
      if (buf.length === 0) this.retained.delete(topic);
      else this.retained.set(topic, buf);
    }
    for (const c of this.conns) {
      if ([...c.subs].some((f) => topicMatches(f, topic))) this.deliver(c, topic, buf, opts.qos ?? 1, false);
    }
  }

  private send(c: Conn, p: Packet): void {
    if (c.socket.destroyed || !c.socket.writable) return;
    c.socket.write(mqttPacket.generate(p, { protocolVersion: 5 }));
  }

  private deliver(c: Conn, topic: string, payload: Buffer, qos: 0 | 1, retain: boolean): void {
    const p: IPublishPacket = { cmd: 'publish', topic, payload, qos, retain, dup: false };
    if (qos > 0) {
      c.nextId = (c.nextId % 65535) + 1;
      p.messageId = c.nextId;
    }
    this.send(c, p);
  }

  private onSocket(socket: TLSSocket): void {
    const peer = socket.getPeerCertificate();
    const cn = typeof peer.subject?.CN === 'string' ? peer.subject.CN : '';
    this.onStream(socket, 'mtls', cn, true);
  }

  private authenticate(ctx: ConnectContext): AuthnResult {
    if (this.o.authenticate) return this.o.authenticate(ctx);
    if (ctx.transport === 'ws' || !ctx.cn || !SERVICE_IDENTITY.test(ctx.cn)) return { reasonCode: 0x87 };
    return { identity: ctx.cn };
  }

  private onStream(socket: Duplex, transport: BrokerTransport, cn: string | null, peerCert: boolean): void {
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    let conn: Conn | undefined;
    const refuse = (reasonCode: number) => {
      socket.write(mqttPacket.generate({ cmd: 'connack', reasonCode, sessionPresent: false }, { protocolVersion: 5 }));
      socket.end();
      setTimeout(() => socket.destroy(), 50).unref();
    };
    parser.on('packet', (packet: Packet) => {
      if (!conn) {
        if (packet.cmd !== 'connect') return socket.destroy();
        const cp = packet;
        const password = cp.password === undefined ? undefined : Buffer.from(cp.password).toString();
        const ctx: ConnectContext = { transport, cn, clientId: cp.clientId, username: cp.username, password };
        const verdict = this.authenticate(ctx);
        this.connectLog.push({ ...ctx, accepted: 'identity' in verdict, peerCert });
        if (!('identity' in verdict)) {
          this.stats.authDenied++;
          return refuse(verdict.reasonCode);
        }
        for (const other of this.conns) if (other.clientId === cp.clientId) other.socket.destroy();
        conn = {
          socket,
          cn: verdict.identity,
          transport,
          clientId: cp.clientId,
          username: cp.username,
          password,
          subs: new Set(),
          will: cp.will,
          nextId: 0,
          cleanClose: false,
        };
        this.conns.add(conn);
        this.stats.connects++;
        if (transport === 'ws') this.stats.wsConnects++;
        this.send(conn, { cmd: 'connack', reasonCode: 0, sessionPresent: false });
        this.emit('clientConnected', conn.cn);
        return;
      }
      this.onPacket(conn, packet);
    });
    parser.on('error', () => socket.destroy());
    socket.on('data', (d: Buffer) => parser.parse(d));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (!conn) return;
      const was = this.conns.delete(conn);
      if (was && !conn.cleanClose && conn.will) {
        this.stats.wills++;
        const w = conn.will;
        this.o.onPublish?.(conn.cn, w.topic, w.payload as Buffer);
        this.publish(w.topic, w.payload, { retain: !!w.retain, qos: (w.qos ?? 0) as 0 | 1 });
      }
      this.emit('clientDisconnected', conn.cn);
    });
  }

  private onPacket(c: Conn, packet: Packet): void {
    switch (packet.cmd) {
      case 'publish': {
        this.stats.publishes++;
        const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
        // 1.2 (D-244): a gateway publishes QoS ≤ 1 and never retained, else denied like a foreign topic
        const gwRules = !/^gw-/.test(c.cn) || (!packet.retain && packet.qos <= 1);
        if (!gwRules || !aclAllows(c.cn, 'publish', packet.topic)) {
          this.stats.denied++;
          if (this.o.denyAction === 'disconnect') {
            this.send(c, { cmd: 'disconnect', reasonCode: 0x87 });
            c.socket.destroy();
            return;
          }
          if (packet.qos > 0) this.send(c, { cmd: 'puback', messageId: packet.messageId!, reasonCode: 0x87 });
          return;
        }
        const rc = this.o.onPublish?.(c.cn, packet.topic, payload);
        if (typeof rc === 'number' && rc >= 0x80) {
          if (packet.qos > 0) this.send(c, { cmd: 'puback', messageId: packet.messageId!, reasonCode: rc });
          return;
        }
        this.publish(packet.topic, payload, { retain: packet.retain, qos: packet.qos > 0 ? 1 : 0 });
        if (packet.qos > 0) {
          if (
            this.dropPubackProbability > 0 &&
            this.dropPubackTopic.test(packet.topic) &&
            this.random() < this.dropPubackProbability
          ) {
            this.stats.droppedPubacks++;
            c.socket.destroy();
            return;
          }
          this.stats.pubacks++;
          this.send(c, { cmd: 'puback', messageId: packet.messageId!, reasonCode: 0 });
        }
        return;
      }
      case 'subscribe': {
        const granted = packet.subscriptions.map((s) => {
          if (!aclAllows(c.cn, 'subscribe', s.topic)) return 0x87;
          c.subs.add(s.topic);
          return Math.min(s.qos, 1);
        });
        this.send(c, { cmd: 'suback', messageId: packet.messageId, granted });
        for (const s of packet.subscriptions) {
          if (!c.subs.has(s.topic)) continue;
          for (const [t, p] of this.retained) if (topicMatches(s.topic, t)) this.deliver(c, t, p, 1, true);
        }
        return;
      }
      case 'unsubscribe':
        for (const t of packet.unsubscriptions) c.subs.delete(t);
        this.send(c, { cmd: 'unsuback', messageId: packet.messageId, granted: [] } as unknown as Packet);
        return;
      case 'pingreq':
        this.send(c, { cmd: 'pingresp' });
        return;
      case 'disconnect':
        c.cleanClose = true;
        c.socket.end();
        return;
      default:
        return; // puback from clients for our QoS 1 deliveries, etc.
    }
  }
}
