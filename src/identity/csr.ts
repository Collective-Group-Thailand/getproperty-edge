import 'reflect-metadata';

import { createPrivateKey, createPublicKey, webcrypto, X509Certificate } from 'node:crypto';

import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const EC = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export interface KeyAndCsr {
  keyPem: string;
  csrPem: string;
}

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

/** Generates the device key (ECDSA P-256, never leaves the gateway) and a PKCS#10 CSR for it. */
export async function generateKeyAndCsr(commonName: string): Promise<KeyAndCsr> {
  const keys = await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: EC,
    extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { keyPem: toPem(pkcs8, 'PRIVATE KEY'), csrPem: csr.toString('pem') + '\n' };
}

export interface CertInfo {
  subjectCn: string | null;
  notBefore: number;
  notAfter: number;
  fingerprint256: string;
}

/** First certificate of a PEM bundle. */
export function parseCert(pem: string): CertInfo {
  const cert = new X509Certificate(firstPem(pem));
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1] ?? null;
  return {
    subjectCn: cn,
    notBefore: Date.parse(cert.validFrom),
    notAfter: Date.parse(cert.validTo),
    fingerprint256: cert.fingerprint256,
  };
}

/** True when the certificate was issued for this private key. */
export function certMatchesKey(certPem: string, keyPem: string): boolean {
  const cert = new X509Certificate(firstPem(certPem));
  const a = cert.publicKey.export({ type: 'spki', format: 'der' });
  const b = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
  return Buffer.compare(a, b) === 0;
}

export function firstPem(bundle: string): string {
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(bundle);
  if (!m) throw new Error('no certificate in PEM');
  return m[0] + '\n';
}
