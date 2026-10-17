import { describe, expect, it } from 'vitest';

import { Outbox } from '../../src/queue/outbox.js';
import { type NewReading, ReadingQueue, type SeqGap } from '../../src/queue/reading-queue.js';
import { openDb } from '../../src/storage/db.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-01T00:00:00+07:00');

function r(meterId: string, at: number, register = '1.000', cfg = 1): NewReading {
  return {
    meterId,
    readAtMs: at,
    readAt: new Date(at)
      .toISOString()
      .replace('Z', '+00:00')
      .replace(/\.\d{3}/, ''),
    register,
    unit: 'kwh',
    quality: 'good',
    configVersion: cfg,
  };
}

describe('ReadingQueue', () => {
  it('assigns a persisted, monotonic seq per meter', () => {
    const db = openDb(':memory:');
    const q = new ReadingQueue(db);
    expect(q.append([r('a', T0), r('b', T0), r('a', T0 + 1)])).toEqual([1, 1, 2]);
    // a new queue on the same db continues the sequence
    const q2 = new ReadingQueue(db);
    expect(q2.append([r('a', T0 + 2)])).toEqual([3]);
    expect(q2.metrics().depth).toBe(4);
  });

  it('hands out batches in order, deletes only on ack, re-sends after rewind', () => {
    const q = new ReadingQueue(openDb(':memory:'));
    q.append(Array.from({ length: 450 }, (_, i) => r('a', T0 + i)));
    const b1 = q.nextBatch(200)!;
    const b2 = q.nextBatch(200)!;
    expect(b1.readings.map((x) => x.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(b2.readings[0]!.seq).toBe(201);
    q.ack(b1.ids);
    expect(q.metrics().depth).toBe(250);
    q.rewind(); // link dropped before b2's PUBACK
    const again = q.nextBatch(200)!;
    expect(again.readings[0]!.seq).toBe(201);
    q.ack(again.ids);
    const last = q.nextBatch(200)!;
    expect(last.readings).toHaveLength(50);
    q.ack(last.ids);
    expect(q.nextBatch()).toBeNull();
    expect(q.metrics()).toMatchObject({ depth: 0, appendedTotal: 450, ackedTotal: 450 });
  });

  it('never mixes config versions in one batch', () => {
    const q = new ReadingQueue(openDb(':memory:'));
    q.append([r('a', T0, '1.000', 1), r('a', T0 + 1, '1.000', 1), r('a', T0 + 2, '1.000', 2)]);
    expect(q.nextBatch()!.configVersion).toBe(1);
    const b = q.nextBatch()!;
    expect(b.configVersion).toBe(2);
    expect(b.readings).toHaveLength(1);
  });

  it('evicts the oldest interval readings but keeps the last reading per meter per hour', () => {
    const gaps: SeqGap[] = [];
    const q = new ReadingQueue(openDb(':memory:'), { capacity: 1000, onSeqGap: (g) => gaps.push(g) });
    // 2 meters × 15-min polling for 6 days = 1152 readings > capacity 1000
    const rows: NewReading[] = [];
    for (let i = 0; i < 576; i++) for (const m of ['a', 'b']) rows.push(r(m, T0 + i * 900_000));
    for (let i = 0; i < rows.length; i += 50) q.append(rows.slice(i, i + 50));
    const m = q.metrics();
    expect(m.depth).toBeLessThanOrEqual(1000);
    expect(m.evictedTotal).toBeGreaterThanOrEqual(152);
    // every (meter, hour) still has its last reading
    const all: Array<{ meterId: string; readAt: string; seq: number }> = [];
    for (;;) {
      const b = q.nextBatch(200);
      if (!b) break;
      all.push(...b.readings);
    }
    const lastPerHour = new Map<string, number>();
    rows.forEach((x, idx) => lastPerHour.set(`${x.meterId}:${Math.floor(x.readAtMs / HOUR)}`, idx));
    const kept = new Set(all.map((x) => `${x.meterId}:${x.seq}`));
    const seqOf = new Map<number, number>();
    const counters = new Map<string, number>();
    rows.forEach((x, idx) => {
      const n = (counters.get(x.meterId) ?? 0) + 1;
      counters.set(x.meterId, n);
      seqOf.set(idx, n);
    });
    for (const [key, idx] of lastPerHour) expect(kept.has(`${key.split(':')[0]}:${seqOf.get(idx)}`)).toBe(true);
    // eviction is reported as seq_gap per meter
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.reason === 'buffer_eviction' && g.toSeq >= g.fromSeq)).toBe(true);
    expect(gaps.reduce((a, g) => a + g.evicted, 0)).toBe(m.evictedTotal);
  });

  it('falls back to the oldest readings only when nothing but hourly keepers is left', () => {
    const gaps: SeqGap[] = [];
    const q = new ReadingQueue(openDb(':memory:'), { capacity: 1000, onSeqGap: (g) => gaps.push(g) });
    // one reading per hour → all are keepers
    for (let i = 0; i < 1100; i += 100) q.append(Array.from({ length: 100 }, (_, k) => r('a', T0 + (i + k) * HOUR)));
    expect(q.metrics().depth).toBe(1000);
    expect(gaps.some((g) => g.reason === 'buffer_hard_limit')).toBe(true);
    expect(q.nextBatch(1)!.readings[0]!.seq).toBe(101);
  });

  it('persists meter register state with the reading', () => {
    const q = new ReadingQueue(openDb(':memory:'));
    q.append([{ ...r('a', T0, '5.000'), state: { rawMilli: 5000n, rolloverOffsetMilli: 0n, registerMilli: 5000n } }]);
    expect(q.meterState('a')).toMatchObject({ lastSeq: 1, lastRawMilli: 5000n, lastRegisterMilli: 5000n });
    expect(q.meterState('zz').lastSeq).toBe(0);
  });
});

describe('Outbox', () => {
  it('keeps events until acked and redelivers after rewind', () => {
    const o = new Outbox(openDb(':memory:'));
    o.push('events', { a: 1 });
    o.push('cmd/ack', { b: 2 });
    const items = o.take();
    expect(items.map((i) => i.suffix)).toEqual(['events', 'cmd/ack']);
    expect(o.take()).toEqual([]);
    o.ack(items[0]!.id);
    o.rewind();
    expect(o.take().map((i) => i.payload)).toEqual(['{"b":2}']);
  });
  it('drops the oldest beyond capacity', () => {
    const o = new Outbox(openDb(':memory:'), 3);
    for (let i = 0; i < 5; i++) o.push('events', { i });
    expect(o.depth()).toBe(3);
    expect(o.take()[0]!.payload).toBe('{"i":2}');
  });
});
