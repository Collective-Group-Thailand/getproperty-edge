import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * D-230: getproperty's cloud on Collective's shared AWS platform. EMQX 8883 = mutual TLS with the getproperty device
 * CA (server certificate from `pnpm device:broker-cert --host <MQTT_HOST>`, `peer_cert_as_username = cn`, ACL from
 * `smart.mqtt_acl`, `deny_action = disconnect`); gateway HTTPS on Caddy's DEVICE_HOST. O-012: no WSS in R1.
 */
describe('platform TLS path (D-230, O-012)', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed({
      mqttHost: MQTT_HOST,
      // api D-231 omits wsUrl unless MQTT_PUBLIC_WS_URL is set; should one arrive, a gateway must not use it in R1
      mqttWsUrl: `wss://${MQTT_HOST}:${await closedPort()}/mqtt`,
      denyAction: 'disconnect',
    }).start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  it('verifies the broker certificate SAN against the bootstrap CA only; CN = client id, no username; ACL-clean', async () => {
    const ids = meterIds(3, '0192a000-0000-7000-8230');
    const { agent, gatewayId } = tb.agent();
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    const id = agent.identityStore.load()!;
    expect(id.mqttUrl).toBe(`mqtts://${MQTT_HOST}:${tb.broker.port}`);
    expect(id.caPem).toBe(tb.ca.certPem); // caChainPem of the bootstrap = the only trust anchor
    await waitFor(() => tb.broker.connectedClients().includes(`gw-${gatewayId}`));
    // EMQX takes username and client id from the certificate CN; the agent's own client id already equals it
    expect(tb.broker.sessions()).toContainEqual({
      cn: `gw-${gatewayId}`,
      clientId: `gw-${gatewayId}`,
      username: undefined,
    });

    // every topic the agent uses is inside the smart.mqtt_acl rows (deny_action = disconnect would cut it otherwise)
    await waitFor(() => ids.every((m) => tb.ingest.maxSeq(m) === 1), 15_000);
    await waitFor(() => tb.ingest.health.length >= 1);
    const cmdId = randomUUID();
    tb.broker.publish(
      `gp/v1/${gatewayId}/cmd`,
      JSON.stringify({ cmdId, type: 'read_now', args: {}, issuedAt: new Date().toISOString() }),
    );
    await waitFor(() => tb.ingest.acks.some((a) => a.cmdId === cmdId && a.status === 'done'));
    await waitFor(() => tb.ingest.events.some((e) => e.type === 'config_applied'));
    expect(tb.broker.stats.denied).toBe(0);
    expect(tb.broker.stats.connects).toBe(1);
    expect((agent.link as MqttLink).currentUrl.startsWith('mqtts://')).toBe(true);
    await agent.stop();
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
      await agent.stop();
    } finally {
      await foreign.kill();
    }
  });

  it('O-012: with 8883 unreachable the agent stays on mqtts (no WSS) unless GP_MQTT_WS_FALLBACK=on', async () => {
    const down = `mqtts://${MQTT_HOST}:${await closedPort()}`;
    const off = tb.agent({ env: { mqttUrlOverride: down } }).agent;
    await off.start();
    await sleep(2000); // ≫ 3 failed attempts at 50–300 ms backoff
    expect((off.link as MqttLink).currentUrl).toBe(down);
    await off.stop();

    const on = tb.agent({ env: { mqttUrlOverride: down, mqttWsFallback: true } }).agent;
    await on.start();
    await waitFor(() => (on.link as MqttLink).currentUrl.startsWith('wss://'), 10_000);
    expect(on.link!.connected).toBe(false);
    await on.stop();
  });
});
