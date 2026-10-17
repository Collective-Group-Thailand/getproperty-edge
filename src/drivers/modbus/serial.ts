import { execFile } from 'node:child_process';
import { constants, promises as fsp } from 'node:fs';
import { promisify } from 'node:util';

import type { BusParity } from '../../protocol/types.js';

/** Byte transport under the Modbus master: a real RS485 tty, or an in-memory pair in tests. */
export interface SerialTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Buffer): Promise<void>;
  /** Registers the single consumer of received bytes. */
  onData(cb: (chunk: Buffer) => void): void;
  readonly isOpen: boolean;
}

export interface SerialSettings {
  device: string;
  baud: number;
  parity: BusParity;
}

/**
 * Linux tty transport without a native addon (keeps the SEA binary self-contained): line settings via
 * `stty`, then plain fd reads in raw mode with VMIN=0/VTIME=1 so a read returns after ≤ 100 ms idle.
 * The RS485 adapter must handle DE/RE direction itself (all common USB-RS485 adapters do).
 * UNVERIFIED against a live adapter — exercised by `pnpm test:hw`.
 */
export class LinuxTtyTransport implements SerialTransport {
  private fh: fsp.FileHandle | undefined;
  private cb: ((chunk: Buffer) => void) | undefined;
  private reading = false;

  constructor(
    private readonly s: SerialSettings,
    private readonly run: (cmd: string, args: string[]) => Promise<unknown> = promisify(execFile),
  ) {}

  get isOpen(): boolean {
    return !!this.fh;
  }

  static sttyArgs(s: SerialSettings): string[] {
    const parity =
      s.parity === 'none' ? ['-parenb'] : s.parity === 'even' ? ['parenb', '-parodd'] : ['parenb', 'parodd'];
    // 8 data bits; 2 stop bits without parity, 1 with parity (Modbus RTU §2.5.1 — 11-bit characters).
    const stop = s.parity === 'none' ? ['cstopb'] : ['-cstopb'];
    return [
      '-F',
      s.device,
      String(s.baud),
      'cs8',
      ...parity,
      ...stop,
      'raw',
      '-echo',
      '-crtscts',
      '-ixon',
      '-ixoff',
      'clocal',
      'cread',
      'min',
      '0',
      'time',
      '1',
    ];
  }

  async open(): Promise<void> {
    if (this.fh) return;
    await this.run('stty', LinuxTtyTransport.sttyArgs(this.s));
    this.fh = await fsp.open(this.s.device, constants.O_RDWR | constants.O_NOCTTY);
    this.reading = true;
    void this.readLoop();
  }

  async close(): Promise<void> {
    this.reading = false;
    const fh = this.fh;
    this.fh = undefined;
    await fh?.close();
  }

  async write(data: Buffer): Promise<void> {
    if (!this.fh) throw new Error(`${this.s.device} not open`);
    await this.fh.write(data);
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.cb = cb;
  }

  private async readLoop(): Promise<void> {
    const buf = Buffer.alloc(256);
    while (this.reading && this.fh) {
      try {
        const { bytesRead } = await this.fh.read(buf, 0, buf.length, null);
        if (bytesRead > 0) this.cb?.(Buffer.from(buf.subarray(0, bytesRead)));
      } catch {
        if (!this.reading) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
}

/** In-memory serial pair: bytes written on one end arrive on the other (tests, simulator, sim:gateway). */
export class VirtualSerialPort implements SerialTransport {
  peer: VirtualSerialPort | undefined;
  private cb: ((chunk: Buffer) => void) | undefined;
  private open_ = false;
  /** Optional hook to corrupt/drop bytes in tests. */
  tamper: ((chunk: Buffer) => Buffer | null) | undefined;
  readonly written: Buffer[] = [];

  get isOpen(): boolean {
    return this.open_;
  }
  async open(): Promise<void> {
    this.open_ = true;
  }
  async close(): Promise<void> {
    this.open_ = false;
  }
  async write(data: Buffer): Promise<void> {
    if (!this.open_) throw new Error('virtual port closed');
    this.written.push(Buffer.from(data));
    const out = this.tamper ? this.tamper(Buffer.from(data)) : Buffer.from(data);
    const peer = this.peer;
    if (out && peer) setImmediate(() => peer.deliver(out));
  }
  onData(cb: (chunk: Buffer) => void): void {
    this.cb = cb;
  }
  private deliver(chunk: Buffer): void {
    if (this.open_) this.cb?.(chunk);
  }
}

export function virtualSerialPair(): [VirtualSerialPort, VirtualSerialPort] {
  const a = new VirtualSerialPort();
  const b = new VirtualSerialPort();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
