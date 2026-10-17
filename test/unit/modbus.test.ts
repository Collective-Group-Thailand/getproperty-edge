import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { crc16, crcOk } from '../../src/drivers/modbus/crc.js';
import { ModbusMaster } from '../../src/drivers/modbus/master.js';
import { ModbusMeterDriver } from '../../src/drivers/modbus/modbus-driver.js';
import {
  BUILTIN_MAPS,
  mapForMeter,
  mapFromCustom,
  planBlocks,
  type RegisterMap,
  validateMap,
} from '../../src/drivers/modbus/register-map.js';
import {
  buildReadRequest,
  expectedResponseLength,
  ModbusCrcError,
  ModbusExceptionError,
  parseReadResponse,
  t35Ms,
} from '../../src/drivers/modbus/rtu.js';
import { LinuxTtyTransport, virtualSerialPair } from '../../src/drivers/modbus/serial.js';
import { float32Registers, ModbusSlaveSimulator, type RegisterSource } from '../../src/drivers/modbus/slave-sim.js';
import { MeterReadError } from '../../src/drivers/types.js';
import type { MeterConfig } from '../../src/protocol/types.js';
import { formatMilli } from '../../src/util/decimal.js';

const dir = new URL('../fixtures/frames/', import.meta.url);
const hexBytes = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

interface Exchange {
  name: string;
  requests: Buffer[];
  responses: Buffer[];
  bad: Buffer[];
  expect: Record<string, string>;
}

function loadFixtures(): Exchange[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.hex'))
    .map((name) => {
      const ex: Exchange = { name, requests: [], responses: [], bad: [], expect: {} };
      for (const line of readFileSync(new URL(name, dir), 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith('# expect'))
          for (const kv of t.slice(8).trim().split(/\s+/)) {
            const [k, v] = kv.split('=');
            ex.expect[k!] = v!;
          }
        else if (t.startsWith('>')) ex.requests.push(hexBytes(t.slice(1)));
        else if (t.startsWith('<')) ex.responses.push(hexBytes(t.slice(1)));
        else if (t.startsWith('!')) ex.bad.push(hexBytes(t.slice(1)));
      }
      return ex;
    });
}

const fixtures = loadFixtures();
const meter = (address: number, over: Partial<MeterConfig> = {}): MeterConfig => ({
  meterId: '0192a000-0000-7000-8000-000000000001',
  roomCode: 'A-201',
  driver: 'eastron_sdm120',
  bus: 'rs485-1',
  address,
  unit: 'kwh',
  ...over,
});

/** Replays captured frames: answers each expected request with the recorded response. */
function replay(ex: Exchange) {
  const [masterPort, slavePort] = virtualSerialPair();
  const seen: Buffer[] = [];
  slavePort.onData((req) => {
    seen.push(req);
    const i = ex.requests.findIndex((r) => r.equals(req));
    const res = ex.responses[i] ?? ex.bad[i];
    if (res) setTimeout(() => void slavePort.write(res), 1);
  });
  void slavePort.open();
  return { masterPort, seen };
}

describe('CRC-16/MODBUS golden vectors', () => {
  it.each(fixtures.flatMap((f) => [...f.requests, ...f.responses].map((b) => [f.name, b.toString('hex')] as const)))(
    '%s %s has a valid CRC',
    (_n, h) => {
      expect(crcOk(Buffer.from(h, 'hex'))).toBe(true);
    },
  );
  it('rejects corrupted frames and matches the spec example', () => {
    for (const f of fixtures) for (const b of f.bad) expect(crcOk(b)).toBe(false);
    expect(crc16(hexBytes('11 03 00 6B 00 03'))).toBe(0x8776);
    expect(buildReadRequest(0x11, 3, 0x6b, 3).toString('hex')).toBe('1103006b00037687');
  });
});

describe('RTU framing', () => {
  it('computes response length from the header and t3.5 per baud', () => {
    expect(expectedResponseLength(hexBytes('15 04'))).toBeNull();
    expect(expectedResponseLength(hexBytes('15 04 08'))).toBe(13);
    expect(expectedResponseLength(hexBytes('15 84'))).toBe(5);
    expect(t35Ms(9600)).toBeCloseTo(4.01, 2);
    expect(t35Ms(115200)).toBe(1.75);
  });
  it('validates address, function, byte count and exceptions', () => {
    const ok = fixtures.find((f) => f.name === 'sdm120-addr21-normal.hex')!;
    expect(parseReadResponse(ok.responses[1]!, 21, 4, 4)).toHaveLength(8);
    expect(() => parseReadResponse(ok.responses[1]!, 22, 4, 4)).toThrow(/slave 21/);
    expect(() => parseReadResponse(ok.responses[1]!, 21, 4, 3)).toThrow(/byte count/);
    const exc = fixtures.find((f) => f.name === 'sdm120-addr21-exception.hex')!;
    expect(() => parseReadResponse(exc.responses[0]!, 21, 4, 14)).toThrow(ModbusExceptionError);
    const bad = fixtures.find((f) => f.name === 'sdm120-addr21-badcrc.hex')!;
    expect(() => parseReadResponse(bad.bad[0]!, 21, 4, 14)).toThrow(ModbusCrcError);
  });
});

describe('register maps', () => {
  it('plans SDM120 reads as two blocks (0–13, 70–73)', () => {
    expect(planBlocks(BUILTIN_MAPS.eastron_sdm120!)).toEqual([
      { functionCode: 4, start: 0, count: 14 },
      { functionCode: 4, start: 70, count: 4 },
    ]);
    expect(Object.keys(BUILTIN_MAPS).sort()).toEqual(['eastron_sdm120', 'eastron_sdm230']);
  });
  it('rejects malformed maps (a new model is JSON + tests)', () => {
    const base = BUILTIN_MAPS.eastron_sdm120!;
    expect(() => validateMap({ ...base, functionCode: 6 } as unknown as RegisterMap)).toThrow();
    expect(() => validateMap({ ...base, driver: 'Bad Name' })).toThrow();
    expect(() => validateMap({ ...base, register: { ...base.register, type: 'float128' as 'float32' } })).toThrow();
    expect(() => validateMap({ ...base, register: { ...base.register, functionCode: 6 as 3 } })).toThrow();
    expect(() => validateMap({ ...base, register: { ...base.register, type: 'uint64', address: 0xfffd } })).toThrow();
  });
});

describe('Modbus driver against golden frames', () => {
  for (const ex of fixtures.filter((f) => f.expect.address)) {
    it(`${ex.name}`, async () => {
      const { masterPort, seen } = replay(ex);
      const master = new ModbusMaster(masterPort, { baud: 9600, timeoutMs: 100, retries: 1, interFrameMs: 1 });
      await master.open();
      const drv = new ModbusMeterDriver(BUILTIN_MAPS.eastron_sdm120!, master);
      const m = meter(Number(ex.expect.address));
      if (ex.expect.status) {
        const err = await drv.read(m).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MeterReadError);
        expect((err as MeterReadError).status).toBe(ex.expect.status);
      } else {
        const r = await drv.read(m);
        expect(formatMilli(r.registerMilli)).toBe(ex.expect.register);
        for (const k of ['voltage', 'current', 'powerW', 'frequencyHz'])
          expect(r.extra?.[k]).toBe(Number(ex.expect[k]));
        expect(r.unit).toBe('kwh');
        // the driver sent exactly the recorded requests, in order
        expect(seen.map((b) => b.toString('hex'))).toEqual(ex.requests.map((b) => b.toString('hex')));
      }
    });
  }

  it('applies the per-meter scale (CT ratio) exactly', async () => {
    const ex = fixtures.find((f) => f.name === 'sdm120-addr21-normal.hex')!;
    const { masterPort } = replay(ex);
    const master = new ModbusMaster(masterPort, { baud: 9600, timeoutMs: 100, interFrameMs: 1 });
    await master.open();
    const r = await new ModbusMeterDriver(BUILTIN_MAPS.eastron_sdm120!, master).read(meter(21, { scale: '40' }));
    expect(formatMilli(r.registerMilli)).toBe('493827.120');
  });
});

describe('ModbusMaster', () => {
  function bus(source: RegisterSource | null = null) {
    const [a, b] = virtualSerialPair();
    const log: Array<{ kind: 'req' | 'res'; t: number; addr: number }> = [];
    const sim = new ModbusSlaveSimulator(
      b,
      source ??
        ((addr, _fn, start, count) => {
          log.push({ kind: 'req', t: performance.now(), addr });
          return float32Registers([[start, addr]], count, start);
        }),
    );
    void sim.start();
    sim.latencyMs = 5;
    const master = new ModbusMaster(a, { baud: 9600, timeoutMs: 60, retries: 2, interFrameMs: 2 });
    return { master, sim, log, a };
  }

  it('serialises requests on one bus: one in flight at a time, in call order', async () => {
    const { master, log } = bus();
    await master.open();
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map((addr) => master.readRegisters(addr, 4, 0, 2).then(() => order.push(addr))));
    expect(order).toEqual([1, 2, 3, 4, 5]);
    // each request arrives only after the previous response (latency 5 ms + gap 2 ms)
    for (let i = 1; i < log.length; i++) expect(log[i]!.t - log[i - 1]!.t).toBeGreaterThanOrEqual(6);
  });

  it('retries on timeout and CRC errors, not on exceptions', async () => {
    let calls = 0;
    const { master, sim } = bus((addr) => {
      calls++;
      if (addr === 9) return 2; // exception
      if (addr === 7) return null; // never answers
      return Buffer.alloc(4);
    });
    await master.open();
    sim.corruptNext = 2;
    await expect(master.readRegisters(3, 4, 0, 2)).resolves.toHaveLength(4); // 2 bad CRC then OK
    expect(master.stats.crcErrors).toBe(2);
    calls = 0;
    await expect(master.readRegisters(7, 4, 0, 2)).rejects.toThrow(/did not answer/);
    expect(calls).toBe(3);
    expect(master.stats.timeouts).toBe(3);
    calls = 0;
    await expect(master.readRegisters(9, 4, 0, 2)).rejects.toBeInstanceOf(ModbusExceptionError);
    expect(calls).toBe(1);
  });

  it('a failing request does not block the next one', async () => {
    const { master } = bus((addr) => (addr === 7 ? null : Buffer.alloc(4)));
    await master.open();
    const r = await Promise.allSettled([master.readRegisters(7, 4, 0, 2), master.readRegisters(8, 4, 0, 2)]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'fulfilled']);
  });
});

describe('Linux tty transport', () => {
  it('configures the line with stty (8N2 / 8E1, raw, VMIN=0 VTIME=1)', () => {
    expect(LinuxTtyTransport.sttyArgs({ device: '/dev/ttyUSB0', baud: 9600, parity: 'none' })).toEqual(
      expect.arrayContaining([
        '-F',
        '/dev/ttyUSB0',
        '9600',
        'cs8',
        '-parenb',
        'cstopb',
        'raw',
        'min',
        '0',
        'time',
        '1',
      ]),
    );
    expect(LinuxTtyTransport.sttyArgs({ device: '/dev/ttyUSB1', baud: 19200, parity: 'even' })).toEqual(
      expect.arrayContaining(['parenb', '-parodd', '-cstopb']),
    );
  });
});

describe('custom register maps (CR-005)', () => {
  const custom = (over: Partial<MeterConfig> = {}): MeterConfig => ({
    meterId: '0192a000-0000-7000-8000-00000000c001',
    roomCode: 'MAIN-E',
    driver: 'modbus_generic',
    bus: 'rs485-1',
    address: 3,
    unit: 'kwh',
    registerMap: 'custom',
    scale: '1',
    customRegisterMap: {
      energy: { address: 342, function: 'input', dataType: 'uint64', wordOrder: 'little_endian', scale: '0.01' },
      voltage: { address: 0, function: 'holding', dataType: 'float32', wordOrder: 'big_endian', scale: '1' },
      power: { address: 10, function: 'holding', dataType: 'int32', wordOrder: 'little_endian', scale: '0.1' },
    },
    ...over,
  });

  it('builds a map with per-register function codes and plans one block per address space', () => {
    const m = mapFromCustom(custom());
    expect(m.register).toMatchObject({
      address: 342,
      type: 'uint64',
      functionCode: 4,
      wordOrder: 'little',
      unit: 'kwh',
    });
    expect(Object.keys(m.extras).sort()).toEqual(['powerW', 'voltage']);
    expect(planBlocks(m)).toEqual([
      { functionCode: 3, start: 0, count: 12 },
      { functionCode: 4, start: 342, count: 4 },
    ]);
    expect(m.probe).toEqual({ address: 342, count: 4 });
  });

  it('mapForMeter picks the custom map, else the built-in one, else refuses', () => {
    expect(mapForMeter(custom()).model).toMatch(/custom map/);
    expect(mapForMeter(meter(21)).driver).toBe('eastron_sdm120');
    expect(() => mapForMeter(meter(21, { driver: 'acme_x' }))).toThrow(/unknown Modbus driver/);
    expect(() => mapFromCustom(custom({ customRegisterMap: undefined }))).toThrow(/without customRegisterMap/);
  });

  it('reads a custom-mapped meter over RTU: uint64 low-word-first energy, holding extras, exact scale', async () => {
    const [a, b] = virtualSerialPair();
    const requests: Array<[number, number, number]> = [];
    // energy = 1234567890 (× 0.01 = 12345678.90 kWh) as uint64, words least significant first
    const energy = Buffer.alloc(8);
    energy.writeBigUInt64BE(1_234_567_890n);
    const lowFirst = Buffer.concat([
      energy.subarray(6, 8),
      energy.subarray(4, 6),
      energy.subarray(2, 4),
      energy.subarray(0, 2),
    ]);
    const sim = new ModbusSlaveSimulator(b, (addr, fn, start, count) => {
      requests.push([fn, start, count]);
      if (addr !== 3) return null;
      if (fn === 4 && start === 342) return lowFirst;
      if (fn === 3 && start === 0) {
        const img = float32Registers([[0, 229.04]], count, 0);
        const p = Buffer.alloc(4);
        p.writeInt32BE(7105); // 710.5 W, low word first
        p.copy(img, 22, 0, 2);
        p.copy(img, 20, 2, 4);
        return img;
      }
      return 2;
    });
    await sim.start();
    const master = new ModbusMaster(a, { baud: 9600, timeoutMs: 100, interFrameMs: 1 });
    await master.open();
    const m = custom();
    const drv = new ModbusMeterDriver(mapForMeter(m), master);
    const r = await drv.read(m);
    expect(formatMilli(r.registerMilli)).toBe('12345678.900');
    expect(r.extra).toEqual({ voltage: 229, powerW: 711 });
    expect(requests).toEqual([
      [3, 0, 12],
      [4, 342, 4],
    ]);
    await drv.probe(m);
    expect(requests.at(-1)).toEqual([4, 342, 4]);
  });
});
