import type { CustomRegisterMap, MeterConfig, RegisterDef } from '../../protocol/types.js';
import { applyScale, milliFromNumber, parseMilli } from '../../util/decimal.js';
import sdm120 from './maps/eastron_sdm120.json' with { type: 'json' };
import sdm230 from './maps/eastron_sdm230.json' with { type: 'json' };
import type { ReadFunction } from './rtu.js';

export type ValueType = 'float32' | 'uint32' | 'int32' | 'uint16' | 'int16' | 'uint64' | 'float64';

export interface MapEntry {
  address: number;
  type: ValueType;
  /** Decimal multiplier applied to the raw value (e.g. "0.01" for a counter in 10 Wh steps). */
  scale?: string;
  decimals?: number;
  /** Per-register function code (custom maps mix holding and input registers); default: the map's. */
  functionCode?: ReadFunction;
  /** Per-register word order; default: the map's. */
  wordOrder?: 'big' | 'little';
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

const WIDTH: Record<ValueType, number> = {
  float32: 2,
  uint32: 2,
  int32: 2,
  uint16: 1,
  int16: 1,
  uint64: 4,
  float64: 4,
};

/** Registers read by one request: `count` registers from `start` with `functionCode`. */

export const BUILTIN_MAPS: Record<string, RegisterMap> = Object.fromEntries(
  [sdm120 as RegisterMap, sdm230 as RegisterMap].map((m) => [m.driver, validateMap(m)]),
);

export function validateMap(m: RegisterMap): RegisterMap {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(m.driver)) throw new Error(`bad driver name ${m.driver}`);
  if (m.functionCode !== 3 && m.functionCode !== 4) throw new Error(`${m.driver}: functionCode must be 3 or 4`);
  if (m.maxBlockRegisters < 2 || m.maxBlockRegisters > 125) throw new Error(`${m.driver}: maxBlockRegisters`);
  for (const [name, e] of Object.entries({ register: m.register, ...m.extras })) {
    if (!(e.type in WIDTH)) throw new Error(`${m.driver}.${name}: type ${e.type as string}`);
    if (e.address < 0 || e.address + WIDTH[e.type] - 1 > 0xffff) throw new Error(`${m.driver}.${name}: address`);
    if (e.functionCode !== undefined && e.functionCode !== 3 && e.functionCode !== 4)
      throw new Error(`${m.driver}.${name}: functionCode must be 3 or 4`);
    if (e.scale !== undefined) applyScale(1000n, e.scale);
  }
  if (m.register.rolloverAt) parseMilli(m.register.rolloverAt);
  return m;
}

export interface Block {
  functionCode: ReadFunction;
  start: number;
  count: number;
}

/** Data read for one block of the plan. */
export interface BlockData {
  block: Block;
  data: Buffer;
}

const fcOf = (m: RegisterMap, e: MapEntry): ReadFunction => e.functionCode ?? m.functionCode;

/**
 * Groups the map's registers into as few contiguous reads as `maxBlockRegisters` allows, one group per
 * function code (holding and input registers are separate address spaces).
 */
export function planBlocks(m: RegisterMap): Block[] {
  const spans = [m.register, ...Object.values(m.extras)]
    .map((e) => ({ fc: fcOf(m, e), start: e.address, end: e.address + WIDTH[e.type] }))
    .sort((a, b) => a.fc - b.fc || a.start - b.start);
  const blocks: Block[] = [];
  for (const s of spans) {
    const cur = blocks[blocks.length - 1];
    if (cur && cur.functionCode === s.fc && s.end - cur.start <= m.maxBlockRegisters) {
      cur.count = Math.max(cur.count, s.end - cur.start);
    } else {
      blocks.push({ functionCode: s.fc, start: s.start, count: s.end - s.start });
    }
  }
  return blocks;
}

function words(m: RegisterMap, blocks: BlockData[], e: MapEntry): Buffer {
  const fc = fcOf(m, e);
  for (const { block, data } of blocks) {
    if (block.functionCode !== fc) continue;
    const off = (e.address - block.start) * 2;
    const len = WIDTH[e.type] * 2;
    if (off >= 0 && off + len <= data.length) {
      const w = Buffer.from(data.subarray(off, off + len));
      if (len > 2 && (e.wordOrder ?? m.wordOrder) === 'little') {
        // Low word first: reverse the 16-bit words (bytes within a word stay big-endian, Modbus §4.2).
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i += 2) w.copy(out, len - 2 - i, i, i + 2);
        return out;
      }
      return w;
    }
  }
  throw new Error(`register ${e.address} not covered by the read plan`);
}

export function decodeNumber(m: RegisterMap, blocks: BlockData[], e: MapEntry): number {
  const w = words(m, blocks, e);
  switch (e.type) {
    case 'float32':
      return w.readFloatBE(0);
    case 'float64':
      return w.readDoubleBE(0);
    case 'uint64':
      return Number(w.readBigUInt64BE(0));
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
export function decodeRegisterMilli(m: RegisterMap, blocks: BlockData[]): bigint {
  const e = m.register;
  if (e.type === 'uint64') return applyScale(words(m, blocks, e).readBigUInt64BE(0) * 1000n, e.scale ?? '1');
  const v = decodeNumber(m, blocks, e);
  if (e.type === 'float32' || e.type === 'float64') {
    if (!Number.isFinite(v) || v < 0) throw new Error(`implausible register ${v}`);
    return applyScale(milliFromNumber(v), e.scale ?? '1');
  }
  if (v < 0) throw new Error(`negative register ${v}`);
  return applyScale(BigInt(v) * 1000n, e.scale ?? '1');
}

export function decodeExtras(m: RegisterMap, blocks: BlockData[]): Record<string, number> {
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

const FUNCTION_CODE: Record<RegisterDef['function'], ReadFunction> = { holding: 3, input: 4 };

function entryFromDef(d: RegisterDef, decimals?: number): MapEntry {
  return {
    address: d.address,
    type: d.dataType,
    scale: d.scale,
    functionCode: FUNCTION_CODE[d.function],
    wordOrder: d.wordOrder === 'little_endian' ? 'little' : 'big',
    ...(decimals !== undefined ? { decimals } : {}),
  };
}

/** `extra` keys for the optional instant values of a custom map (same names as the built-in maps). */
const CUSTOM_EXTRAS: Record<Exclude<keyof CustomRegisterMap, 'energy'>, { key: string; decimals: number }> = {
  voltage: { key: 'voltage', decimals: 1 },
  current: { key: 'current', decimals: 2 },
  power: { key: 'powerW', decimals: 0 },
};

/**
 * Builds the in-memory register map of a meter configured with `registerMap: "custom"` and its
 * `customRegisterMap` (CR-005): `energy` is the cumulative register, the others feed `extra` only.
 * Throws when the map is missing or invalid (the config is then rejected).
 */
export function mapFromCustom(meter: MeterConfig): RegisterMap {
  const c = meter.customRegisterMap;
  if (!c) throw new Error('registerMap "custom" without customRegisterMap');
  const energy = entryFromDef(c.energy);
  const extras: Record<string, MapEntry> = {};
  for (const [name, spec] of Object.entries(CUSTOM_EXTRAS)) {
    const def = c[name as keyof typeof CUSTOM_EXTRAS];
    if (def) extras[spec.key] = entryFromDef(def, spec.decimals);
  }
  return validateMap({
    driver: meter.driver,
    model: `custom map of ${meter.meterId}`,
    functionCode: energy.functionCode!,
    wordOrder: energy.wordOrder!,
    maxBlockRegisters: 40,
    register: { ...energy, unit: meter.unit },
    extras,
    probe: { address: energy.address, count: WIDTH[energy.type] },
  });
}

/** The register map of a Modbus meter: its custom map, or the built-in map of its driver. */
export function mapForMeter(meter: MeterConfig): RegisterMap {
  if (meter.registerMap === 'custom') return mapFromCustom(meter);
  const m = BUILTIN_MAPS[meter.driver];
  if (!m) throw new Error(`unknown Modbus driver ${meter.driver}`);
  return m;
}
