import { EventEmitter } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { createServer, type Server, type TLSSocket } from 'node:tls';

import mqttPacket, { type IConnectPacket, type IPublishPacket, type Packet } from 'mqtt-packet';

/**
 * In-process MQTT 5 broker for integration tests (no Docker/EMQX here): TLS with mandatory client
 * certificates (mTLS), the protocol §1 ACL derived from the certificate CN, QoS 0/1, retained
 * messages, LWT, PUBACK reason codes, and fault injection (kill/restart, lost PUBACKs).
 */
export interface TestBrokerOptions {
  key: string;
  cert: string;
  ca: string;
  port?: number;
  /** Called for every authorised PUBLISH before PUBACK; returning a number ≥ 0x80 rejects it. */
  onPublish?: (cn: string, topic: string, payload: Buffer) => number | void;
}

interface Conn {
  socket: TLSSocket;
  cn: string;
  clientId: string;
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

/** Protocol §1 ACL: gateways publish only to `gp/v1/<id>/+` and, explicitly, `gp/v1/<id>/cmd/ack` (CR-006). */
export function aclAllows(cn: string, action: 'publish' | 'subscribe', topic: string): boolean {
  if (cn === 'ingest' || cn === 'cloud') return true;
  const m = /^gw-([0-9a-f-]{36})$/.exec(cn);
  if (!m) return false;
  const gw = m[1];
  if (action === 'publish') return topicMatches(`gp/v1/${gw}/+`, topic) || topic === `gp/v1/${gw}/cmd/ack`;
  return topic === `gp/v1/${gw}/config` || topic === `gp/v1/${gw}/cmd`;
}

export class TestBroker extends EventEmitter {
  private server: Server | undefined;
  private readonly conns = new Set<Conn>();
  private readonly sockets = new Set<Socket>();
  readonly retained = new Map<string, Buffer>();
  port = 0;
  /** Probability [0..1] that a PUBACK is "lost": the connection is cut right after the message was accepted. */
  dropPubackProbability = 0;
  /** Only PUBACKs of topics matching this are dropped. */
  dropPubackTopic: RegExp = /./;
  random: () => number = Math.random;
  readonly stats = { connects: 0, publishes: 0, pubacks: 0, denied: 0, droppedPubacks: 0, wills: 0 };

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
    return this.port;
  }

  /** Simulates a broker crash: every connection is cut (no DISCONNECT) and the port closed. */
  async kill(): Promise<void> {
    const srv = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    this.conns.clear();
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }

  async restart(): Promise<void> {
    await this.kill();
    await this.start();
  }

  connectedClients(): string[] {
    return [...this.conns].map((c) => c.cn);
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
    if (!c.socket.destroyed) c.socket.write(mqttPacket.generate(p, { protocolVersion: 5 }));
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
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    let conn: Conn | undefined;
    parser.on('packet', (packet: Packet) => {
      if (!conn) {
        if (packet.cmd !== 'connect') return socket.destroy();
        const cp = packet;
        if (!/^gw-[0-9a-f-]{36}$|^ingest$|^cloud$/.test(cn)) {
          socket.write(
            mqttPacket.generate({ cmd: 'connack', reasonCode: 0x87, sessionPresent: false }, { protocolVersion: 5 }),
          );
          return socket.destroy();
        }
        for (const other of this.conns) if (other.clientId === cp.clientId) other.socket.destroy();
        conn = { socket, cn, clientId: cp.clientId, subs: new Set(), will: cp.will, nextId: 0, cleanClose: false };
        this.conns.add(conn);
        this.stats.connects++;
        this.send(conn, { cmd: 'connack', reasonCode: 0, sessionPresent: false });
        this.emit('clientConnected', cn);
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
        if (!aclAllows(c.cn, 'publish', packet.topic)) {
          this.stats.denied++;
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
