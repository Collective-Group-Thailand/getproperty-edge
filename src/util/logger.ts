import { Writable } from 'node:stream';

import pino, { type LevelWithSilent, type Logger } from 'pino';

export type { Logger };

/** Keeps the last N log lines in memory for `upload_logs` (journald holds the long history). */
export class LogRing extends Writable {
  private lines: string[] = [];
  constructor(private readonly max = 5000) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line) continue;
      this.lines.push(line);
    }
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    cb();
  }
  snapshot(): string {
    return this.lines.join('\n') + (this.lines.length ? '\n' : '');
  }
}

/** Never log certificates, keys, tokens or provisioning codes. */
const REDACT = [
  'provisioningCode',
  '*.provisioningCode',
  'accessToken',
  '*.accessToken',
  'privateKey',
  '*.privateKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
];

export function createLogger(level: LevelWithSilent, ring?: LogRing, stdout = true): Logger {
  const streams: pino.StreamEntry[] = [];
  if (stdout) streams.push({ level: 'trace', stream: process.stdout });
  if (ring) streams.push({ level: 'trace', stream: ring });
  return pino(
    { level, base: { svc: 'getproperty-edge' }, redact: { paths: REDACT, censor: '[redacted]' } },
    pino.multistream(streams),
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
