import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('event-loop watchdog', () => {
  it('SIGKILLs a process whose event loop stalls longer than the timeout', () => {
    const script = `
      import { LoopWatchdog } from './src/health/loop-watchdog.ts';
      const w = new LoopWatchdog(1);
      w.start();
      setTimeout(() => { const end = Date.now() + 6000; while (Date.now() < end) {} process.exit(0); }, 300);
      setTimeout(() => {}, 10000);
    `;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.signal, r.stderr).toBe('SIGKILL');
    expect(r.stderr).toContain('event loop stalled');
  });

  it('leaves a healthy process alone', () => {
    const script = `
      import { LoopWatchdog } from './src/health/loop-watchdog.ts';
      const w = new LoopWatchdog(1);
      w.start();
      setTimeout(async () => { await w.stop(); process.exit(0); }, 2500);
    `;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
