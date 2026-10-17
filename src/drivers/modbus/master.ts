import type { Logger } from '../../util/logger.js';
import {
  buildReadRequest,
  expectedResponseLength,
  ModbusCrcError,
  ModbusExceptionError,
  ModbusFrameError,
  ModbusTimeoutError,
  parseReadResponse,
  type ReadFunction,
  t35Ms,
} from './rtu.js';
import type { SerialTransport } from './serial.js';

export interface ModbusMasterOptions {
  baud: number;
  /** Response timeout per attempt. */
  timeoutMs?: number;
  /** Extra attempts after a timeout / CRC error / framing error. */
  retries?: number;
  /** Silent gap enforced between frames (defaults to t3.5, at least 2 ms for USB adapters' latency). */
  interFrameMs?: number;
  logger?: Logger;
}

export interface BusStats {
  requests: number;
  timeouts: number;
  crcErrors: number;
  exceptions: number;
}

/**
 * Modbus RTU master for one RS485 bus. Exactly one request is in flight per bus (RS485 is half-duplex,
 * shared by every meter on it); requests queue in call order.
 */
export class ModbusMaster {
  private chain: Promise<unknown> = Promise.resolve();
  private rx: Buffer = Buffer.alloc(0);
  private waiter: ((b: Buffer) => void) | undefined;
  private lastActivity = 0;
  readonly stats: BusStats = { requests: 0, timeouts: 0, crcErrors: 0, exceptions: 0 };

  constructor(
    private readonly port: SerialTransport,
    private readonly o: ModbusMasterOptions,
  ) {
    port.onData((chunk) => {
      this.lastActivity = performance.now();
      this.rx = Buffer.concat([this.rx, chunk]);
      this.waiter?.(this.rx);
    });
  }

  async open(): Promise<void> {
    await this.port.open();
  }

  async close(): Promise<void> {
    await this.port.close();
  }

  get isOpen(): boolean {
    return this.port.isOpen;
  }

  /** Reads `count` registers; retries on timeout/CRC/framing errors, never on a Modbus exception. */
  readRegisters(address: number, fn: ReadFunction, start: number, count: number): Promise<Buffer> {
    const run = async (): Promise<Buffer> => {
      const attempts = 1 + (this.o.retries ?? 2);
      let last: Error = new ModbusTimeoutError('no attempt');
      for (let i = 0; i < attempts; i++) {
        try {
          return await this.transact(address, fn, start, count);
        } catch (err) {
          if (err instanceof ModbusExceptionError) {
            this.stats.exceptions++;
            throw err;
          }
          if (err instanceof ModbusTimeoutError) this.stats.timeouts++;
          if (err instanceof ModbusCrcError) this.stats.crcErrors++;
          last = err as Error;
          this.o.logger?.debug({ address, attempt: i + 1, err: last.message }, 'modbus attempt failed');
        }
      }
      throw last;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async transact(address: number, fn: ReadFunction, start: number, count: number): Promise<Buffer> {
    await this.quietGap();
    this.rx = Buffer.alloc(0);
    this.stats.requests++;
    const req = buildReadRequest(address, fn, start, count);
    const timeoutMs = this.o.timeoutMs ?? 500;
    const frame = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new ModbusTimeoutError(`slave ${address} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiter = (buf) => {
        const need = expectedResponseLength(buf);
        if (need === null || buf.length < need) return;
        clearTimeout(timer);
        this.waiter = undefined;
        resolve(Buffer.from(buf.subarray(0, need)));
      };
      this.port.write(req).then(
        () => {
          this.lastActivity = performance.now();
        },
        (err: Error) => {
          clearTimeout(timer);
          this.waiter = undefined;
          reject(new ModbusFrameError(`write failed: ${err.message}`));
        },
      );
    });
    return parseReadResponse(frame, address, fn, count);
  }

  private async quietGap(): Promise<void> {
    const gap = this.o.interFrameMs ?? Math.max(2, t35Ms(this.o.baud));
    const wait = this.lastActivity + gap - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.ceil(wait)));
  }
}
