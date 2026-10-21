import { describe, expect, it } from 'vitest';

import { DEFAULT_DEVICE_API_URL, loadEnv } from '../../src/env.js';
import { deviceRoute } from '../../src/transport/https/device-api.js';
import { assertSecureBrokerUrl, MqttLink } from '../../src/transport/mqtt/mqtt-link.js';
import { silentLogger } from '../../src/util/logger.js';

/** D-230: the cloud side runs on Collective's shared AWS platform (Caddy DEVICE_HOST + EMQX mTLS on 8883). */
describe('platform endpoints (D-230, D-239)', () => {
  it('defaults to the device host and keeps the WSS fallback off', () => {
    const env = loadEnv({});
    expect(env.apiBaseUrl).toBe(DEFAULT_DEVICE_API_URL);
    expect(DEFAULT_DEVICE_API_URL).toBe('https://device.getproperty.co');
    expect(env.mqttWsFallback).toBe(false);
    expect(env.mqttUrlOverride).toBeUndefined();
    expect(loadEnv({ GP_MQTT_WS_FALLBACK: 'on' }).mqttWsFallback).toBe(true);
    expect(loadEnv({ GP_MQTT_WS_FALLBACK: '0' }).mqttWsFallback).toBe(false);
    expect(() => loadEnv({ GP_MQTT_WS_FALLBACK: 'maybe' })).toThrow(/on \| off/);
  });

  it('refuses non-TLS device and broker URLs (loopback dev only)', () => {
    expect(() => loadEnv({ GP_API_URL: 'http://device.getproperty.co' })).toThrow(/non-HTTPS/);
    expect(() => loadEnv({ GP_API_URL: 'not a url' })).toThrow(/GP_API_URL/);
    expect(loadEnv({ GP_API_URL: 'http://localhost:3000' }).apiBaseUrl).toBe('http://localhost:3000');
    expect(() => loadEnv({ GP_MQTT_URL: 'mqtt://mqtt.getproperty.co:1883' })).toThrow(/non-TLS/);
    expect(loadEnv({ GP_MQTT_URL: 'mqtts://mqtt.getproperty.co:8883' }).mqttUrlOverride).toBe(
      'mqtts://mqtt.getproperty.co:8883',
    );

    expect(() => assertSecureBrokerUrl('mqtts://mqtt.getproperty.co:8883')).not.toThrow();
    expect(() => assertSecureBrokerUrl('wss://mqtt.getproperty.co/mqtt')).not.toThrow();
    expect(() => assertSecureBrokerUrl('mqtt://localhost:1883')).not.toThrow();
    expect(() => assertSecureBrokerUrl('ws://mqtt.getproperty.co:8083/mqtt')).toThrow(/non-TLS/);
    expect(() => assertSecureBrokerUrl('tcp://mqtt.getproperty.co:1883')).toThrow(/non-TLS/);
    expect(() => assertSecureBrokerUrl('nope')).toThrow(/not a URL/);
  });

  it('an MQTT link never accepts a plaintext primary or WSS URL', () => {
    const base = {
      gatewayId: 'g',
      credentials: () => ({ key: '', cert: '', ca: '' }),
      password: () => Promise.reject(new Error('unused')),
      logger: silentLogger(),
    };
    expect(() => new MqttLink({ ...base, url: 'mqtt://mqtt.getproperty.co:1883' })).toThrow(/non-TLS/);
    expect(() => new MqttLink({ ...base, url: 'mqtts://mqtt.getproperty.co:8883', wsUrl: 'ws://x/mqtt' })).toThrow(
      /non-TLS/,
    );
    const link = new MqttLink({ ...base, url: 'mqtts://mqtt.getproperty.co:8883' });
    expect(link.currentUrl).toBe('mqtts://mqtt.getproperty.co:8883');
  });

  it('device paths go to the device host with credentials; other origins never get them', () => {
    const device = 'https://device.getproperty.co';
    // older api builds put manifestUrl on PUBLIC_API_BASE_URL (public API host strips client certificates); still works
    const m = deviceRoute('https://api.getproperty.co/v1/device/ota/manifest?releaseId=r1', device);
    expect(m.url.href).toBe('https://device.getproperty.co/v1/device/ota/manifest?releaseId=r1');
    expect(m.credentials).toBe(true);
    const rel = deviceRoute('/v1/device/ota/manifest?releaseId=r2', device);
    expect(rel.url.href).toBe('https://device.getproperty.co/v1/device/ota/manifest?releaseId=r2');
    expect(rel.credentials).toBe(true);
    const s3 = deviceRoute(
      'https://collective-prod-getproperty-assets.s3.ap-southeast-7.amazonaws.com/edge/0.2.0/bin?X-Amz-Signature=x',
      device,
    );
    expect(s3.url.hostname).toBe('collective-prod-getproperty-assets.s3.ap-southeast-7.amazonaws.com');
    expect(s3.credentials).toBe(false);
    // api D-231: artefacts on the device surface → device host with credentials
    const art = deviceRoute(
      'https://device.getproperty.co/v1/device/ota/artifacts/0.2.0/getproperty-edge-0.2.0-linux-arm64',
      device,
    );
    expect(art.url.href).toBe(
      'https://device.getproperty.co/v1/device/ota/artifacts/0.2.0/getproperty-edge-0.2.0-linux-arm64',
    );
    expect(art.credentials).toBe(true);
    const cdn = deviceRoute('https://releases.getproperty.co/edge/0.2.0/getproperty-edge-0.2.0-linux-arm64', device);
    expect(cdn.credentials).toBe(false);
    expect(deviceRoute('https://device.getproperty.co/releases/x', device).credentials).toBe(true);
    // a look-alike path outside the device surface on another origin stays anonymous
    expect(deviceRoute('https://evil.example/v1/devicex/ota', device).credentials).toBe(false);
  });
});
