import { describe, expect, it } from 'vitest';

import { SimulatorDriver } from '../../src/drivers/simulator/simulator-driver.js';
import { MeterReadError } from '../../src/drivers/types.js';
import type { MeterConfig } from '../../src/protocol/types.js';
import { VirtualClock } from '../../src/util/clock.js';
import { formatMilli } from '../../src/util/decimal.js';

const meter = (id: string, unit: 'kwh' | 'm3' = 'kwh'): MeterConfig => ({
  meterId: id,
  roomCode: 'A-201',
  driver: 'eastron_sdm120',
  bus: 'rs485-1',
  address: 1,
  unit,
});
const T = Date.parse('2026-11-02T08:00:00+07:00'); // Monday
const ID = '0192a000-0000-7000-8000-000000000001';

describe('SimulatorDriver', () => {
  it('is deterministic and cumulative (never decreases without a fault)', async () => {
    const a = new SimulatorDriver({ seed: 's' }, new VirtualClock(T), 'Asia/Bangkok');
    const b = new SimulatorDriver({ seed: 's' }, new VirtualClock(T), 'Asia/Bangkok');
    const ra = await a.read(meter(ID));
    const rb = await b.read(meter(ID));
    expect(ra.registerMilli).toBe(rb.registerMilli);
    const p = a.profile(meter(ID));
    let prev = -1n;
    for (let t = T; t < T + 3 * 86_400_000; t += 900_000) {
      const v = p.registerMilliAt(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('follows occupancy and weekday/weekend profiles', () => {
    const d = new SimulatorDriver(
      { seed: 's', meters: { occ: { occupied: true, dailyMean: 8 }, vac: { occupied: false } } },
      new VirtualClock(T),
      'Asia/Bangkok',
    );
    const occ = d.profile(meter('occ'));
    const vac = d.profile(meter('vac'));
    const day = 86_400_000;
    const used = (p: typeof occ, from: number) =>
      Number(p.registerMilliAt(from + day) - p.registerMilliAt(from)) / 1000;
    expect(used(occ, T)).toBeGreaterThan(4);
    expect(used(vac, T)).toBeLessThan(0.3);
    // evening (19:00) burns more than early morning (03:00)
    expect(occ.instantRate(Date.parse('2026-11-02T19:30:00+07:00'))).toBeGreaterThan(
      occ.instantRate(Date.parse('2026-11-02T03:30:00+07:00')),
    );
    // weekend days are 1.2× on average over many days
    let wk = 0;
    let we = 0;
    for (let i = 0; i < 70; i++) {
      const dIdx = Math.floor((T + 7 * 3_600_000) / day) + i;
      const total = occ.dailyTotal(dIdx);
      const wd = new Date(dIdx * day).getUTCDay();
      if (wd === 0 || wd === 6) we += total / 20;
      else wk += total / 50;
    }
    expect(we / wk).toBeGreaterThan(1.05);
  });

  it('scripts faults: timeout, crc error, stuck register, rollover, swap', async () => {
    const clock = new VirtualClock(T);
    const d = new SimulatorDriver(
      {
        seed: 's',
        meters: {
          t: { faults: [{ type: 'timeout', from: '2026-11-02T08:00:00+07:00', to: '2026-11-02T09:00:00+07:00' }] },
          c: { faults: [{ type: 'crc_error' }] },
          s: { initialRegister: '10.000', faults: [{ type: 'stuck', from: '2026-11-02T00:00:00+07:00' }] },
          r: { initialRegister: '99990.000', dailyMean: 20, faults: [{ type: 'rollover', at: '100000' }] },
          w: {
            initialRegister: '500.000',
            faults: [{ type: 'swap', at: '2026-11-02T07:00:00+07:00', newInitialRegister: '0.000' }],
          },
        },
      },
      clock,
      'Asia/Bangkok',
    );
    await expect(d.read(meter('t'))).rejects.toMatchObject({ status: 'timeout' });
    await expect(d.read(meter('c'))).rejects.toBeInstanceOf(MeterReadError);
    const s1 = await d.read(meter('s'));
    await clock.advance(3_600_000);
    expect((await d.read(meter('s'))).registerMilli).toBe(s1.registerMilli);
    expect((await d.read(meter('t'))).registerMilli).toBeGreaterThan(0n); // window over
    const r = await d.read(meter('r'));
    expect(r.rolloverAtMilli).toBe(100_000_000n);
    expect(r.registerMilli).toBeLessThan(100_000_000n);
    const w = await d.read(meter('w'));
    expect(Number(formatMilli(w.registerMilli))).toBeLessThan(10);
  });

  it('serves m³ meters with a water profile and flow extra', async () => {
    const d = new SimulatorDriver({ seed: 's' }, new VirtualClock(T), 'Asia/Bangkok');
    const r = await d.read(meter(ID, 'm3'));
    expect(r.unit).toBe('m3');
    expect(r.extra).toHaveProperty('flowLpm');
  });
});
