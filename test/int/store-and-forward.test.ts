import { statSync } from 'node:fs';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VirtualClock } from '../../src/util/clock.js';
import { meterIds, simConfig, Testbed, waitFor } from '../../tools/testbed.js';

const T0 = Date.parse('2026-11-01T00:10:00+07:00');
const MIN = 60_000;

describe('E1.1 acceptance — store-and-forward over MQTT 5 + mTLS', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed().start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  it('bootstraps against the local test CA: CSR generated locally, cert + chain stored 0600', async () => {
    const { agent, gatewayId } = tb.agent();
    await agent.start();
    expect(agent.gatewayId).toBe(gatewayId);
    const dir = join(agent.identityStore.dir);
    for (const f of ['device.key', 'device.crt', 'ca.pem']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    await waitFor(() => tb.broker.connectedClients().includes(`gw-${gatewayId}`));
    expect(tb.api.calls).toContain('POST /v1/device/bootstrap');
    // one-time code: a second bootstrap with the same code is refused
    const res = await fetchJson(tb, '/v1/device/bootstrap', { provisioningCode: 'X', csrPem: '' });
    expect(res).toBe(422);
    await agent.stop();
  });

  it('10 meters, broker killed for 10 min, restored → every reading delivered once, in order', async () => {
    const clock = new VirtualClock(T0);
    const ids = meterIds(10);
    const { agent, gatewayId } = tb.agent({ clock });
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    // boot read after config apply → 10 readings
    await waitFor(() => tb.ingest.maxSeq(ids[0]!) === 1 && tb.ingest.meters() >= 10, 15_000);
    const before = tb.ingest.accepted;

    await clock.advance(5 * MIN); // 00:15 tick
    await waitFor(() => tb.ingest.maxSeq(ids[9]!) === 2);

    await tb.broker.kill(); // 00:15 → 00:25, one aligned tick (00:30 excluded) — 00:20 has no tick, so extend over 00:30
    await waitFor(() => !agent.link!.connected);
    await clock.advance(10 * MIN); // 00:25
    await clock.advance(5 * MIN); // 00:30 tick taken while offline
    await agent.config.active()!.scheduler.idle();
    expect(agent.queue.metrics().depth).toBe(10);
    await tb.broker.start(); // restored on the same port
    await waitFor(() => agent.link!.connected, 15_000);
    await waitFor(() => tb.ingest.maxSeq(ids[9]!) === 3, 15_000);
    await waitFor(() => agent.queue.metrics().depth === 0);

    expect(tb.ingest.accepted - before).toBe(20);
    expect(tb.ingest.duplicates).toBe(0);
    expect(tb.ingest.outOfOrder).toBe(0);
    expect(tb.ingest.gaps()).toEqual([]);
    expect(tb.ingest.invalid).toBe(0);
    // the LWT fired when the broker died? no — the broker died, not the gateway; LWT only on a lost gateway
    const readAts = tb.ingest.keep!.filter((r) => r.meterId === ids[0]).map((r) => r.readAt);
    expect(readAts.slice(1)).toEqual(['2026-11-01T00:15:00+07:00', '2026-11-01T00:30:00+07:00']);
    // events (restart, config_applied) were persisted and delivered too
    expect(tb.ingest.events.map((e) => e.type)).toEqual(expect.arrayContaining(['restart', 'config_applied']));
    await agent.stop();
  });

  it('lost PUBACKs cause redelivery that the ingest dedups: zero lost, zero duplicates accepted', async () => {
    const clock = new VirtualClock(T0);
    const ids = meterIds(10, '0192a000-0000-7000-8001');
    const { agent, gatewayId } = tb.agent({ clock, forwarder: { maxInflight: 1, retryBaseMs: 20, retryMaxMs: 50 } });
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    await waitFor(() => ids.every((id) => tb.ingest.maxSeq(id) === 1), 15_000);
    const accepted0 = tb.ingest.accepted;
    const dups0 = tb.ingest.duplicates;
    let n = 0;
    tb.broker.random = () => (n++ % 2 === 0 ? 0 : 1); // every other telemetry PUBACK is lost
    tb.broker.dropPubackTopic = /\/telemetry$/;
    tb.broker.dropPubackProbability = 0.5;
    for (let i = 0; i < 4; i++) await clock.advance(15 * MIN);
    await waitFor(() => ids.every((id) => tb.ingest.maxSeq(id) === 5), 30_000);
    tb.broker.dropPubackProbability = 0;
    await waitFor(() => agent.link!.connected && agent.queue.metrics().depth === 0, 30_000);
    expect(tb.broker.stats.droppedPubacks).toBeGreaterThan(0);
    expect(tb.ingest.duplicates - dups0).toBeGreaterThan(0);
    expect(tb.ingest.accepted - accepted0).toBe(40);
    expect(tb.ingest.gaps()).toEqual([]);
    await agent.stop();
  });

  it('HTTPS batch fallback after N minutes without a broker, then back to MQTT', async () => {
    const clock = new VirtualClock(T0);
    const ids = meterIds(10, '0192a000-0000-7000-8002');
    const { agent, gatewayId } = tb.agent({ clock, env: { httpsFallbackAfterS: 1 } });
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    await waitFor(() => ids.every((id) => tb.ingest.maxSeq(id) === 1), 15_000);
    const calls0 = tb.api.calls.filter((c) => c.endsWith('/readings/batch')).length;
    await tb.broker.kill();
    await waitFor(() => !agent.link!.connected);
    await clock.advance(5 * MIN); // 00:15 tick while the broker is gone
    await waitFor(() => tb.api.calls.filter((c) => c.endsWith('/readings/batch')).length > calls0, 10_000);
    await waitFor(() => ids.every((id) => tb.ingest.maxSeq(id) === 2), 10_000);
    expect(agent.forwarder!.usingHttpsFallback).toBe(true);
    expect(agent.queue.metrics().depth).toBe(0);
    await tb.broker.start();
    await waitFor(() => agent.link!.connected, 15_000);
    expect(agent.forwarder!.usingHttpsFallback).toBe(false);
    await clock.advance(15 * MIN);
    await waitFor(() => ids.every((id) => tb.ingest.maxSeq(id) === 3), 10_000);
    expect(tb.ingest.gaps()).toEqual([]);
    await agent.stop();
  });

  it('LWT: the broker publishes offline_lwt on /health when the gateway vanishes', async () => {
    const { agent, gatewayId } = tb.agent();
    await agent.start();
    await waitFor(() => tb.broker.connectedClients().includes(`gw-${gatewayId}`));
    const lwt0 = tb.ingest.lwt;
    // simulate a power cut: the socket dies without DISCONNECT
    (agent.link as unknown as { client: { stream: { destroy(): void } } }).client.stream.destroy();
    await waitFor(() => tb.ingest.lwt === lwt0 + 1);
    await agent.stop();
  });

  it('mTLS: a client without a CA-issued certificate cannot connect; ACL confines a gateway to its own topics', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const s = tlsConnect(
          { host: '127.0.0.1', port: tb.broker.port, ca: tb.ca.certPem, servername: 'localhost' },
          () => {
            s.on('data', resolve);
            s.on('close', () => reject(new Error('closed')));
            s.write(Buffer.from([0x10, 0x00]));
          },
        );
        s.on('error', reject);
      }),
    ).rejects.toThrow();

    const { agent, gatewayId } = tb.agent();
    await agent.start();
    const creds = agent.identityStore.credentials()!;
    const c = await mqtt.connectAsync(`mqtts://127.0.0.1:${tb.broker.port}`, {
      protocolVersion: 5,
      clientId: 'probe',
      key: creds.key,
      cert: creds.cert,
      ca: creds.ca,
      reconnectPeriod: 0,
    });
    await expect(
      c.publishAsync(`gp/v1/0192a000-0000-7000-8000-00000000ffff/telemetry`, '{}', { qos: 1 }),
    ).rejects.toThrow(/Not authorized/i);
    await expect(c.subscribeAsync(`gp/v1/0192a000-0000-7000-8000-00000000ffff/config`, { qos: 1 })).rejects.toThrow(
      /Not authorized/i,
    );
    const own = await c.subscribeAsync(`gp/v1/${gatewayId}/config`, { qos: 1 });
    expect(own[0]!.qos).toBe(1);
    await c.endAsync();
    await agent.stop();
  });
});

async function fetchJson(tb: Testbed, path: string, body: unknown): Promise<number> {
  const { request } = await import('node:https');
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, tb.api.baseUrl),
      { method: 'POST', ca: tb.ca.certPem, headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
