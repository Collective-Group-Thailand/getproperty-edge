import { randomUUID } from 'node:crypto';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent.js';
import { signManifest } from '../../src/ota/manifest.js';
import { silentLogger } from '../../src/util/logger.js';
import { meterIds, simConfig, Testbed, waitFor } from '../../tools/testbed.js';

describe('E1.4 — OTA through the broker, cold start budget', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed().start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  it('cold start → first telemetry in < 60 s and config apply in < 5 s', async () => {
    const ids = meterIds(300, '0192a000-0000-7000-8040');
    const { agent, gatewayId } = tb.agent();
    tb.pushConfig(gatewayId, simConfig(ids, 1));
    const t0 = Date.now();
    await agent.start();
    await waitFor(() => tb.ingest.maxSeq(ids[0]!) >= 1, 60_000);
    const firstTelemetryMs = Date.now() - t0;
    await waitFor(() => tb.ingest.events.some((e) => e.type === 'config_applied' && e.gatewayId === gatewayId));
    const applied = tb.ingest.events.find((e) => e.type === 'config_applied' && e.gatewayId === gatewayId)!;
    const applyMs = (applied.data as { durationMs: number }).durationMs;
    console.log(`cold start → first telemetry ${firstTelemetryMs} ms; 300-meter config apply ${applyMs} ms`);
    expect(firstTelemetryMs).toBeLessThan(60_000);
    expect(applyMs).toBeLessThan(5_000);
    await waitFor(() => ids.every((id) => tb.ingest.maxSeq(id) === 1), 30_000);
    await agent.stop();
  });

  it('ota_apply: signed manifest → download over mTLS → slot b → restart → health gate → ota_applied', async () => {
    const keys = generateKeyPairSync('ed25519');
    const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const priv = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const bin = Buffer.from(`#!/bin/sh\necho 0.2.0\n${'x'.repeat(200_000)}`);
    tb.api.files.set('/releases/0.2.0/getproperty-edge', { body: bin, type: 'application/octet-stream' });
    const manifest = signManifest(
      {
        schema: 1,
        version: '0.2.0',
        channel: 'canary',
        arch: 'arm64',
        artifact: {
          url: `${tb.api.baseUrl}/releases/0.2.0/getproperty-edge`,
          sha256: createHash('sha256').update(bin).digest('hex'),
          size: bin.length,
        },
        releasedAt: new Date().toISOString(),
      },
      priv,
      'gp-ota-int',
    );
    tb.api.files.set('/v1/device/ota/manifest', {
      body: Buffer.from(JSON.stringify(manifest)),
      type: 'application/json',
    });

    const otaRoot = tb.tmpDir('gp-opt-');
    mkdirSync(join(otaRoot, 'slots', 'a'), { recursive: true });
    writeFileSync(join(otaRoot, 'slots', 'a', 'getproperty-edge'), 'old');
    symlinkSync('a', join(otaRoot, 'slots', 'current'));
    const exits: number[] = [];
    const ota = { trustedKeys: { 'gp-ota-int': pub }, arch: 'arm64', gateMs: 20_000 };
    const { agent, gatewayId } = tb.agent({ env: { otaRoot }, ota, requestExit: (c) => exits.push(c) });
    tb.pushConfig(gatewayId, simConfig(meterIds(2, '0192a000-0000-7000-8041'), 1));
    await agent.start();
    await waitFor(() => agent.link!.connected);

    const cmdId = randomUUID();
    const cmd = JSON.stringify({
      cmdId,
      type: 'ota_apply',
      args: { manifestUrl: `${tb.api.baseUrl}/v1/device/ota/manifest` },
      issuedAt: new Date().toISOString(),
    });
    for (let i = 0; i < 10 && !tb.ingest.acks.some((a) => a.cmdId === cmdId); i++) {
      tb.broker.publish(`gp/v1/${gatewayId}/cmd`, cmd);
      await new Promise((r) => setTimeout(r, 300));
    }
    await waitFor(() => exits.length === 1, 15_000); // graceful stop + exit after the switch
    expect(readlinkSync(join(otaRoot, 'slots', 'current'))).toBe('b');
    expect(readFileSync(join(otaRoot, 'slots', 'b', 'getproperty-edge'))).toEqual(bin);
    expect(tb.api.calls).toContain('GET /v1/device/ota/manifest');

    // systemd starts `current` = the new version on the same state dir
    const env = agent['d'].env;
    const next = new Agent({
      env,
      logger: silentLogger(),
      jitterMaxMs: 0,
      statusPage: false,
      ota: { ...ota, currentVersion: '0.2.0' },
      mqtt: { backoffBaseMs: 50, backoffMaxMs: 300 },
    });
    await next.start();
    await waitFor(() => tb.ingest.events.some((e) => e.type === 'ota_applied' && e.gatewayId === gatewayId), 20_000);
    const types = tb.ingest.events.filter((e) => e.gatewayId === gatewayId).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['ota_started', 'ota_applied']));
    expect(tb.ingest.acks.filter((a) => a.cmdId === cmdId).map((a) => a.status)).toEqual(['accepted', 'done']);
    expect(readlinkSync(join(otaRoot, 'slots', 'current'))).toBe('b');
    await next.stop();
  });

  it('ota_apply with a manifest signed by an unknown key: ota_failed, nothing installed', async () => {
    const other = generateKeyPairSync('ed25519');
    const otaRoot = tb.tmpDir('gp-opt-');
    mkdirSync(join(otaRoot, 'slots', 'a'), { recursive: true });
    symlinkSync('a', join(otaRoot, 'slots', 'current'));
    const { agent, gatewayId } = tb.agent({
      env: { otaRoot },
      ota: {
        trustedKeys: { trusted: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        arch: 'arm64',
      },
    });
    await agent.start();
    await waitFor(() => agent.link!.connected);
    const cmdId = randomUUID();
    const cmd = JSON.stringify({
      cmdId,
      type: 'ota_apply',
      args: { manifestUrl: `${tb.api.baseUrl}/v1/device/ota/manifest` },
      issuedAt: new Date().toISOString(),
    });
    // like the cloud: re-send an unacknowledged command (the agent dedups the cmdId)
    for (let i = 0; i < 10 && !tb.ingest.acks.some((a) => a.cmdId === cmdId); i++) {
      tb.broker.publish(`gp/v1/${gatewayId}/cmd`, cmd);
      await new Promise((r) => setTimeout(r, 300));
    }
    await waitFor(() => tb.ingest.acks.some((a) => a.cmdId === cmdId && a.status === 'failed'), 15_000);
    expect(tb.ingest.events.some((e) => e.type === 'ota_failed' && e.gatewayId === gatewayId)).toBe(true);
    expect(readlinkSync(join(otaRoot, 'slots', 'current'))).toBe('a');
    await agent.stop();
  });
});
