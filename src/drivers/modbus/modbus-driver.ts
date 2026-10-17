import type { MeterConfig } from '../../protocol/types.js';
import { applyScale, parseMilli } from '../../util/decimal.js';
import { type DriverReading, type MeterDriver, MeterReadError } from '../types.js';
import type { ModbusMaster } from './master.js';
import {
  type Block,
  type BlockData,
  decodeExtras,
  decodeRegisterMilli,
  planBlocks,
  type RegisterMap,
} from './register-map.js';
import { ModbusCrcError, ModbusExceptionError, ModbusFrameError, ModbusTimeoutError } from './rtu.js';

/** Modbus RTU meter driver driven by a register map (one instance per model per bus). */
export class ModbusMeterDriver implements MeterDriver {
  readonly name: string;
  private readonly blocks: Block[];

  constructor(
    private readonly map: RegisterMap,
    private readonly master: ModbusMaster,
  ) {
    this.name = map.driver;
    this.blocks = planBlocks(map);
  }

  async read(meter: MeterConfig): Promise<DriverReading> {
    const address = requireAddress(meter);
    const data: BlockData[] = [];
    for (const b of this.blocks) {
      data.push({
        block: b,
        data: await this.call(() => this.master.readRegisters(address, b.functionCode, b.start, b.count)),
      });
    }
    let registerMilli: bigint;
    try {
      registerMilli = decodeRegisterMilli(this.map, data);
    } catch (err) {
      throw new MeterReadError('crc_error', `undecodable register: ${(err as Error).message}`);
    }
    if (meter.scale && meter.scale !== '1') registerMilli = applyScale(registerMilli, meter.scale);
    const out: DriverReading = { registerMilli, unit: this.map.register.unit, extra: decodeExtras(this.map, data) };
    if (this.map.register.rolloverAt) out.rolloverAtMilli = parseMilli(this.map.register.rolloverAt);
    return out;
  }

  async probe(meter: MeterConfig): Promise<void> {
    const address = requireAddress(meter);
    await this.call(() =>
      this.master.readRegisters(address, this.map.functionCode, this.map.probe.address, this.map.probe.count),
    );
  }

  private async call(fn: () => Promise<Buffer>): Promise<Buffer> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ModbusTimeoutError) throw new MeterReadError('timeout', err.message);
      if (err instanceof ModbusCrcError || err instanceof ModbusFrameError)
        throw new MeterReadError('crc_error', err.message);
      // The device answered but rejects the map's registers: wrong model/address for this binding.
      if (err instanceof ModbusExceptionError) throw new MeterReadError('not_found', err.message);
      throw new MeterReadError('timeout', (err as Error).message);
    }
  }
}

function requireAddress(meter: MeterConfig): number {
  if (meter.address === undefined) throw new MeterReadError('not_found', `meter ${meter.meterId} has no address`);
  return meter.address;
}
