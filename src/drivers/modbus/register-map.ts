import { applyScale, milliFromNumber, parseMilli } from '../../util/decimal.js';
import sdm120 from './maps/eastron_sdm120.json' with { type: 'json' };
import sdm230 from './maps/eastron_sdm230.json' with { type: 'json' };
import type { ReadFunction } from './rtu.js';

export type ValueType = 'float32' | 'uint32' | 'int32' | 'uint16' | 'int16';

export interface MapEntry {
  address: number;
  type: ValueType;
  /** Decimal multiplier applied to the raw value (e.g. "0.01" for a counter in 10 Wh steps). */
  scale?: string;
  decimals?: number;
}

/**
 * Generic register-map format: a new Modbus meter model is one JSON file in `maps/` plus golden tests.
 */
export interface RegisterMap {
  driver: string;
  model: string;
  source?: string;
  functionCode: ReadFunction;
  wordOrder: 'big' | 'little';
  maxBlockRegisters: number;
  register: MapEntry & { unit: 'kwh' | 'm3'; rolloverAt?: string };
  extras: Record<string, MapEntry>;
  probe: { address: number; count: number };
}

const WIDTH: Record<ValueType, number> = { float32: 2, uint32: 2, int32: 2, uint16: 1, int16: 1 };

export const BUILTIN_MAPS: Record<string, RegisterMap> = Object.fromEntries(
  [sdm120 as RegisterMap, sdm230 as RegisterMap].map((m) => [m.driver, validateMap(m)]),
);

export function validateMap(m: RegisterMap): RegisterMap {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(m.driver)) throw new Error(`bad driver name ${m.driver}`);
  if (m.functionCode !== 3 && m.functionCode !== 4) throw new Error(`${m.driver}: functionCode must be 3 or 4`);
  if (m.maxBlockRegisters < 2 || m.maxBlockRegisters > 125) throw new Error(`${m.driver}: maxBlockRegisters`);
  for (const [name, e] of Object.entries({ register: m.register, ...m.extras })) {
    if (!(e.type in WIDTH)) throw new Error(`${m.driver}.${name}: type ${e.type as string}`);
    if (e.address < 0 || e.address > 0xffff) throw new Error(`${m.driver}.${name}: address`);
  }
  if (m.register.rolloverAt) parseMilli(m.register.rolloverAt);
  return m;
}

export interface Block {
  start: number;
  count: number;
}

/** Groups the map's registers into as few contiguous reads as `maxBlockRegisters` allows. */
export function planBlocks(m: RegisterMap): Block[] {
  const spans = [m.register, ...Object.values(m.extras)]
    .map((e) => ({ start: e.address, end: e.address + WIDTH[e.type] }))
    .sort((a, b) => a.start - b.start);
  const blocks: Block[] = [];
  for (const s of spans) {
    const cur = blocks[blocks.length - 1];
    if (cur && s.end - cur.start <= m.maxBlockRegisters) {
      cur.count = Math.max(cur.count, s.end - cur.start);
    } else {
      blocks.push({ start: s.start, count: s.end - s.start });
    }
  }
  return blocks;
}

function words(m: RegisterMap, blocks: Map<number, Buffer>, e: MapEntry): Buffer {
  for (const [start, data] of blocks) {
    const off = (e.address - start) * 2;
    const len = WIDTH[e.type] * 2;
    if (off >= 0 && off + len <= data.length) {
      const w = Buffer.from(data.subarray(off, off + len));
      if (len === 4 && m.wordOrder === 'little') return Buffer.concat([w.subarray(2, 4), w.subarray(0, 2)]);
      return w;
    }
  }
  throw new Error(`register ${e.address} not covered by the read plan`);
}

export function decodeNumber(m: RegisterMap, blocks: Map<number, Buffer>, e: MapEntry): number {
  const w = words(m, blocks, e);
  switch (e.type) {
    case 'float32':
      return w.readFloatBE(0);
    case 'uint32':
      return w.readUInt32BE(0);
    case 'int32':
      return w.readInt32BE(0);
    case 'uint16':
      return w.readUInt16BE(0);
    case 'int16':
      return w.readInt16BE(0);
  }
}

/** Register value in milli-units; integers are scaled exactly, floats are rounded to 3 decimals first. */
export function decodeRegisterMilli(m: RegisterMap, blocks: Map<number, Buffer>): bigint {
  const e = m.register;
  const v = decodeNumber(m, blocks, e);
  if (e.type === 'float32') {
    if (!Number.isFinite(v) || v < 0) throw new Error(`implausible register ${v}`);
    return applyScale(milliFromNumber(v), e.scale ?? '1');
  }
  if (v < 0) throw new Error(`negative register ${v}`);
  return applyScale(BigInt(v) * 1000n, e.scale ?? '1');
}

export function decodeExtras(m: RegisterMap, blocks: Map<number, Buffer>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, e] of Object.entries(m.extras)) {
    let v = decodeNumber(m, blocks, e);
    if (!Number.isFinite(v)) continue;
    if (e.scale) v *= Number(e.scale);
    const f = 10 ** (e.decimals ?? 3);
    out[name] = Math.round(v * f) / f;
  }
  return out;
}
