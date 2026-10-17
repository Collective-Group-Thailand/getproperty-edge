import { describe, expect, it } from 'vitest';

import { ConfigManager } from '../../src/config/config-manager.js';
import { driverCatalogue, type RuntimeDeps } from '../../src/config/runtime.js';
import { semanticErrors } from '../../src/config/validate-config.js';
import { type SerialTransport, virtualSerialPair } from '../../src/drivers/modbus/serial.js';
import { ModbusSlaveSimulator } from '../../src/drivers/modbus/slave-sim.js';
import { SimulatedPulseSource } from '../../src/drivers/pulse/pulse-source.js';
import { SimulatorDriver } from '../../src/drivers/simulator/simulator-driver.js';
import type { BusConfig, GatewayConfig } from '../../src/protocol/types.js';
import { KvStore, openDb } from '../../src/storage/db.js';
import { VirtualClock } from '../../src/util/clock.js';
import { silentLogger } from '../../src/util/logger.js';
import { meterIds, simConfig } from '../../tools/testbed.js';

const T0 = Date.parse('2026-11-01T00:10:00+07:00');

function harness(mode: 'hardware' | 'simulator', serialFactory?: (bus: BusConfig) => SerialTransport) {
  const db = openDb(':memory:');
  const clock = new VirtualClock(T0);
  const events: Array<{ kind: string; version: number | null; detail?: unknown }> = [];
  const results: number[] = [];
  const deps: RuntimeDeps = {
    db,
    clock,
    timeZone: 'Asia/Bangkok',
    logger: silentLogger(),
    mode,
    simulator: new SimulatorDriver({}, clock, 'Asia/Bangkok'),
    serialFactory:
      serialFactory ??
      (() => {
        const [a, b] = virtualSerialPair();
        void new ModbusSlaveSimulator(b, (_addr, _fn, _s, count) => Buffer.alloc(count * 2)).start();
        return a;
      }),
    pulseSourceFactory: () => new SimulatedPulseSource(),
    jitterMaxMs: 0,
    modbusTimeoutMs: 20,
    modbusRetries: 0,
    uncleanStart: () => false,
    onResults: (r) => results.push(r.length),
    onPulseOverflow: () => undefined,
  };
  const kv = new KvStore(db);
  const mgr = new ConfigManager(
    kv,
    deps,
    {
      applied: (version, info) => events.push({ kind: 'applied', version, detail: info }),
      rejected: (version, error) => events.push({ kind: 'rejected', version, detail: error }),
      activated: () => undefined,
    },
    silentLogger(),
    1000,
  );
  return { mgr, events, kv, clock, results, deps };
}

describe('config validation', () => {
  const cat = driverCatalogue();
  it('accepts the protocol example shape', () => {
    const cfg: GatewayConfig = {
      version: 12,
      pollIntervalS: 900,
      heartbeatS: 60,
      buses: [
        { id: 'rs485-1', type: 'modbus_rtu', device: '/dev/ttyUSB0', baud: 9600, parity: 'none' },
        { id: 'gpio', type: 'gpio' },
      ],
      meters: [
        {
          meterId: '0192a000-0000-7000-8000-000000000001',
          roomCode: 'A-201',
          driver: 'eastron_sdm120',
          bus: 'rs485-1',
          address: 21,
          unit: 'kwh',
          registerMap: 'driver_default',
          scale: '1',
        },
        {
          meterId: '0192a000-0000-7000-8000-000000000002',
          roomCode: 'A-201W',
          driver: 'pulse_counter',
          bus: 'gpio',
          pin: 17,
          unit: 'm3',
          litresPerPulse: 10,
          initialRegister: '1532.040',
        },
      ],
    };
    expect(semanticErrors(cfg, cat)).toEqual([]);
  });
  it('reports every semantic problem', () => {
    const base = simConfig(meterIds(3));
    const cfg: GatewayConfig = {
      ...base,
      buses: [...base.buses, { id: 'gpio', type: 'gpio' }, { id: 'lora', type: 'lorawan' }],
      meters: [
        { ...base.meters[0]!, address: 5 },
        { ...base.meters[1]!, address: 5 },
        { ...base.meters[2]!, driver: 'acme_x', registerMap: 'custom' },
        { ...base.meters[0]!, meterId: '0192a000-0000-7000-8000-0000000000aa', bus: 'nope' },
        {
          ...base.meters[0]!,
          meterId: '0192a000-0000-7000-8000-0000000000bb',
          bus: 'gpio',
          driver: 'pulse_counter',
          unit: 'kwh',
        },
        { ...base.meters[0]!, meterId: '0192a000-0000-7000-8000-0000000000cc', bus: 'lora' },
      ],
    };
    const errs = semanticErrors(cfg, cat).join('\n');
    expect(errs).toMatch(/address 5 already used/);
    expect(errs).toMatch(/unknown Modbus driver acme_x/);
    expect(errs).toMatch(/registerMap "custom"/);
    expect(errs).toMatch(/unknown bus nope/);
    expect(errs).toMatch(/pin required/);
    expect(errs).toMatch(/initialRegister required/);
    expect(errs).toMatch(/count water in m3/);
    expect(errs).toMatch(/lorawan meters are not supported/);
  });
});

describe('ConfigManager', () => {
  it('applies, persists and ignores a redelivered retained config', async () => {
    const { mgr, events, kv } = harness('simulator');
    const out = await mgr.apply(JSON.stringify(simConfig(meterIds(5), 3)));
    expect(out.status).toBe('applied');
    expect(kv.get<GatewayConfig>('config.applied')!.version).toBe(3);
    expect((await mgr.apply(JSON.stringify(simConfig(meterIds(5), 3)))).status).toBe('unchanged');
    expect(events.map((e) => e.kind)).toEqual(['applied']);
    await mgr.stop();
  });

  it('rejects invalid, semantically wrong and stale configs and keeps the applied one', async () => {
    const { mgr, events } = harness('simulator');
    await mgr.apply(simConfig(meterIds(2), 5));
    expect((await mgr.apply('{"version": 6}')).status).toBe('rejected');
    expect((await mgr.apply('not json')).status).toBe('rejected');
    expect(
      (await mgr.apply({ ...simConfig(meterIds(2), 7), meters: [{ ...simConfig(meterIds(1)).meters[0]!, bus: 'x' }] }))
        .status,
    ).toBe('rejected');
    expect(await mgr.apply(simConfig(meterIds(2), 4))).toMatchObject({
      status: 'rejected',
      error: expect.stringMatching(/stale/),
    });
    expect(events.map((e) => [e.kind, e.version])).toEqual([
      ['applied', 5],
      ['rejected', 6],
      ['rejected', null],
      ['rejected', 7],
      ['rejected', 4],
    ]);
    expect(mgr.version()).toBe(5);
    expect(mgr.active()!.config.version).toBe(5);
    await mgr.stop();
  });

  it('rolls back to the previous config when the dry-run cannot open a bus', async () => {
    let broken = false;
    const { mgr, events, kv } = harness('hardware', (bus) => {
      const [a, b] = virtualSerialPair();
      void new ModbusSlaveSimulator(b, (_addr, _fn, _s, count) => Buffer.alloc(count * 2)).start();
      if (broken && bus.id === 'rs485-2') a.open = () => Promise.reject(new Error('ENOENT /dev/ttyUSB1'));
      return a;
    });
    expect((await mgr.apply(simConfig(meterIds(5), 1))).status).toBe('applied');
    broken = true;
    const out = await mgr.apply(simConfig(meterIds(250), 2)); // needs rs485-2
    expect(out).toMatchObject({ status: 'rejected', error: expect.stringMatching(/rs485-2.*ENOENT/) });
    expect(events.at(-1)).toMatchObject({ kind: 'rejected', version: 2 });
    expect(mgr.version()).toBe(1);
    expect(kv.get<GatewayConfig>('config.applied')!.version).toBe(1);
    // the previous runtime is running again
    expect(mgr.active()!.config.meters).toHaveLength(5);
    expect(await mgr.active()!.scheduler.readNow()).toHaveLength(5);
    await mgr.stop();
  });

  it('applies a 300-meter config in < 5 s with a probe deadline', async () => {
    const { mgr } = harness('hardware', () => {
      const [a, b] = virtualSerialPair();
      // half the meters are switched off: probes time out (20 ms each) but the deadline bounds it
      void new ModbusSlaveSimulator(b, (addr, _fn, _s, count) => (addr % 2 ? Buffer.alloc(count * 2) : null)).start();
      return a;
    });
    const t = Date.now();
    const out = await mgr.apply(simConfig(meterIds(300), 1));
    expect(out.status).toBe('applied');
    expect(Date.now() - t).toBeLessThan(5000);
    if (out.status === 'applied') expect(out.unreachable.length).toBeGreaterThan(0);
    await mgr.stop();
  });
});
