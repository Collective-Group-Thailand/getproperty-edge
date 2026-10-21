import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent, type AgentDeps } from '../src/agent.js';
import type { AgentEnv } from '../src/env.js';
import type { GatewayConfig, MeterConfig } from '../src/protocol/types.js';
import { silentLogger } from '../src/util/logger.js';
import { ApiStub } from './api-stub.js';
import { IngestStub } from './ingest-stub.js';
import { createTestCa, issueBrokerCert, issueClientCert, issueServerCert, type TestCa } from './pki.js';
import { TestBroker } from './test-broker.js';

export interface TestbedOptions {
  keepReadings?: boolean;
  /**
   * Platform shape (D-230): the broker presents a certificate issued like `pnpm device:broker-cert --host <host>`
   * and the bootstrap hands out `mqtts://<host>:<port>` (resolved to 127.0.0.1 by `lookup`); the API stub stays the
   * device host. Unset = `mqtts://127.0.0.1:<port>` with a localhost/127.0.0.1 certificate.
   */
  mqttHost?: string;
  /** `mqtt.wsUrl` in the bootstrap answer (the real api: only when MQTT_PUBLIC_WS_URL is set, D-231). */
  mqttWsUrl?: string;
  denyAction?: 'puback' | 'disconnect';
}

/** Resolves every name to 127.0.0.1 (the platform host names of `TestbedOptions.mqttHost`). */
export const loopbackLookup: LookupFunction = (_host, options, cb) => {
  if ((options as { all?: boolean }).all)
    (cb as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
      { address: '127.0.0.1', family: 4 },
    ]);
  else (cb as (e: null, a: string, f: number) => void)(null, '127.0.0.1', 4);
};

/** Broker + API stub + ingest on a throwaway CA: the cloud side for integration tests and dev:local. */
export class Testbed {
  ca!: TestCa;
  broker!: TestBroker;
  api!: ApiStub;
  ingest: IngestStub;
  readonly dirs: string[] = [];

  constructor(private readonly opts: TestbedOptions = {}) {
    this.ingest = new IngestStub(opts);
  }

  async start(): Promise<this> {
    this.ca = await createTestCa();
    const server = await issueServerCert(this.ca);
    const broker = this.opts.mqttHost
      ? await issueBrokerCert(this.ca, this.opts.mqttHost).then((b) => ({ keyPem: b.keyPem, certPem: b.chainPem }))
      : server;
    this.broker = new TestBroker({
      key: broker.keyPem,
      cert: broker.certPem,
      ca: this.ca.certPem,
      ...(this.opts.denyAction ? { denyAction: this.opts.denyAction } : {}),
      onPublish: (cn, topic, payload) => this.ingest.handle(cn, topic, payload),
    });
    const port = await this.broker.start();
    this.api = new ApiStub({
      ca: this.ca,
      server,
      mqttUrl: `mqtts://${this.opts.mqttHost ?? '127.0.0.1'}:${port}`,
      ...(this.opts.mqttWsUrl ? { mqttWsUrl: this.opts.mqttWsUrl } : {}),
      ingest: this.ingest,
    });
    await this.api.start();
    return this;
  }

  async stop(): Promise<void> {
    await this.broker.kill();
    await this.api.stop();
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
  }

  tmpDir(prefix = 'gp-edge-'): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    this.dirs.push(d);
    return d;
  }

  env(over: Partial<AgentEnv> = {}): AgentEnv {
    const caFile = join(this.tmpDir('gp-ca-'), 'api-ca.pem');
    writeFileSync(caFile, this.ca.certPem);
    return {
      stateDir: this.tmpDir(),
      apiBaseUrl: this.api.baseUrl,
      apiCaFile: caFile,
      provisioningCode: undefined,
      timeZone: 'Asia/Bangkok',
      driverMode: 'simulator',
      simConfig: undefined,
      mqttUrlOverride: undefined,
      mqttServername: undefined,
      mqttWsFallback: false,
      httpsFallbackAfterS: 0,
      configPullAfterS: 0,
      queueCapacity: 1_000_000,
      statusHost: '127.0.0.1',
      statusPort: 0,
      logLevel: 'silent',
      gpioChip: 'gpiochip0',
      ledName: undefined,
      otaRoot: '/nonexistent',
      serialNumber: 'TEST-SERIAL',
      ...over,
    };
  }

  /** An agent provisioned against this testbed (code registered with the API stub). */
  agent(over: Omit<Partial<AgentDeps>, 'env'> & { env?: Partial<AgentEnv>; code?: string } = {}): {
    agent: Agent;
    gatewayId: string;
  } {
    const code = over.code ?? `TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const gatewayId = this.api.addCode(code);
    const { env: envOver, code: _c, ...rest } = over;
    const agent = new Agent({
      logger: silentLogger(),
      jitterMaxMs: 0,
      statusPage: false,
      mqtt: {
        backoffBaseMs: 50,
        backoffMaxMs: 300,
        connectTimeoutMs: 3000,
        ...(this.opts.mqttHost ? { lookup: loopbackLookup } : {}),
      },
      forwarder: { retryBaseMs: 50, retryMaxMs: 300 },
      ...rest,
      env: this.env({ provisioningCode: code, ...envOver }),
    });
    return { agent, gatewayId };
  }

  /** Publishes a retained config like the cloud does. */
  pushConfig(gatewayId: string, cfg: GatewayConfig): void {
    this.broker.publish(`gp/v1/${gatewayId}/config`, JSON.stringify(cfg), { retain: true });
    this.api.configs.set(gatewayId, cfg);
  }

  async cloudClientCert(): Promise<{ certPem: string; keyPem: string }> {
    return issueClientCert(this.ca, 'cloud');
  }
}

export function meterIds(n: number, prefix = '0192a000-0000-7000-8000'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(12, '0')}`);
}

export function simConfig(meterIdsList: string[], version = 1, over: Partial<GatewayConfig> = {}): GatewayConfig {
  const meters: MeterConfig[] = meterIdsList.map((id, i) => ({
    meterId: id,
    roomCode: `A-${String(101 + i)}`,
    driver: 'eastron_sdm120',
    bus: `rs485-${Math.floor(i / 200) + 1}`,
    address: (i % 200) + 1,
    unit: 'kwh',
    registerMap: 'driver_default',
    scale: '1',
  }));
  return {
    version,
    pollIntervalS: 900,
    heartbeatS: 60,
    buses: Array.from({ length: Math.max(1, Math.ceil(meterIdsList.length / 200)) }, (_, b) => ({
      id: `rs485-${b + 1}`,
      type: 'modbus_rtu' as const,
      device: `/dev/ttyUSB${b}`,
      baud: 9600 as const,
      parity: 'none' as const,
    })),
    meters,
    ...over,
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
