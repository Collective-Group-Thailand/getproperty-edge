import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Health } from '../../src/protocol/types.js';
import type { MqttLink } from '../../src/transport/mqtt/mqtt-link.js';
import { createTestCa, issueBrokerCert } from '../../tools/pki.js';
import { TestBroker } from '../../tools/test-broker.js';
import { meterIds, simConfig, Testbed, waitFor } from '../../tools/testbed.js';

const MQTT_HOST = 'mqtt.getproperty.test';

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const linkOf = (a: { link: unknown }) => a.link as MqttLink;

/**
 * D-230 + device protocol 1.2 (D-235, D-239, D-244): EMQX 8883 = mutual TLS with the getproperty device CA (server
 * certificate from `pnpm device:broker-cert --host <MQTT_HOST>`) **plus** the API's HTTP authn — CN `gw-<id>` = username
 * = client id and the gateway's own device JWT as password (`mqtt.authn.require_device_jwt` on) — and the exact ACL
 * (`deny_action = disconnect`); the per-gateway WebSocket fallback `wss://<MQTT_HOST>/mqtt` with the JWT alone.
 */
describe('platform TLS path and protocol 1.2 login (D-230, D-244)', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed({ mqttHost: MQTT_HOST, ws: true, denyAction: 'disconnect' }).start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  it('logs in with CN = client id = username and its own device JWT; bootstrap ACL stored; ACL-clean', async () => {
    const ids = meterIds(3, '0192a000-0000-7000-8230');
    const { agent, gatewayId } = tb.agent();
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    const id = agent.identityStore.load()!;
    expect(id.mqttUrl).toBe(`mqtts://${MQTT_HOST}:${tb.broker.port}`);
    expect(id.caPem).toBe(tb.ca.certPem); // caChainPem of the bootstrap = the only trust anchor
    expect(id.mqttWsUrl).toBeUndefined(); // fallback not enabled for this gateway by the platform admin
    expect(id.mqttAcl).toEqual({ publish: ['telemetry', 'health', 'events', 'cmd/ack'], subscribe: ['config', 'cmd'] });
    await waitFor(() => tb.broker.connectedClients().includes(`gw-${gatewayId}`));
    expect(tb.broker.sessions()).toContainEqual({
      cn: `gw-${gatewayId}`,
      clientId: `gw-${gatewayId}`,
      username: `gw-${gatewayId}`,
      transport: 'mtls',
    });
    const login = tb.broker.connectLog.filter((c) => c.clientId === `gw-${gatewayId}`);
    expect(login).toHaveLength(1);
    expect(login[0]!.peerCert).toBe(true);
    expect(tb.api.verifyToken(login[0]!.password)).toBe(gatewayId);

    // every topic the agent uses is inside the 1.2 ACL (deny_action = disconnect would cut it otherwise)
    await waitFor(() => ids.every((m) => tb.ingest.maxSeq(m) === 1), 15_000);
    // meters[] stays on the wire (contract 1.2; the api derives meter_status_changed from it, T-13)
    await agent.health!.publish();
    await waitFor(() =>
      tb.ingest.health.some((h) => (h as Health).gatewayId === gatewayId && (h as Health).meters.length === 3),
    );
    const cmdId = randomUUID();
    tb.broker.publish(
      `gp/v1/${gatewayId}/cmd`,
      JSON.stringify({ cmdId, type: 'read_now', args: {}, issuedAt: new Date().toISOString() }),
    );
    await waitFor(() => tb.ingest.acks.some((a) => a.cmdId === cmdId && a.status === 'done'));
    await waitFor(() => tb.ingest.events.some((e) => e.type === 'config_applied'));
    expect(tb.broker.stats.denied).toBe(0);
    expect(tb.broker.stats.connects).toBe(1);
    expect(linkOf(agent).transport).toBe('mtls');
    // a fifth topic is refused by the link itself — it never reaches the broker
    const publishes = tb.broker.stats.publishes;
    await expect(agent.link!.publish('config', '{}')).rejects.toThrow(/not in the gateway ACL/);
    expect(tb.broker.stats.publishes).toBe(publishes);
    expect(agent.link!.connected).toBe(true);
    await agent.stop();
  });

  it('the broker refuses a login without the JWT, with another gateway’s JWT, or with a foreign username', async () => {
    const { agent, gatewayId } = tb.agent();
    await agent.start();
    const creds = agent.identityStore.credentials()!;
    await agent.stop();
    const other = randomUUID();
    const base = {
      protocolVersion: 5 as const,
      key: creds.key,
      cert: creds.cert,
      ca: creds.ca,
      servername: MQTT_HOST,
      reconnectPeriod: 0,
      connectTimeout: 3000,
    };
    const url = `mqtts://127.0.0.1:${tb.broker.port}`;
    const tryLogin = (o: { clientId: string; username?: string; password?: string }) =>
      mqtt.connectAsync(url, { ...base, ...o }).then(
        async (c) => {
          await c.endAsync();
          return 'connected';
        },
        (err: Error & { code?: number }) => err.code ?? err.message,
      );
    const gw = `gw-${gatewayId}`;
    expect(await tryLogin({ clientId: gw, username: gw })).toBe(0x86); // require_device_jwt on (default)
    expect(await tryLogin({ clientId: gw, username: gw, password: tb.api.issueToken(other).accessToken })).toBe(0x86);
    expect(await tryLogin({ clientId: gw, username: gw, password: 'not-a-jwt' })).toBe(0x86);
    expect(
      await tryLogin({
        clientId: `gw-${other}`,
        username: `gw-${other}`,
        password: tb.api.issueToken(other).accessToken,
      }),
    ).toBe(0x87); // CN ≠ username
    expect(await tryLogin({ clientId: gw, username: gw, password: tb.api.issueToken(gatewayId).accessToken })).toBe(
      'connected',
    );
    tb.requireDeviceJwt = false; // the transition setting (audited) — certificate alone accepted
    try {
      expect(await tryLogin({ clientId: gw, username: gw })).toBe('connected');
    } finally {
      tb.requireDeviceJwt = true;
    }
  });

  it('ACL 1.2: a fifth topic, a retained publish or a foreign subscription disconnects the gateway', async () => {
    const { agent, gatewayId } = tb.agent();
    await agent.start();
    const creds = agent.identityStore.credentials()!;
    await agent.stop();
    const gw = `gw-${gatewayId}`;
    const connect = () =>
      mqtt.connectAsync(`mqtts://127.0.0.1:${tb.broker.port}`, {
        protocolVersion: 5,
        clientId: gw,
        username: gw,
        password: tb.api.issueToken(gatewayId).accessToken,
        key: creds.key,
        cert: creds.cert,
        ca: creds.ca,
        servername: MQTT_HOST,
        reconnectPeriod: 0,
      });
    const cut = async (act: (c: mqtt.MqttClient) => Promise<unknown>) => {
      const c = await connect();
      const closed = new Promise<void>((r) => c.once('close', () => r()));
      void act(c).catch(() => undefined);
      await closed;
      c.end(true);
    };
    const denied = tb.broker.stats.denied;
    for (const suffix of ['config', 'cmd', 'status', 'telemetry/x'])
      await cut((c) => c.publishAsync(`gp/v1/${gatewayId}/${suffix}`, '{}', { qos: 1 }));
    await cut((c) => c.publishAsync(`gp/v1/${gatewayId}/health`, '{}', { qos: 1, retain: true }));
    expect(tb.broker.stats.denied).toBe(denied + 5);
    // the four publish topics stay allowed
    const ok = await connect();
    for (const suffix of ['telemetry', 'health', 'events', 'cmd/ack'])
      await expect(ok.publishAsync(`gp/v1/${gatewayId}/${suffix}`, '{}', { qos: 1 })).resolves.toBeDefined();
    await expect(ok.subscribeAsync(`gp/v1/${gatewayId}/telemetry`, { qos: 1 })).rejects.toThrow(/Not authorized/i);
    await ok.endAsync();
    expect(tb.broker.stats.denied).toBe(denied + 5);
  });

  it('a refused login makes the agent fetch a new device JWT and reconnect', async () => {
    const { agent, gatewayId } = tb.agent();
    await agent.start();
    const gw = `gw-${gatewayId}`;
    await waitFor(() => tb.broker.connectedClients().includes(gw));
    const first = tb.broker.connectLog.filter((c) => c.clientId === gw).at(-1)!.password!;
    tb.api.revokedTokens.add(first); // session revoked on the API: the cached token no longer logs in
    tb.broker.kick(gw);
    await waitFor(() => tb.broker.connectLog.filter((c) => c.clientId === gw && c.accepted).length === 2, 10_000);
    const log = tb.broker.connectLog.filter((c) => c.clientId === gw);
    expect(log.some((c) => !c.accepted && c.password === first)).toBe(true);
    const last = log.at(-1)!;
    expect(last.password).not.toBe(first);
    expect(tb.api.verifyToken(last.password)).toBe(gatewayId);
    await agent.stop();
  });

  it('rotates the device JWT before it expires: graceful reconnect, no LWT, nothing lost', async () => {
    const ttl = tb.api.tokenTtlMs;
    tb.api.tokenTtlMs = 4000;
    try {
      const ids = meterIds(2, '0192a000-0000-7000-8231');
      const { agent, gatewayId } = tb.agent({ mqtt: { rotateLeadMs: 1000, rotateJitterMs: 0 } });
      tb.pushConfig(gatewayId, simConfig(ids));
      const gw = `gw-${gatewayId}`;
      const lwt0 = tb.ingest.lwt;
      await agent.start();
      await waitFor(() => tb.broker.connectLog.filter((c) => c.clientId === gw && c.accepted).length >= 3, 15_000);
      const logins = tb.broker.connectLog.filter((c) => c.clientId === gw);
      expect(logins.every((c) => c.accepted)).toBe(true); // rotated before expiry — never refused
      expect(new Set(logins.map((c) => c.password)).size).toBe(logins.length);
      expect(tb.ingest.lwt).toBe(lwt0); // DISCONNECT before each rotation: the broker sends no LWT
      expect(linkOf(agent).passwordExpiresAt).toBeGreaterThan(Date.now());
      await waitFor(() => ids.every((m) => tb.ingest.maxSeq(m) === 1), 10_000);
      await waitFor(() => agent.queue.metrics().depth === 0, 10_000);
      await agent.stop();
    } finally {
      tb.api.tokenTtlMs = ttl;
    }
  });

  it('keeps the live session when the token endpoint is down at rotation time, rotates once it is back', async () => {
    const ttl = tb.api.tokenTtlMs;
    tb.api.tokenTtlMs = 3000;
    try {
      const { agent, gatewayId } = tb.agent({ mqtt: { rotateLeadMs: 1000, rotateJitterMs: 0 } });
      const gw = `gw-${gatewayId}`;
      await agent.start();
      await waitFor(() => tb.broker.connectedClients().includes(gw));
      tb.api.tokenOutages = 1_000;
      await sleep(4500); // past the rotation time and the token's expiry
      expect(agent.link!.connected).toBe(true);
      expect(tb.broker.connectLog.filter((c) => c.clientId === gw)).toHaveLength(1);
      tb.api.tokenOutages = 0;
      await waitFor(() => tb.broker.connectLog.filter((c) => c.clientId === gw && c.accepted).length >= 2, 10_000);
      expect(agent.link!.connected).toBe(true);
      await agent.stop();
    } finally {
      tb.api.tokenTtlMs = ttl;
      tb.api.tokenOutages = 0;
    }
  });

  it('a broker name that is not in the certificate SAN is refused (hostname verification)', async () => {
    const connects = tb.broker.stats.connects;
    const { agent } = tb.agent({ env: { mqttUrlOverride: `mqtts://other.getproperty.test:${tb.broker.port}` } });
    await agent.start();
    await sleep(1500);
    expect(agent.link!.connected).toBe(false);
    expect(tb.broker.stats.connects).toBe(connects);
    await agent.stop();
  });

  it('a broker certificate from another CA (e.g. a public one) is refused even with the right name', async () => {
    const other = await createTestCa('some public CA');
    const cert = await issueBrokerCert(other, MQTT_HOST);
    const foreign = new TestBroker({ key: cert.keyPem, cert: cert.chainPem, ca: tb.ca.certPem });
    const port = await foreign.start();
    try {
      const { agent } = tb.agent({ env: { mqttUrlOverride: `mqtts://${MQTT_HOST}:${port}` } });
      await agent.start();
      await sleep(1500);
      expect(agent.link!.connected).toBe(false);
      expect(foreign.stats.connects).toBe(0);
      expect(foreign.connectLog).toHaveLength(0); // TLS failed before CONNECT: the JWT never left the gateway
      await agent.stop();
    } finally {
      await foreign.kill();
    }
  });
});

/** D-239 (O-012 resolved): per-gateway WebSocket fallback, TLS ending at Caddy, device JWT only. */
describe('WebSocket fallback (D-239)', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed({ mqttHost: MQTT_HOST, ws: true, denyAction: 'disconnect' }).start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  it('enabled by the API and GP_MQTT_WS_FALLBACK=on: 8883 blocked → WSS with the JWT alone; readings delivered', async () => {
    const down = `mqtts://${MQTT_HOST}:${await closedPort()}`;
    const ids = meterIds(2, '0192a000-0000-7000-8239');
    const { agent, gatewayId } = tb.agent({ wsFallback: true, env: { mqttUrlOverride: down, mqttWsFallback: true } });
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    const gw = `gw-${gatewayId}`;
    expect(agent.identityStore.load()!.mqttWsUrl).toBe(`wss://${MQTT_HOST}:${tb.broker.wsPort}/mqtt`);
    await waitFor(() => agent.link!.connected, 15_000);
    expect(linkOf(agent).transport).toBe('wss');
    expect((await agent.statusView()).link.transport).toBe('wss');
    const ws = tb.broker.connectLog.filter((c) => c.clientId === gw && c.transport === 'ws');
    expect(ws).toHaveLength(1);
    expect(ws[0]!.peerCert).toBe(false); // no client certificate on this path
    expect(ws[0]!.username).toBe(gw);
    expect(tb.api.verifyToken(ws[0]!.password)).toBe(gatewayId);
    expect(tb.broker.sessions()).toContainEqual({ cn: gw, clientId: gw, username: gw, transport: 'ws' });
    await waitFor(() => ids.every((m) => tb.ingest.maxSeq(m) === 1), 15_000);
    await waitFor(() => tb.ingest.events.some((e) => e.gatewayId === gatewayId && e.type === 'config_applied'));
    expect(tb.broker.stats.denied).toBe(0);

    // the platform admin switches the fallback off: the next WebSocket login is refused, the agent goes back to
    // 8883 (still blocked) and never connects any other way — readings stay queued
    tb.api.wsFallback.delete(gatewayId);
    const denied = tb.broker.stats.authDenied;
    tb.broker.kick(gw);
    await waitFor(() => tb.broker.stats.authDenied >= denied + 3, 15_000);
    await waitFor(() => linkOf(agent).transport === 'mtls', 15_000);
    await sleep(500);
    expect(agent.link!.connected).toBe(false);
    expect(tb.broker.connectLog.filter((c) => c.clientId === gw && c.accepted)).toHaveLength(1);
    await agent.stop();
  });

  it('API enabled it but GP_MQTT_WS_FALLBACK is off → 8883 only', async () => {
    const down = `mqtts://${MQTT_HOST}:${await closedPort()}`;
    const { agent, gatewayId } = tb.agent({ wsFallback: true, env: { mqttUrlOverride: down } });
    await agent.start();
    expect(agent.identityStore.load()!.mqttWsUrl).toBeDefined();
    await sleep(2000); // ≫ 3 failed attempts at 50–300 ms backoff
    expect(linkOf(agent).currentUrl).toBe(down);
    expect(tb.broker.connectLog.some((c) => c.clientId === `gw-${gatewayId}`)).toBe(false);
    await agent.stop();
  });

  it('GP_MQTT_WS_FALLBACK=on but the API did not enable it (no wsUrl) → 8883 only', async () => {
    const down = `mqtts://${MQTT_HOST}:${await closedPort()}`;
    const { agent, gatewayId } = tb.agent({ env: { mqttUrlOverride: down, mqttWsFallback: true } });
    await agent.start();
    expect(agent.identityStore.load()!.mqttWsUrl).toBeUndefined();
    await sleep(2000);
    expect(linkOf(agent).currentUrl).toBe(down);
    expect(tb.broker.connectLog.some((c) => c.clientId === `gw-${gatewayId}`)).toBe(false);
    await agent.stop();
  });

  it('a WSS endpoint whose certificate does not chain to the bootstrap CA fails closed', async () => {
    const foreign = await new Testbed({ mqttHost: MQTT_HOST, ws: 'foreign' }).start();
    try {
      const down = `mqtts://${MQTT_HOST}:${await closedPort()}`;
      const { agent } = foreign.agent({ wsFallback: true, env: { mqttUrlOverride: down, mqttWsFallback: true } });
      await agent.start();
      await waitFor(() => linkOf(agent).transport === 'wss', 10_000);
      await sleep(1500);
      expect(agent.link!.connected).toBe(false);
      expect(foreign.broker.connectLog).toHaveLength(0); // TLS refused before CONNECT: the JWT never left the gateway
      await agent.stop();
    } finally {
      await foreign.stop();
    }
  });
});
