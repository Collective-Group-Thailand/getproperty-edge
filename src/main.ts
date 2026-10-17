import { Agent } from './agent.js';
import { loadEnv } from './env.js';
import { SystemdClockSync } from './scheduler/clock-sync.js';
import { createLogger, LogRing } from './util/logger.js';
import { AGENT_VERSION } from './version.js';

/** Process entry (SEA binary / `pnpm dev`): env → agent; SIGTERM/SIGINT stop gracefully. */
async function main(): Promise<void> {
  const env = loadEnv();
  const ring = new LogRing();
  const logger = createLogger(env.logLevel, ring);
  logger.info({ version: AGENT_VERSION, mode: env.driverMode, stateDir: env.stateDir }, 'getproperty-edge starting');
  const clockSync = new SystemdClockSync(logger);
  clockSync.start();
  const agent = new Agent({ env, logger, logRing: ring, clockSync });
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ sig }, 'stopping');
    clockSync.stop();
    agent.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err: (err as Error).message }, 'stop failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await agent.start();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`getproperty-edge: fatal: ${(err as Error).message}`);
  process.exit(1);
});
