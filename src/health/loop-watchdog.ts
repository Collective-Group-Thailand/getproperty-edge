import { Worker } from 'node:worker_threads';

/**
 * Event-loop watchdog: the main thread stamps a shared counter every few seconds; a worker thread
 * SIGKILLs the process when the stamp is older than `timeoutS` (a hung loop, a deadlock in a native
 * call). systemd (`Restart=always`) then restarts the agent; the kernel/hardware watchdog driven by
 * systemd's RuntimeWatchdogSec covers a hung OS (scripts/install.sh).
 */
const WORKER_SOURCE = `
const { workerData } = process.getBuiltinModule('node:worker_threads');
const stamp = new Int32Array(workerData.buffer);
const timeoutS = workerData.timeoutS;
setInterval(() => {
  const last = Atomics.load(stamp, 0);
  const now = Math.floor(Date.now() / 1000);
  if (last > 0 && now - last > timeoutS) {
    process._rawDebug('getproperty-edge: event loop stalled for ' + (now - last) + ' s — killing the process');
    process.kill(process.pid, 'SIGKILL');
  }
}, Math.max(200, Math.min(5000, timeoutS * 250)));
`;

export class LoopWatchdog {
  private worker: Worker | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly stamp = new Int32Array(new SharedArrayBuffer(4));

  constructor(private readonly timeoutS = 90) {}

  start(): void {
    const beat = () => Atomics.store(this.stamp, 0, Math.floor(Date.now() / 1000));
    beat();
    this.timer = setInterval(beat, Math.max(100, Math.min(5000, this.timeoutS * 100)));
    this.timer.unref();
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { buffer: this.stamp.buffer, timeoutS: this.timeoutS },
    });
    this.worker.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.terminate();
  }
}
