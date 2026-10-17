import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  compareSemver,
  type OtaManifest,
  OtaVerifyError,
  signManifest,
  verifyManifest,
} from '../../src/ota/manifest.js';
import { MemoryOtaFs } from '../../src/ota/ota-fs.js';
import { AbSlots, parseEnv } from '../../src/ota/slots.js';
import { OtaUpdater } from '../../src/ota/updater.js';
import { VirtualClock } from '../../src/util/clock.js';
import { silentLogger } from '../../src/util/logger.js';

const keys = generateKeyPairSync('ed25519');
const PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const TRUSTED = { 'gp-ota-test': PUB };
const BIN = Buffer.from('#!/bin/sh\necho new agent\n'.repeat(100));
const SHA = createHash('sha256').update(BIN).digest('hex');

const manifest = (over: Partial<OtaManifest> = {}): OtaManifest =>
  signManifest(
    {
      schema: 1,
      version: '0.2.0',
      channel: 'canary',
      arch: 'arm64',
      artifact: { url: 'https://releases.getproperty.co/edge/0.2.0/bin', sha256: SHA, size: BIN.length },
      releasedAt: '2026-11-01T00:00:00Z',
      ...over,
    },
    PRIV,
    'gp-ota-test',
  );
const ctx = { currentVersion: '0.1.0', arch: 'arm64' };

describe('OTA manifest', () => {
  it('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('verifies a manifest signed with a trusted ed25519 key', () => {
    expect(verifyManifest(manifest(), TRUSTED, ctx).version).toBe('0.2.0');
    // key order / whitespace in transport does not matter
    const reverse = (v: unknown): unknown =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v)
              .reverse()
              .map(([k, x]) => [k, reverse(x)]),
          )
        : v;
    const reordered = JSON.parse(JSON.stringify(reverse(manifest()), null, 2)) as unknown;
    expect(() => verifyManifest(reordered, TRUSTED, ctx)).not.toThrow();
  });
  it.each([
    ['tampered artefact hash', (m: OtaManifest) => ({ ...m, artifact: { ...m.artifact, sha256: 'f'.repeat(64) } })],
    ['tampered version', (m: OtaManifest) => ({ ...m, version: '9.9.9' })],
    ['unsigned', (m: OtaManifest) => ({ ...m, signature: undefined })],
    ['untrusted key id', (m: OtaManifest) => ({ ...m, signature: { ...m.signature!, keyId: 'other' } })],
  ])('rejects a %s', (_n, mutate) => {
    expect(() => verifyManifest(mutate(manifest()), TRUSTED, ctx)).toThrow(OtaVerifyError);
  });
  it('rejects another key, wrong arch, downgrades, plain-HTTP artefacts and too-old agents', () => {
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const { signature: _s, ...unsigned } = manifest();
    expect(() => verifyManifest(signManifest(unsigned, other, 'gp-ota-test'), TRUSTED, ctx)).toThrow(
      /signature invalid/,
    );
    expect(() => verifyManifest(manifest({ arch: 'x64' }), TRUSTED, ctx)).toThrow(/arm64/);
    expect(() => verifyManifest(manifest({ version: '0.1.0' }), TRUSTED, ctx)).toThrow(/not newer/);
    expect(() =>
      verifyManifest(manifest({ artifact: { url: 'http://x/bin', sha256: SHA, size: 1 } }), TRUSTED, ctx),
    ).toThrow(/HTTPS/);
    expect(() => verifyManifest(manifest({ minAgentVersion: '0.1.5' }), TRUSTED, ctx)).toThrow(/requires/);
    expect(() => verifyManifest(manifest(), {}, ctx)).toThrow(/not trusted/);
  });
  it('accepts the protocol §6 channels and refuses unknown channels/architectures (signed or not)', () => {
    for (const channel of ['stable', 'beta', 'canary'] as const)
      expect(verifyManifest(manifest({ channel }), TRUSTED, ctx).channel).toBe(channel);
    expect(() => verifyManifest(manifest({ channel: 'all' as 'stable' }), TRUSTED, ctx)).toThrow(/unknown channel/);
    expect(() => verifyManifest(manifest({ arch: 'mips' as 'x64' }), TRUSTED, ctx)).toThrow(/unknown arch/);
    expect(() => verifyManifest(manifest({ arch: 'armv7' }), TRUSTED, ctx)).toThrow(/this gateway is arm64/);
  });
  it('compares semver with pre-releases', () => {
    expect(compareSemver('1.4.2', '1.4.10')).toBe(-1);
    expect(compareSemver('1.0.0-rc.2', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
  });
});

async function* chunks(b: Buffer) {
  for (let i = 0; i < b.length; i += 512) yield b.subarray(i, i + 512);
}

function slots() {
  const fs = new MemoryOtaFs();
  fs.links.set('/opt/gp/slots/current', 'a');
  fs.files.set('/opt/gp/slots/a/getproperty-edge', Buffer.from('old'));
  return { fs, s: new AbSlots(fs, '/opt/gp', '/var/lib/gp') };
}

describe('A/B slots (fake filesystem)', () => {
  it('installs into the inactive slot only after size + sha256 match', async () => {
    const { fs, s } = slots();
    expect(await s.active()).toBe('a');
    expect(await s.inactive()).toBe('b');
    await expect(s.install('b', chunks(BIN), { sha256: 'a'.repeat(64), size: BIN.length })).rejects.toThrow(
      /integrity/,
    );
    expect(fs.files.has('/opt/gp/slots/b/getproperty-edge')).toBe(false);
    expect(fs.files.has('/opt/gp/slots/b/getproperty-edge.partial')).toBe(false);
    await expect(s.install('b', chunks(Buffer.concat([BIN, BIN])), { sha256: SHA, size: BIN.length })).rejects.toThrow(
      /larger/,
    );
    await s.install('b', chunks(BIN), { sha256: SHA, size: BIN.length });
    expect(fs.files.get('/opt/gp/slots/b/getproperty-edge')).toEqual(BIN);
    expect(fs.modes.get('/opt/gp/slots/b/getproperty-edge.partial')).toBe(0o755);
    expect(await s.active()).toBe('a'); // nothing switched yet
  });

  it('switch → trial → commit keeps the new slot; rollback restores the previous one with a marker', async () => {
    const { fs, s } = slots();
    await s.install('b', chunks(BIN), { sha256: SHA, size: BIN.length });
    await s.switchTo({ slot: 'b', previous: 'a', version: '0.2.0', fromVersion: '0.1.0', deadline: 100, attempts: 0 });
    expect(fs.links.get('/opt/gp/slots/current')).toBe('b');
    expect(await s.pending()).toMatchObject({ slot: 'b', previous: 'a', version: '0.2.0', deadline: 100 });
    expect(parseEnv(fs.files.get('/var/lib/gp/ota/pending.env')!.toString())).toMatchObject({
      SLOT: 'b',
      ATTEMPTS: '0',
    });
    await s.rollback('health_gate_timeout');
    expect(fs.links.get('/opt/gp/slots/current')).toBe('a');
    expect(await s.pending()).toBeNull();
    expect(await s.takeRolledBack()).toEqual({ version: '0.2.0', fromVersion: '0.1.0', reason: 'health_gate_timeout' });
    expect(await s.takeRolledBack()).toBeNull();
    await s.switchTo({ slot: 'b', previous: 'a', version: '0.2.0', fromVersion: '0.1.0', deadline: 100, attempts: 0 });
    await s.commit();
    expect(await s.pending()).toBeNull();
    expect(await s.active()).toBe('b');
  });

  it('refuses to switch to an empty slot', async () => {
    const { s } = slots();
    await expect(
      s.switchTo({ slot: 'b', previous: 'a', version: '0.2.0', fromVersion: '0.1.0', deadline: 1, attempts: 0 }),
    ).rejects.toThrow(/no binary/);
  });
});

function updater(over: Partial<ConstructorParameters<typeof OtaUpdater>[0]> = {}) {
  const { fs, s } = slots();
  const clock = new VirtualClock(Date.parse('2026-11-01T00:00:00Z'));
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let restarts = 0;
  let ack!: () => void;
  const healthAck = new Promise<void>((r) => (ack = r));
  const u = new OtaUpdater({
    slots: s,
    trustedKeys: TRUSTED,
    currentVersion: '0.1.0',
    arch: 'arm64',
    fetchManifest: async () => manifest(),
    download: async () => chunks(BIN),
    clock,
    logger: silentLogger(),
    event: (type, _sev, _msg, data) => events.push({ type, data }),
    requestRestart: () => restarts++,
    firstHealthAck: () => healthAck,
    ...over,
  });
  return { u, fs, s, clock, events, restarts: () => restarts, ack };
}

describe('OtaUpdater', () => {
  it('ota_apply: verify → ota_started → install to the inactive slot → switch → restart', async () => {
    const t = updater();
    await expect(t.u.apply('https://api/v1/device/ota/manifest')).resolves.toMatchObject({
      version: '0.2.0',
      slot: 'b',
    });
    expect(t.events.map((e) => e.type)).toEqual(['ota_started']);
    expect(t.fs.links.get('/opt/gp/slots/current')).toBe('b');
    expect(t.restarts()).toBe(1);
    await expect(t.u.apply('https://api/x')).rejects.toThrow(/waiting for its health gate/);
  });

  it('a bad signature or a corrupt download reports ota_failed and never switches', async () => {
    const bad = updater({ fetchManifest: async () => ({ ...manifest(), version: '0.3.0' }) });
    await expect(bad.u.apply('https://api/m')).rejects.toThrow(/signature invalid/);
    expect(bad.events.map((e) => e.type)).toEqual(['ota_failed']);
    expect(bad.fs.links.get('/opt/gp/slots/current')).toBe('a');
    const corrupt = updater({ download: async () => chunks(Buffer.from('evil')) });
    await expect(corrupt.u.apply('https://api/m')).rejects.toThrow(/integrity/);
    expect(corrupt.events.map((e) => e.type)).toEqual(['ota_started', 'ota_failed']);
    expect(corrupt.fs.links.get('/opt/gp/slots/current')).toBe('a');
  });

  it('post-boot health gate: health within 5 min → ota_applied', async () => {
    const first = updater();
    await first.u.apply('https://api/m');
    const boot = new OtaUpdater({ ...first.u['d'], currentVersion: '0.2.0' });
    const p = boot.onBoot();
    await first.clock.advance(60_000);
    first.ack();
    await expect(p).resolves.toBe('committed');
    expect(first.events.map((e) => e.type)).toEqual(['ota_started', 'ota_applied']);
    expect(await first.s.pending()).toBeNull();
    expect(first.fs.links.get('/opt/gp/slots/current')).toBe('b');
  });

  it('post-boot health gate: no health within 5 min → rollback, restart, the old agent reports ota_rolled_back', async () => {
    const first = updater({ gateMs: 300_000 });
    await first.u.apply('https://api/m');
    const boot = new OtaUpdater({ ...first.u['d'], currentVersion: '0.2.0' });
    const p = boot.onBoot();
    await new Promise((r) => setTimeout(r, 10)); // let onBoot read the trial and arm its timer
    await first.clock.advance(300_001);
    await expect(p).resolves.toBe('rolled_back');
    expect(first.fs.links.get('/opt/gp/slots/current')).toBe('a');
    expect(first.restarts()).toBe(2);
    const old = new OtaUpdater({ ...first.u['d'], currentVersion: '0.1.0' });
    await expect(old.onBoot()).resolves.toBe('none');
    expect(first.events.at(-1)).toMatchObject({
      type: 'ota_rolled_back',
      data: { version: '0.2.0', reason: 'health_gate_timeout' },
    });
  });
});

describe('scripts/ota-guard.sh (ExecStartPre)', () => {
  function layout(pending: Record<string, string | number>) {
    const dir = mkdtempSync(join(tmpdir(), 'gp-guard-'));
    const root = join(dir, 'opt');
    const state = join(dir, 'state');
    mkdirSync(join(root, 'slots', 'a'), { recursive: true });
    mkdirSync(join(root, 'slots', 'b'), { recursive: true });
    mkdirSync(join(state, 'ota'), { recursive: true });
    symlinkSync('b', join(root, 'slots', 'current'));
    writeFileSync(
      join(state, 'ota', 'pending.env'),
      Object.entries(pending)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );
    const run = () =>
      execFileSync('sh', ['scripts/ota-guard.sh'], {
        env: { ...process.env, GP_OTA_ROOT: root, GP_STATE_DIR: state },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    return { root, state, run };
  }
  const future = Math.floor(Date.now() / 1000) + 600;

  it('counts start attempts and rolls back after the third failed start', () => {
    const l = layout({
      SLOT: 'b',
      PREVIOUS: 'a',
      VERSION: '0.2.0',
      FROM_VERSION: '0.1.0',
      DEADLINE: future,
      ATTEMPTS: 0,
    });
    for (let i = 1; i <= 3; i++) {
      l.run();
      expect(readFileSync(join(l.state, 'ota', 'pending.env'), 'utf8')).toContain(`ATTEMPTS=${i}`);
      expect(readlinkSync(join(l.root, 'slots', 'current'))).toBe('b');
    }
    l.run();
    expect(readlinkSync(join(l.root, 'slots', 'current'))).toBe('a');
    expect(existsSync(join(l.state, 'ota', 'pending.env'))).toBe(false);
    expect(readFileSync(join(l.state, 'ota', 'rolled-back.env'), 'utf8')).toContain('REASON=guard_start_4');
  });

  it('rolls back immediately when the deadline passed, and ignores a malformed trial', () => {
    const l = layout({ SLOT: 'b', PREVIOUS: 'a', VERSION: '0.2.0', FROM_VERSION: '0.1.0', DEADLINE: 1, ATTEMPTS: 0 });
    l.run();
    expect(readlinkSync(join(l.root, 'slots', 'current'))).toBe('a');
    const m = layout({ SLOT: 'b', PREVIOUS: '../../etc', VERSION: 'x' });
    m.run();
    expect(readlinkSync(join(m.root, 'slots', 'current'))).toBe('b');
    expect(existsSync(join(m.state, 'ota', 'pending.env'))).toBe(false);
  });

  it('does nothing without a trial', () => {
    const l = layout({});
    execFileSync('rm', [join(l.state, 'ota', 'pending.env')]);
    l.run();
    expect(readlinkSync(join(l.root, 'slots', 'current'))).toBe('b');
  });
});
