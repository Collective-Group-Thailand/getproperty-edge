import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normaliseProvisioningCode, ProvisioningCodeSource } from '../../src/identity/bootstrap.js';
import { certMatchesKey, generateKeyAndCsr, parseCert } from '../../src/identity/csr.js';
import { IdentityStore } from '../../src/identity/identity-store.js';
import { renewalDueAt } from '../../src/identity/renewal.js';
import { assertSecureUrl } from '../../src/transport/https/device-api.js';
import { silentLogger } from '../../src/util/logger.js';
import { createTestCa, signCsr } from '../../tools/pki.js';

const GW = '0192a000-0000-7000-8000-00000000aaaa';

describe('device key + CSR', () => {
  it('generates a P-256 key and a CSR the CA can sign for this key only', async () => {
    const ca = await createTestCa();
    const { keyPem, csrPem } = await generateKeyAndCsr('gw-provisioning');
    expect(csrPem).toContain('BEGIN CERTIFICATE REQUEST');
    const cert = await signCsr(ca, csrPem, GW);
    expect(parseCert(cert).subjectCn).toBe(`gw-${GW}`);
    expect(certMatchesKey(cert, keyPem)).toBe(true);
    const other = await generateKeyAndCsr('x');
    expect(certMatchesKey(cert, other.keyPem)).toBe(false);
  });
});

describe('IdentityStore', () => {
  it('stores cert, key and CA 0600 in a 0700 directory and reloads them', async () => {
    const ca = await createTestCa();
    const { keyPem, csrPem } = await generateKeyAndCsr('gw-provisioning');
    const certPem = await signCsr(ca, csrPem, GW);
    const dir = mkdtempSync(join(tmpdir(), 'gp-id-'));
    const store = new IdentityStore(dir, silentLogger());
    store.save({ gatewayId: GW, mqttUrl: 'mqtts://x:8883', certPem, keyPem, caPem: ca.certPem });
    for (const f of ['device.key', 'device.crt', 'ca.pem', 'identity.json'])
      expect(statSync(join(dir, 'identity', f)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'identity')).mode & 0o777).toBe(0o700);
    const again = new IdentityStore(dir, silentLogger()).load()!;
    expect(again.gatewayId).toBe(GW);
    expect(again.notAfter).toBeGreaterThan(Date.now());
  });

  it('refuses a certificate for another key or another gateway', async () => {
    const ca = await createTestCa();
    const a = await generateKeyAndCsr('gw-provisioning');
    const b = await generateKeyAndCsr('gw-provisioning');
    const store = new IdentityStore(mkdtempSync(join(tmpdir(), 'gp-id-')), silentLogger());
    const certA = await signCsr(ca, a.csrPem, GW);
    expect(() =>
      store.save({ gatewayId: GW, mqttUrl: 'm', certPem: certA, keyPem: b.keyPem, caPem: ca.certPem }),
    ).toThrow(/does not match/);
    expect(() =>
      store.save({
        gatewayId: '0192a000-0000-7000-8000-00000000bbbb',
        mqttUrl: 'm',
        certPem: certA,
        keyPem: a.keyPem,
        caPem: ca.certPem,
      }),
    ).toThrow(/CN/);
  });

  it('tightens loose permissions on load', async () => {
    const ca = await createTestCa();
    const { keyPem, csrPem } = await generateKeyAndCsr('gw-provisioning');
    const dir = mkdtempSync(join(tmpdir(), 'gp-id-'));
    new IdentityStore(dir, silentLogger()).save({
      gatewayId: GW,
      mqttUrl: 'm',
      certPem: await signCsr(ca, csrPem, GW),
      keyPem,
      caPem: ca.certPem,
    });
    chmodSync(join(dir, 'identity', 'device.key'), 0o644);
    new IdentityStore(dir, silentLogger()).load();
    expect(statSync(join(dir, 'identity', 'device.key')).mode & 0o777).toBe(0o600);
  });

  it('returns null without a complete identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gp-id-'));
    writeFileSync(join(dir, 'x'), '');
    expect(new IdentityStore(dir, silentLogger()).load()).toBeNull();
  });
});

describe('renewal schedule', () => {
  it('is due 11 months after issue (or 30 days before expiry)', () => {
    const nb = Date.parse('2026-01-15T00:00:00Z');
    expect(new Date(renewalDueAt(nb, Date.parse('2027-01-15T00:00:00Z'))).toISOString()).toBe(
      '2026-12-15T00:00:00.000Z',
    );
    expect(new Date(renewalDueAt(nb, Date.parse('2026-06-01T00:00:00Z'))).toISOString()).toBe(
      '2026-05-02T00:00:00.000Z',
    );
  });
});

describe('provisioning codes', () => {
  it('normalises and validates codes from env or the status page', async () => {
    expect(normaliseProvisioningCode(' abcd-1234 efgh ')).toBe('ABCD-1234EFGH');
    const src = new ProvisioningCodeSource();
    const p = src.next();
    expect(src.submit('bad')).toBe(false);
    expect(src.submit('gp7k-q2mx-9tz4')).toBe(true);
    await expect(p).resolves.toBe('GP7K-Q2MX-9TZ4');
    await expect(new ProvisioningCodeSource('env-code-123').next()).resolves.toBe('ENV-CODE-123');
  });
});

describe('device API URL policy', () => {
  it('accepts HTTPS and loopback HTTP only', () => {
    expect(() => assertSecureUrl(new URL('https://api.getproperty.co'))).not.toThrow();
    expect(() => assertSecureUrl(new URL('http://127.0.0.1:3000'))).not.toThrow();
    expect(() => assertSecureUrl(new URL('http://api.getproperty.co'))).toThrow();
  });
});
