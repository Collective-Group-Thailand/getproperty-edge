import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { virtualSerialPair, type VirtualSerialPort } from '../../src/drivers/modbus/serial.js';
import { ModbusSlaveSimulator } from '../../src/drivers/modbus/slave-sim.js';
import type { BusConfig } from '../../src/protocol/types.js';
import { VirtualClock } from '../../src/util/clock.js';
import { meterIds, simConfig, Testbed, waitFor } from '../../tools/testbed.js';

const T0 = Date.parse('2026-11-01T00:10:00+07:00');

/** Byte-level SDM120 meters on virtual RS485 buses: the real master/driver/scheduler path end to end. */
function rs485Buses(registers: Map<number, number>, missing: Set<number>) {
  const ports = new Map<string, VirtualSerialPort>();
  const factory = (bus: BusConfig) => {
    const [master, slave] = virtualSerialPair();
    const sim = new ModbusSlaveSimulator(slave, (addr, fn, start, count) => {
      if (fn !== 4 || missing.has(addr)) return null;
      const b = Buffer.alloc(count * 2);
      const put = (reg: number, v: number) => {
        const off = (reg - start) * 2;
        if (off >= 0 && off + 4 <= b.length) b.writeFloatBE(v, off);
      };
      put(0, 229.5);
      put(6, 1.25);
      put(12, 286);
      put(70, 50);
      put(72, registers.get(addr) ?? 0);
      return b;
    });
    void sim.start();
    ports.set(bus.id, master);
    return master;
  };
  return { factory, ports };
}

describe('E1.2 — Modbus RTU through the agent', () => {
  let tb: Testbed;
  beforeAll(async () => {
    tb = await new Testbed().start();
  });
  afterAll(async () => {
    await tb.stop();
  });

  it('polls SDM120 meters over RS485, reports timeouts as not_found/timeout and flags clock_suspect', async () => {
    const clock = new VirtualClock(T0);
    const ids = meterIds(6, '0192a000-0000-7000-8010');
    const regs = new Map(ids.map((_, i) => [i + 1, 1000 + i * 10.125]));
    const missing = new Set([6]);
    const { factory } = rs485Buses(regs, missing);
    let suspect = false;
    const { agent, gatewayId } = tb.agent({
      clock,
      env: { driverMode: 'hardware' },
      serialFactory: factory,
      clockSync: { suspect: () => suspect },
    });
    tb.pushConfig(gatewayId, simConfig(ids));
    await agent.start();
    await waitFor(() => ids.slice(0, 5).every((id) => tb.ingest.maxSeq(id) === 1), 15_000);
    const first = tb.ingest.keep!.filter((r) => ids.includes(r.meterId));
    expect(first.map((r) => r.register).sort()).toEqual(['1000.000', '1010.125', '1020.250', '1030.375', '1040.500']);
    expect(first[0]!.extra).toEqual({ voltage: 229.5, current: 1.25, powerW: 286, frequencyHz: 50 });
    expect(first.every((r) => r.quality === 'good')).toBe(true);
    // meter 6 never answers → not_found in health status
    expect(agent.statuses.get(ids[5]!).status).toBe('not_found');

    regs.set(1, 1001.5);
    suspect = true; // NTP lost
    await clock.advance(5 * 60_000); // 00:15 tick
    await waitFor(() => tb.ingest.maxSeq(ids[0]!) === 2, 10_000);
    const second = tb.ingest.keep!.filter((r) => r.meterId === ids[0] && r.seq === 2)[0]!;
    expect(second.register).toBe('1001.500');
    expect(second.quality).toBe('clock_suspect');
    expect(second.readAt).toBe('2026-11-01T00:15:00+07:00');
    await agent.stop();
  });
});
