import 'reflect-metadata';

import { randomBytes, webcrypto } from 'node:crypto';

import * as x509 from '@peculiar/x509';

/**
 * Throwaway PKI for tests and `pnpm dev:local`: a CA, a broker/API server certificate and CSR signing
 * the way getproperty-api's device CA does it (CN = gw-<gatewayId>, clientAuth). Never used in production.
 */
x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);
const EC = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export interface TestCa {
  certPem: string;
  keyPem: string;
  cert: x509.X509Certificate;
  keys: webcrypto.CryptoKeyPair;
}

function pem(der: ArrayBuffer, label: string): string {
  return `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END ${label}-----\n`;
}

const serial = () =>
  randomBytes(8)
    .toString('hex')
    .replace(/^[89a-f]/, '1');

async function keys(): Promise<webcrypto.CryptoKeyPair> {
  return await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify']);
}

async function keyPem(k: webcrypto.CryptoKeyPair): Promise<string> {
  return pem(await webcrypto.subtle.exportKey('pkcs8', k.privateKey), 'PRIVATE KEY');
}

export async function createTestCa(cn = 'getproperty test device CA'): Promise<TestCa> {
  const k = await keys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=${cn}`,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
    keys: k,
    signingAlgorithm: EC,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });
  return { certPem: cert.toString('pem') + '\n', keyPem: await keyPem(k), cert, keys: k };
}

async function issue(
  ca: TestCa,
  subjectCn: string,
  publicKey: webcrypto.CryptoKey | x509.PublicKey,
  ext: x509.Extension[],
  opts: { notBefore?: Date; days?: number } = {},
): Promise<string> {
  const notBefore = opts.notBefore ?? new Date(Date.now() - 60_000);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${subjectCn}`,
    issuer: ca.cert.subject,
    notBefore,
    notAfter: new Date(notBefore.getTime() + (opts.days ?? 365) * 86_400_000),
    publicKey: publicKey as webcrypto.CryptoKey,
    signingKey: ca.keys.privateKey,
    signingAlgorithm: EC,
    extensions: ext,
  });
  return cert.toString('pem') + '\n';
}

export async function issueServerCert(
  ca: TestCa,
  hosts = ['localhost', '127.0.0.1'],
): Promise<{ certPem: string; keyPem: string }> {
  const k = await keys();
  const san = new x509.SubjectAlternativeNameExtension(
    hosts.map((h) => (/^[\d.]+$/.test(h) ? { type: 'ip' as const, value: h } : { type: 'dns' as const, value: h })),
  );
  const certPem = await issue(ca, hosts[0]!, k.publicKey, [
    san,
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
  ]);
  return { certPem, keyPem: await keyPem(k) };
}

export async function issueClientCert(ca: TestCa, cn: string): Promise<{ certPem: string; keyPem: string }> {
  const k = await keys();
  const certPem = await issue(ca, cn, k.publicKey, [
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
  ]);
  return { certPem, keyPem: await keyPem(k) };
}

/** Signs a gateway CSR like the cloud device CA: verifies the CSR signature, sets CN = gw-<gatewayId>. */
export async function signCsr(
  ca: TestCa,
  csrPem: string,
  gatewayId: string,
  opts: { notBefore?: Date; days?: number } = {},
): Promise<string> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  if (!(await csr.verify())) throw new Error('CSR signature invalid');
  return issue(
    ca,
    `gw-${gatewayId}`,
    csr.publicKey,
    [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    ],
    opts,
  );
}
