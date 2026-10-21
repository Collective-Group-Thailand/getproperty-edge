import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReadingQueue } from '../../src/queue/reading-queue.js';
import { openDb } from '../../src/storage/db.js';
import { meterIds, simConfig, Testbed, waitFor } from '../../tools/testbed.js';

/**
 * Resource budget of the real agent process (bundled build, simulator mode, 300 meters, 60-s polling)
 * while it drains a 2-day outage backlog (57,600 readings) and keeps polling: peak RSS < 200 MB
 * (master plan §5), CPU reported for the drain and for steady state.
 */
const METERS = 300;
const BACKLOG_DAYS = 2;

function rssMb(pid: number): number {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return m ? Number(m[1]) / 1024 : 0;
}
function cpuTicks(pid: number): number {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  return Number(f[11]) + Number(f[12]); // utime + stime (fields 14, 15)
}

describe('agent process resource budget', () => {
  let tb: Testbed;
  let child: ChildProcess | undefined;
  beforeAll(async () => {
    tb = await new Testbed({ keepReadings: false }).start();
    // always rebuild: a stale bundle would measure (and log in as) an older agent — protocol 1.2 refuses those
    execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  });
  afterAll(async () => {
    child?.kill('SIGKILL');
    await tb.stop();
  });

  it(`300 meters + ${BACKLOG_DAYS}-day backlog: peak RSS < 200 MB`, async () => {
    const ids = meterIds(METERS, '0192a000-0000-7000-8098');
    const env = tb.env();
    const code = 'BUDGET-CODE-0001';
    const gatewayId = tb.api.addCode(code);
    // pre-fill the on-disk queue with the backlog of a 2-day outage
    const db = openDb(join(env.stateDir, 'agent.db'));
    const q = new ReadingQueue(db);
    const t0 = Date.parse('2026-10-30T00:00:00+07:00');
    for (let tick = 0; tick < BACKLOG_DAYS * 96; tick++) {
      q.append(
        ids.map((meterId, i) => ({
          meterId,
          readAtMs: t0 + tick * 900_000,
          readAt: new Date(t0 + tick * 900_000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
          register: (1000 + i + tick * 0.125).toFixed(3),
          unit: 'kwh' as const,
          quality: 'good' as const,
          configVersion: 1,
        })),
      );
    }
    db.close();
    const backlog = BACKLOG_DAYS * 96 * METERS;
    tb.pushConfig(gatewayId, { ...simConfig(ids, 1), pollIntervalS: 60 });
    const caFile = join(env.stateDir, 'api-ca.pem');
    writeFileSync(caFile, tb.ca.certPem);
    child = spawn(process.execPath, ['dist/getproperty-edge.cjs'], {
      env: {
        PATH: process.env.PATH ?? '',
        GP_STATE_DIR: env.stateDir,
        GP_API_URL: tb.api.baseUrl,
        GP_API_CA_FILE: caFile,
        GP_PROVISIONING_CODE: code,
        GP_DRIVER_MODE: 'simulator',
        GP_STATUS_HOST: '127.0.0.1',
        GP_STATUS_PORT: '0',
        GP_LOG_LEVEL: 'warn',
        GP_HTTPS_FALLBACK_AFTER_S: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const pid = child.pid!;
    let peak = 0;
    const samples: number[] = [];
    const sampler = setInterval(() => {
      try {
        const r = rssMb(pid);
        samples.push(r);
        peak = Math.max(peak, r);
      } catch {
        /* exited */
      }
    }, 100);
    const start = Date.now();
    // drained = the backlog plus the boot read of every meter (otherwise the boot read, delivered right
    // after the backlog, would be counted as the steady-state cycle over a ~0-s window)
    await waitFor(() => tb.ingest.accepted >= backlog + METERS, 120_000, 50);
    const drainS = (Date.now() - start) / 1000;
    const cpuAfterDrain = cpuTicks(pid);
    // steady state: one full 60-s polling cycle of 300 meters after the drain
    const before = tb.ingest.accepted;
    await waitFor(() => tb.ingest.accepted >= before + METERS, 150_000, 100);
    const steadyWall = (Date.now() - start) / 1000 - drainS;
    const steadyCpuS = (cpuTicks(pid) - cpuAfterDrain) / 100;
    clearInterval(sampler);
    const report = {
      backlog,
      drainS: Math.round(drainS * 10) / 10,
      drainCpuS: Math.round((cpuAfterDrain / 100) * 10) / 10,
      steadyWallS: Math.round(steadyWall),
      steadyCpuPct: Math.round((steadyCpuS / steadyWall) * 1000) / 10,
      peakRssMb: Math.round(peak),
      finalRssMb: Math.round(samples.at(-1) ?? 0),
      duplicates: tb.ingest.duplicates,
    };
    console.log(`agent budget ${JSON.stringify(report)}`);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/agent-budget.json', JSON.stringify(report, null, 2) + '\n');
    expect(tb.ingest.gaps()).toEqual([]);
    expect(peak).toBeLessThan(200);
    // 60-s polling here is 15× the production rate; even so the steady-state CPU stays low
    expect(report.steadyCpuPct).toBeLessThan(10);
    child.kill('SIGTERM');
    await new Promise((r) => child!.once('exit', r));
  });
});
