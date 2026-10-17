import { crcOk } from './crc.js';
import { buildExceptionResponse, buildReadResponse } from './rtu.js';
import type { SerialTransport } from './serial.js';

export type RegisterSource = (address: number, fn: number, start: number, count: number) => Buffer | number | null;

/**
 * Byte-level Modbus RTU slave(s) behind a virtual serial port — exercises the real master/driver path
 * in tests and in the simulator. `source` returns register bytes, an exception code, or null (no answer).
 */
export class ModbusSlaveSimulator {
  private rx = Buffer.alloc(0);
  latencyMs = 1;
  /** Corrupts the next N responses' CRC. */
  corruptNext = 0;

  constructor(
    private readonly port: SerialTransport,
    private readonly source: RegisterSource,
  ) {
    port.onData((c) => {
      this.rx = Buffer.concat([this.rx, c]);
      while (this.rx.length >= 8) {
        const frame = this.rx.subarray(0, 8);
        this.rx = this.rx.subarray(8);
        this.handle(Buffer.from(frame));
      }
    });
  }

  async start(): Promise<void> {
    await this.port.open();
  }

  private handle(frame: Buffer): void {
    if (!crcOk(frame)) return; // a real slave stays silent on a bad CRC
    const address = frame[0]!;
    const fn = frame[1]!;
    const start = frame.readUInt16BE(2);
    const count = frame.readUInt16BE(4);
    const res = this.source(address, fn, start, count);
    if (res === null) return;
    let out =
      typeof res === 'number' ? buildExceptionResponse(address, fn, res) : buildReadResponse(address, fn as 3 | 4, res);
    if (this.corruptNext > 0) {
      this.corruptNext--;
      out = Buffer.from(out);
      out[out.length - 1] = out[out.length - 1]! ^ 0xff;
    }
    setTimeout(() => void this.port.write(out), this.latencyMs);
  }
}

/** Big-endian float32 register image helper. */
export function float32Registers(values: Array<[number, number]>, count: number, start = 0): Buffer {
  const b = Buffer.alloc(count * 2);
  for (const [addr, v] of values) {
    const off = (addr - start) * 2;
    if (off >= 0 && off + 4 <= b.length) b.writeFloatBE(v, off);
  }
  return b;
}
