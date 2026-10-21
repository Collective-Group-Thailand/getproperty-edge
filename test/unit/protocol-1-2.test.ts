import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { wsFallbackUrl } from '../../src/agent.js';
import { loadEnv } from '../../src/env.js';
import { bootstrapAcl, type BootstrapResponse } from '../../src/identity/bootstrap.js';
import { generateKeyAndCsr } from '../../src/identity/csr.js';
import { type Identity, IdentityStore } from '../../src/identity/identity-store.js';
import { DeviceTokenCache } from '../../src/identity/token.js';
import { buildEvent, buildHealth } from '../../src/protocol/envelopes.js';
import { protocolSchema } from '../../src/protocol/schema.js';
import { DeviceEventTypeValues, MQTT_ACL, MQTT_AUTH, PROTOCOL_VERSION } from '../../src/protocol/types.js';
import type { DeviceApi } from '../../src/transport/https/device-api.js';
import { effectiveAcl, MqttLink } from '../../src/transport/mqtt/mqtt-link.js';
import { VirtualClock } from '../../src/util/clock.js';
import { createLogger, LogRing, silentLogger } from '../../src/util/logger.js';
import { createTestCa, signCsr } from '../../tools/pki.js';

const GW = '0192a000-0000-7000-8000-00000000aaaa';

describe('device protocol 1.2 (D-235, D-244) — generated constants', () => {
  it('pins revision 1.2 with the exact ACL and the device-JWT login', () => {
    expect(PROTOCOL_VERSION).toBe('1.2');
    expect([...MQTT_ACL.publish]).toEqual(['telemetry', 'health', 'events', 'cmd/ack']);
    expect([...MQTT_ACL.subscribe]).toEqual(['config', 'cmd']);
    expect(MQTT_ACL.maxQos).toBe(1);
    expect(MQTT_ACL.retainOnPublish).toBe(false);
    expect(MQTT_AUTH.clientId).toBe('gw-<gatewayId>');
    expect(MQTT_AUTH.passwordRequired).toBe(true);
    expect([...MQTT_AUTH.transports]).toEqual(['mtls', 'ws']);
  });

  it('health keeps meters[] on the wire (required by the contract); meter_status_changed is derived by the api', () => {
    // api T-13 stores per-meter status changes as `meter_status_changed` events computed from Health.meters[]; the
    // contract still requires meters[] and DeviceEventType has no meter_status_changed (triage F11-5: web/liff only).
    const health = protocolSchema.$defs.Health;
    expect(health.required).toContain('meters');
    expect(DeviceEventTypeValues as readonly string[]).not.toContain('meter_status_changed');
    expect(() => buildEvent(GW, 'meter_status_changed' as never, 'warning', '2026-11-01T00:00:00+07:00', {})).toThrow();
    const h = buildHealth({
      gatewayId: GW,
      agentVersion: '0.1.0',
      configVersion: 1,
      uptimeS: 1,
      bufferedReadings: 0,
      diskFreeMb: 1,
      cpuPct: 1,
      memPct: 1,
      link: 'ethernet',
      rssi: null,
      meters: [{ meterId: '0192a000-0000-7000-8000-000000000001', status: 'timeout', lastReadAt: null }],
    });
    expect(h.meters[0]!.status).toBe('timeout');
  });
});

describe('effective ACL', () => {
  it('is the contract x-acl, narrowed by the bootstrap ACL when one is stored', () => {
    const all = effectiveAcl();
    expect([...all.publish]).toEqual(['telemetry', 'health', 'events', 'cmd/ack']);
    expect([...all.subscribe]).toEqual(['config', 'cmd']);
    const narrowed = effectiveAcl({ publish: ['telemetry', 'health', 'events', 'status'], subscribe: ['config'] });
    expect([...narrowed.publish]).toEqual(['telemetry', 'health', 'events']); // never widened by the answer
    expect([...narrowed.subscribe]).toEqual(['config']);
  });

  it('the link refuses a topic outside the ACL locally, before any network attempt', async () => {
    const link = new MqttLink({
      gatewayId: GW,
      url: 'mqtts://mqtt.getproperty.co:8883',
      credentials: () => ({ key: '', cert: '', ca: '' }),
      password: () => Promise.reject(new Error('unused')),
      acl: { publish: ['telemetry'], subscribe: ['config', 'cmd'] },
      logger: silentLogger(),
    });
    await expect(link.publish('config', '{}')).rejects.toThrow(/not in the gateway ACL/);
    await expect(link.publish('health', '{}')).rejects.toThrow(/not in the gateway ACL/);
    await expect(link.publish('telemetry', '{}')).rejects.toThrow(/not connected/);
  });
});

describe('bootstrap answer (protocol 1.2)', () => {
  const answer = (acl: BootstrapResponse['mqtt']['acl']): BootstrapResponse => ({
    gatewayId: GW,
    certificatePem: '',
    caChainPem: '',
    mqtt: { url: 'mqtts://m:8883', password: 'device_jwt', acl },
  });

  it('keeps the gateway’s own explicit topics and drops wildcards and foreign topics', () => {
    const acl = bootstrapAcl(
      answer([
        ...['telemetry', 'health', 'events', 'cmd/ack'].map((t) => ({
          action: 'publish' as const,
          topic: `gp/v1/${GW}/${t}`,
        })),
        { action: 'publish', topic: `gp/v1/${GW}/+` },
        { action: 'publish', topic: 'gp/v1/0192a000-0000-7000-8000-00000000bbbb/telemetry' },
        { action: 'subscribe', topic: `gp/v1/${GW}/config` },
        { action: 'subscribe', topic: `gp/v1/${GW}/cmd` },
      ]),
      silentLogger(),
    )!;
    expect(acl.publish).toEqual(['telemetry', 'health', 'events', 'cmd/ack']);
    expect(acl.subscribe).toEqual(['config', 'cmd']);
  });

  it('logs the topics the broker would refuse; no ACL in the answer = the contract applies', () => {
    const lines: string[] = [];
    const logger = createLogger('error', undefined, false);
    logger.error = (obj: unknown) => void lines.push(JSON.stringify(obj));
    const acl = bootstrapAcl(answer([{ action: 'publish', topic: `gp/v1/${GW}/telemetry` }]), logger)!;
    expect(acl.publish).toEqual(['telemetry']);
    expect(lines.join()).toMatch(/publish health/);
    expect(bootstrapAcl({ ...answer(undefined) }, silentLogger())).toBeUndefined();
  });

  it('stores the ACL with the identity and refuses a stored certificate whose CN is not gw-<id>', async () => {
    const ca = await createTestCa();
    const { keyPem, csrPem } = await generateKeyAndCsr('gw-provisioning');
    const certPem = await signCsr(ca, csrPem, GW);
    const dir = mkdtempSync(join(tmpdir(), 'gp-id12-'));
    const mqttAcl = { publish: [...MQTT_ACL.publish], subscribe: [...MQTT_ACL.subscribe] };
    new IdentityStore(dir, silentLogger()).save({
      gatewayId: GW,
      mqttUrl: 'mqtts://m:8883',
      mqttAcl,
      certPem,
      keyPem,
      caPem: ca.certPem,
    });
    expect(new IdentityStore(dir, silentLogger()).load()!.mqttAcl).toEqual(mqttAcl);
    const metaFile = join(dir, 'identity', 'identity.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(metaFile, JSON.stringify({ ...meta, gatewayId: '0192a000-0000-7000-8000-00000000bbbb' }));
    expect(() => new IdentityStore(dir, silentLogger()).load()).toThrow(/CN gw-0192a000.*aaaa is not gw-/);
  });
});

describe('device JWT as MQTT password', () => {
  function fakeApi(ttlMs: number, clock: VirtualClock) {
    const calls: number[] = [];
    const api = {
      json: (method: string, path: string) => {
        expect(`${method} ${path}`).toBe('POST /v1/device/token');
        calls.push(clock.now());
        return Promise.resolve({
          accessToken: `jwt-${calls.length}`,
          expiresAt: new Date(clock.now() + ttlMs).toISOString(),
        });
      },
    } as unknown as DeviceApi;
    return { api, calls };
  }

  it('reuses a token with ≥ 5 min left, fetches otherwise, always when fresh; concurrent callers share one fetch', async () => {
    const clock = new VirtualClock(Date.parse('2026-11-01T00:00:00Z'));
    const { api, calls } = fakeApi(3_600_000, clock);
    const cache = new DeviceTokenCache(api, clock);
    const [a, b] = await Promise.all([cache.mqttPassword(), cache.mqttPassword()]);
    expect(a.accessToken).toBe('jwt-1');
    expect(b.accessToken).toBe('jwt-1');
    expect(calls).toHaveLength(1);
    await clock.advance(50 * 60_000); // 10 min left
    expect((await cache.mqttPassword()).accessToken).toBe('jwt-1');
    expect(await cache.get()).toBe('jwt-1');
    await clock.advance(6 * 60_000); // 4 min left: too short for a connect
    expect((await cache.mqttPassword()).accessToken).toBe('jwt-2');
    expect((await cache.mqttPassword({ fresh: true })).accessToken).toBe('jwt-3');
    cache.invalidate();
    expect(await cache.get()).toBe('jwt-4');
  });

  it('refuses a seeded token without a usable expiry', () => {
    const clock = new VirtualClock(0);
    const cache = new DeviceTokenCache(fakeApi(1, clock).api, clock);
    expect(() => cache.seed({ accessToken: 'x', expiresAt: 'soon' })).toThrow(/expiresAt/);
  });

  it('never logs the password', async () => {
    const ring = new LogRing();
    const logger = createLogger('info', ring, false);
    logger.info({ password: 'eyJsecret', opts: { password: 'eyJsecret' } }, 'x');
    await new Promise((r) => setImmediate(r));
    expect(ring.snapshot()).toContain('[redacted]');
    expect(ring.snapshot()).not.toContain('eyJsecret');
  });
});

describe('WebSocket fallback gating (D-239)', () => {
  const id = (wsUrl?: string): Identity =>
    ({
      gatewayId: GW,
      mqttUrl: 'mqtts://mqtt.getproperty.co:8883',
      ...(wsUrl ? { mqttWsUrl: wsUrl } : {}),
    }) as Identity;

  it('needs both the API (bootstrap wsUrl) and GP_MQTT_WS_FALLBACK=on', () => {
    const on = loadEnv({ GP_MQTT_WS_FALLBACK: 'on' });
    const off = loadEnv({});
    const ws = 'wss://mqtt.getproperty.co/mqtt';
    expect(wsFallbackUrl(id(ws), on, silentLogger())).toBe(ws);
    expect(wsFallbackUrl(id(ws), off, silentLogger())).toBeUndefined();
    expect(wsFallbackUrl(id(), on, silentLogger())).toBeUndefined();
    expect(wsFallbackUrl(id(), off, silentLogger())).toBeUndefined();
  });
});
