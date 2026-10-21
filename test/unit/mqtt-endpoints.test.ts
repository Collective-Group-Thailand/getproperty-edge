import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateKeyAndCsr } from '../../src/identity/csr.js';
import { IdentityStore } from '../../src/identity/identity-store.js';
import { DeviceTokenCache, type MqttEndpoints, mqttEndpointsOf } from '../../src/identity/token.js';
import type { DeviceApi } from '../../src/transport/https/device-api.js';
import { MqttLink } from '../../src/transport/mqtt/mqtt-link.js';
import { VirtualClock } from '../../src/util/clock.js';
import { silentLogger } from '../../src/util/logger.js';
import { createTestCa, signCsr } from '../../tools/pki.js';

const GW = '0192a000-0000-7000-8000-00000000aaaa';
const URL8883 = 'mqtts://mqtt.getproperty.co:8883';
const WSS = 'wss://mqtt.getproperty.co/mqtt';

/** CR-015 (api D-249): every `POST /v1/device/token` answer carries the gateway's current `mqtt { url, wsUrl? }`. */
describe('token answer mqtt block (CR-015)', () => {
  it('parses url / wsUrl; a missing or malformed block is ignored (never switches anything)', () => {
    expect(mqttEndpointsOf({ accessToken: 'x', expiresAt: 'y', mqtt: { url: URL8883 } })).toEqual({ url: URL8883 });
    expect(mqttEndpointsOf({ mqtt: { url: URL8883, wsUrl: WSS } })).toEqual({ url: URL8883, wsUrl: WSS });
    expect(mqttEndpointsOf({ accessToken: 'x', expiresAt: 'y' })).toBeUndefined(); // API before D-249
    expect(mqttEndpointsOf({ mqtt: { wsUrl: WSS } })).toBeUndefined();
    expect(mqttEndpointsOf({ mqtt: { url: URL8883, wsUrl: 42 } })).toBeUndefined();
    expect(mqttEndpointsOf({ mqtt: { url: URL8883, wsUrl: '' } })).toBeUndefined();
    expect(mqttEndpointsOf({ mqtt: 'x' })).toBeUndefined();
    expect(mqttEndpointsOf(null)).toBeUndefined();
  });

  it('every fetched token reports its endpoints; the bootstrap seed does not; a throwing listener never fails a fetch', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-01T00:00:00Z'));
    let ws: string | undefined;
    const api = {
      json: () =>
        Promise.resolve({
          accessToken: 'jwt',
          expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
          mqtt: ws ? { url: URL8883, wsUrl: ws } : { url: URL8883 },
        }),
    } as unknown as DeviceApi;
    const seen: MqttEndpoints[] = [];
    const cache = new DeviceTokenCache(api, clock);
    cache.onMqttEndpoints((m) => seen.push(m));
    cache.seed({ accessToken: 'seed', expiresAt: new Date(clock.now() + 3_600_000).toISOString() });
    expect(await cache.get()).toBe('seed');
    expect(seen).toEqual([]);
    ws = WSS;
    const t = await cache.mqttPassword({ fresh: true });
    expect(t).toEqual({ accessToken: 'jwt', expiresAt: expect.any(String) }); // the password carries nothing else
    expect(seen).toEqual([{ url: URL8883, wsUrl: WSS }]);
    ws = undefined;
    cache.onMqttEndpoints(() => {
      throw new Error('disk full');
    });
    expect((await cache.mqttPassword({ fresh: true })).accessToken).toBe('jwt');
  });
});

describe('stored WebSocket fallback URL (CR-015)', () => {
  it('setMqttWsUrl rewrites identity.json only (0600), keeps the ACL, and survives a reload', async () => {
    const ca = await createTestCa();
    const { keyPem, csrPem } = await generateKeyAndCsr('gw-provisioning');
    const certPem = await signCsr(ca, csrPem, GW);
    const dir = mkdtempSync(join(tmpdir(), 'gp-ws15-'));
    const mqttAcl = { publish: ['telemetry'], subscribe: ['config'] };
    const store = new IdentityStore(dir, silentLogger());
    store.save({ gatewayId: GW, mqttUrl: URL8883, mqttAcl, certPem, keyPem, caPem: ca.certPem });
    const crt = readFileSync(join(dir, 'identity', 'device.crt'), 'utf8');

    expect(store.setMqttWsUrl(WSS).mqttWsUrl).toBe(WSS);
    const reloaded = new IdentityStore(dir, silentLogger()).load()!;
    expect(reloaded).toMatchObject({ gatewayId: GW, mqttUrl: URL8883, mqttWsUrl: WSS, mqttAcl });
    expect(statSync(join(dir, 'identity', 'identity.json')).mode & 0o777).toBe(0o600);

    const off = store.setMqttWsUrl(undefined);
    expect(off).not.toHaveProperty('mqttWsUrl');
    const meta = JSON.parse(readFileSync(join(dir, 'identity', 'identity.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toEqual({ gatewayId: GW, mqttUrl: URL8883, mqttAcl });
    expect(readFileSync(join(dir, 'identity', 'device.crt'), 'utf8')).toBe(crt);
  });

  it('refuses without an identity', () => {
    expect(() => new IdentityStore(mkdtempSync(join(tmpdir(), 'gp-ws15-')), silentLogger()).setMqttWsUrl(WSS)).toThrow(
      /no identity/,
    );
  });
});

describe('MqttLink.setWsUrl (CR-015)', () => {
  const link = (wsUrl?: string) =>
    new MqttLink({
      gatewayId: GW,
      url: URL8883,
      ...(wsUrl ? { wsUrl } : {}),
      credentials: () => ({ key: '', cert: '', ca: '' }),
      password: () => Promise.reject(new Error('unused')),
      logger: silentLogger(),
    });

  it('a URL added after bootstrap becomes the fallback; removing it pins the next connect to 8883', () => {
    const l = link();
    expect(l.fallbackUrl).toBeUndefined();
    l.setWsUrl(WSS);
    expect(l.fallbackUrl).toBe(WSS);
    expect(l.transport).toBe('mtls'); // 8883 stays primary — WSS only after failed 8883 attempts
    // simulate a link that already failed over to WSS
    (l as unknown as { useWs: boolean }).useWs = true;
    expect(l.currentUrl).toBe(WSS);
    l.setWsUrl(undefined);
    expect(l.fallbackUrl).toBeUndefined();
    expect(l.transport).toBe('mtls');
    expect(l.currentUrl).toBe(URL8883);
  });

  it('fails closed on a non-TLS URL: refused, previous value kept', () => {
    const l = link(WSS);
    expect(() => l.setWsUrl('ws://mqtt.getproperty.co:8083/mqtt')).toThrow(/non-TLS/);
    expect(() => l.setWsUrl('nope')).toThrow(/not a URL/);
    expect(l.fallbackUrl).toBe(WSS);
  });
});
