/**
 * `pnpm dev:local` — the whole loop on one machine without Docker: in-process MQTT 5 broker (mTLS),
 * API stub with a throwaway CA, reference ingest, and the agent in simulator mode with 20 meters.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Agent } from '../src/agent.js';
import { createLogger, LogRing } from '../src/util/logger.js';
import { meterIds, simConfig, Testbed } from './testbed.js';

async function main(): Promise<void> {
  const tb = await new Testbed({ keepReadings: false }).start();
  const stateDir = resolve('.dev-state', String(Date.now()));
  mkdirSync(stateDir, { recursive: true });
  const caFile = join(stateDir, 'dev-ca.pem');
  writeFileSync(caFile, tb.ca.certPem);
  const code = 'DEV-LOCAL-0001';
  const gatewayId = tb.api.addCode(code);
  const ring = new LogRing();
  const logger = createLogger((process.env.GP_LOG_LEVEL as 'info') ?? 'info', ring);
  const agent = new Agent({
    logger,
    logRing: ring,
    env: {
      ...tb.env(),
      stateDir,
      apiCaFile: caFile,
      provisioningCode: code,
      statusHost: '127.0.0.1',
      statusPort: Number(process.env.GP_STATUS_PORT ?? 8080),
      logLevel: 'info',
    },
  });
  tb.pushConfig(gatewayId, { ...simConfig(meterIds(20)), pollIntervalS: 60 });
  await agent.start();
  logger.info({ gatewayId, status: `http://127.0.0.1:${agent.statusPort}`, broker: tb.broker.port }, 'dev:local ready');
  setInterval(() => {
    logger.info(
      { accepted: tb.ingest.accepted, duplicates: tb.ingest.duplicates, invalid: tb.ingest.invalid },
      'ingest',
    );
  }, 60_000).unref();
  const stop = () => {
    void agent
      .stop()
      .then(() => tb.stop())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
