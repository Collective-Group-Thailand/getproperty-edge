import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import type { Logger } from '../../util/logger.js';

/** Edge callback: GPIO line offset and a timestamp in ms (kernel event clock where available). */
export type EdgeHandler = (pin: number, tsMs: number) => void;

export interface PulseSource {
  start(pins: number[], onEdge: EdgeHandler): Promise<void>;
  stop(): Promise<void>;
}

/** Test/simulator source: pulses are injected with `emit`. */
export class SimulatedPulseSource implements PulseSource {
  private handler: EdgeHandler | undefined;
  pins: number[] = [];
  async start(pins: number[], onEdge: EdgeHandler): Promise<void> {
    this.pins = pins;
    this.handler = onEdge;
  }
  async stop(): Promise<void> {
    this.handler = undefined;
  }
  emit(pin: number, tsMs: number): void {
    if (this.pins.includes(pin)) this.handler?.(pin, tsMs);
  }
}

export type GpiodMajor = 1 | 2;

/** `gpiomon` argument list for libgpiod v1.x (Debian bookworm / Raspberry Pi OS) and v2.x. */
export function gpiomonArgs(major: GpiodMajor, chip: string, pins: number[]): string[] {
  const offsets = pins.map(String);
  if (major === 1) return ['--falling-edge', '--format=%o %s %n', chip, ...offsets];
  return ['--chip', chip, '--edges', 'falling', '--event-clock', 'monotonic', '--format', '%o %S', ...offsets];
}

/** Parses one gpiomon output line (`17 1712345678 123456789` for v1, `17 1712345678.123456789` for v2). */
export function parseGpiomonLine(line: string): { pin: number; tsMs: number } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const pin = Number(parts[0]);
  if (!Number.isInteger(pin) || pin < 0) return null;
  let tsMs: number;
  if (parts.length >= 3 && /^\d+$/.test(parts[1]!) && /^\d+$/.test(parts[2]!)) {
    tsMs = Number(parts[1]) * 1000 + Number(parts[2]) / 1e6;
  } else if (/^\d+(\.\d+)?$/.test(parts[1]!)) {
    tsMs = Number(parts[1]) * 1000;
  } else return null;
  return Number.isFinite(tsMs) ? { pin, tsMs } : null;
}

export function parseGpiodVersion(out: string): GpiodMajor {
  const m = /v(\d+)\./.exec(out);
  return m && Number(m[1]) >= 2 ? 2 : 1;
}

type Spawn = (cmd: string, args: string[]) => ChildProcess;

/**
 * Real GPIO backend: a `gpiomon` (libgpiod CLI) child process streaming falling edges; restarted with
 * backoff if it exits. Uses the character-device API, not the deprecated /sys/class/gpio.
 * UNVERIFIED against the carrier board — exercised by `pnpm test:hw`.
 */
export class GpiomonPulseSource implements PulseSource {
  private child: ChildProcess | undefined;
  private stopped = true;
  private restartDelay = 1000;

  constructor(
    private readonly chip: string,
    private readonly logger: Logger,
    private readonly spawnFn: Spawn = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    private readonly versionFn: () => Promise<string> = async () =>
      (await promisify(execFile)('gpiomon', ['--version'])).stdout,
  ) {}

  async start(pins: number[], onEdge: EdgeHandler): Promise<void> {
    if (pins.length === 0) return;
    this.stopped = false;
    let major: GpiodMajor = 1;
    try {
      major = parseGpiodVersion(await this.versionFn());
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'gpiomon --version failed; assuming libgpiod v1');
    }
    const launch = (): void => {
      const child = this.spawnFn('gpiomon', gpiomonArgs(major, this.chip, pins));
      this.child = child;
      if (child.stdout) {
        createInterface({ input: child.stdout }).on('line', (line) => {
          const ev = parseGpiomonLine(line);
          if (ev) onEdge(ev.pin, ev.tsMs);
        });
      }
      child.stderr?.on('data', (d: Buffer) => this.logger.warn({ msg: d.toString().trim() }, 'gpiomon stderr'));
      child.on('exit', (code) => {
        if (this.stopped) return;
        this.logger.error({ code }, 'gpiomon exited; restarting');
        setTimeout(launch, this.restartDelay).unref();
        this.restartDelay = Math.min(this.restartDelay * 2, 60_000);
      });
    };
    launch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child?.kill('SIGTERM');
    this.child = undefined;
  }
}
