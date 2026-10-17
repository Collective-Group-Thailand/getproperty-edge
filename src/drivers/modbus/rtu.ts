import { crcOk, withCrc } from './crc.js';

export type ReadFunction = 0x03 | 0x04;

export class ModbusTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModbusTimeoutError';
  }
}
export class ModbusCrcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModbusCrcError';
  }
}
export class ModbusExceptionError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModbusExceptionError';
  }
}
export class ModbusFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModbusFrameError';
  }
}

/** Read Holding (0x03) / Input (0x04) Registers request ADU. */
export function buildReadRequest(address: number, fn: ReadFunction, start: number, count: number): Buffer {
  if (address < 1 || address > 247) throw new RangeError(`slave address ${address}`);
  if (count < 1 || count > 125) throw new RangeError(`register count ${count}`);
  const b = Buffer.alloc(6);
  b[0] = address;
  b[1] = fn;
  b.writeUInt16BE(start, 2);
  b.writeUInt16BE(count, 4);
  return withCrc(b);
}

/** Response ADU for a read (used by the slave simulator and golden tests). */
export function buildReadResponse(address: number, fn: ReadFunction, registers: Buffer): Buffer {
  const b = Buffer.alloc(3 + registers.length);
  b[0] = address;
  b[1] = fn;
  b[2] = registers.length;
  registers.copy(b, 3);
  return withCrc(b);
}

export function buildExceptionResponse(address: number, fn: number, code: number): Buffer {
  return withCrc(Buffer.from([address, fn | 0x80, code]));
}

/**
 * How many bytes the response frame has, once enough header bytes arrived; null = need more.
 * Normal read response: addr, fn, byteCount, data…, crcLo, crcHi. Exception: addr, fn|0x80, code, crc×2.
 */
export function expectedResponseLength(partial: Uint8Array): number | null {
  if (partial.length < 2) return null;
  if (partial[1]! & 0x80) return 5;
  if (partial.length < 3) return null;
  return 5 + partial[2]!;
}

/** Validates a complete response frame and returns the register bytes. */
export function parseReadResponse(frame: Uint8Array, address: number, fn: ReadFunction, count: number): Buffer {
  if (!crcOk(frame)) throw new ModbusCrcError(`CRC mismatch from slave ${address}`);
  if (frame[0] !== address) throw new ModbusFrameError(`response from slave ${frame[0]} while polling ${address}`);
  if (frame[1] === (fn | 0x80)) throw new ModbusExceptionError(frame[2]!, `slave ${address} exception ${frame[2]}`);
  if (frame[1] !== fn) throw new ModbusFrameError(`unexpected function ${frame[1]}`);
  if (frame[2] !== count * 2) throw new ModbusFrameError(`byte count ${frame[2]} ≠ ${count * 2}`);
  return Buffer.from(frame.subarray(3, 3 + count * 2));
}

/** Modbus RTU silent interval t3.5 (spec: 1.75 ms fixed above 19200 baud; 11 bits per character). */
export function t35Ms(baud: number): number {
  return baud > 19200 ? 1.75 : (3.5 * 11 * 1000) / baud;
}
