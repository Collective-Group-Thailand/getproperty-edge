import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import type { TopicSuffix } from '../../src/protocol/types.js';
import { Outbox } from '../../src/queue/outbox.js';
import { type NewReading, ReadingQueue } from '../../src/queue/reading-queue.js';
import { openDb } from '../../src/storage/db.js';
import { Forwarder } from '../../src/transport/forwarder.js';
import type { Link } from '../../src/transport/link.js';
import { silentLogger } from '../../src/util/logger.js';

const GW = '0192a000-0000-7000-8000-00000000aaaa';
const M = '0192a000-0000-7000-8000-000000000001';

class FakeLink extends EventEmitter implements Link {
  connected = false;
  sent: Array<{ suffix: TopicSuffix; payload: string; resolve: () => void; reject: (e: Error) => void }> = [];
  autoAck = true;
  publish(suffix: TopicSuffix, payload: string): Promise<void> {
    if (!this.connected) return Promise.reject(new Error('offline'));
    return new Promise((resolve, reject) => {
      this.sent.push({ suffix, payload, resolve, reject });
      if (this.autoAck) queueMicrotask(resolve);
    });
  }
  up() {
    this.connected = true;
    this.emit('connect');
  }
  down() {
    this.connected = false;
    for (const s of this.sent.splice(0)) s.reject(new Error('closed'));
    this.emit('close');
  }
}

const reading = (i: number, register = '1.000'): NewReading => ({
  meterId: M,
  readAtMs: 1_790_000_000_000 + i * 900_000,
  readAt: '2026-11-01T00:15:00+07:00',
  register,
  unit: 'kwh',
  quality: 'good',
  configVersion: 1,
});

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const db = openDb(':memory:');
  const queue = new ReadingQueue(db);
  const outbox = new Outbox(db);
  const link = new FakeLink();
  const fwd = new Forwarder({
    gatewayId: GW,
    queue,
    outbox,
    link,
    logger: silentLogger(),
    timeZone: 'Asia/Bangkok',
    retryBaseMs: 5,
    retryMaxMs: 10,
  });
  fwd.start();
  return { db, queue, outbox, link, fwd };
}

describe('Forwarder', () => {
  it('publishes batches of ≤ 200 and deletes only on PUBACK', async () => {
    const { queue, link, fwd } = setup();
    link.autoAck = false;
    queue.append(Array.from({ length: 450 }, (_, i) => reading(i)));
    link.up();
    await tick();
    expect(link.sent.filter((s) => s.suffix === 'telemetry')).toHaveLength(3);
    const sizes = link.sent.map((s) => (JSON.parse(s.payload) as { readings: unknown[] }).readings.length);
    expect(sizes).toEqual([200, 200, 50]);
    expect(queue.metrics().depth).toBe(450);
    link.sent[0]!.resolve();
    await tick();
    expect(queue.metrics().depth).toBe(250);
    fwd.stop();
  });

  it('re-sends everything unacknowledged after the link drops, in order', async () => {
    const { queue, link } = setup();
    link.autoAck = false;
    queue.append(Array.from({ length: 300 }, (_, i) => reading(i)));
    link.up();
    await tick();
    link.sent[0]!.resolve();
    await tick();
    link.down(); // second batch never acked
    await tick();
    link.autoAck = true;
    link.up();
    await tick();
    await tick();
    const seqs = link.sent.map((s) => (JSON.parse(s.payload) as { readings: Array<{ seq: number }> }).readings[0]!.seq);
    expect(seqs).toEqual([201]);
    expect(queue.metrics().depth).toBe(0);
  });

  it('sends outbox events before telemetry and keeps them until acked', async () => {
    const { queue, outbox, link } = setup();
    outbox.push('events', { hello: 1 });
    queue.append([reading(1)]);
    link.up();
    await tick();
    expect(link.sent.map((s) => s.suffix)).toEqual(['events', 'telemetry']);
    expect(outbox.depth()).toBe(0);
  });

  it('retries with backoff after a PUBACK error (e.g. not authorised)', async () => {
    const { queue, link } = setup();
    link.autoAck = false;
    queue.append([reading(1)]);
    link.up();
    await tick();
    link.sent[0]!.reject(new Error('Publish error: Not authorized'));
    await tick();
    await tick();
    expect(link.sent.length).toBeGreaterThanOrEqual(2);
    expect(queue.metrics().depth).toBe(1);
  });

  it('never publishes a schema-invalid reading: it is dropped and counted', async () => {
    const { db, queue, link, fwd } = setup();
    queue.append([reading(1), reading(2), reading(3)]);
    db.prepare("UPDATE readings SET register = 'NaN' WHERE seq = 2").run();
    link.up();
    await tick();
    const published = link.sent
      .filter((s) => s.suffix === 'telemetry')
      .flatMap((s) => (JSON.parse(s.payload) as { readings: Array<{ seq: number; register: string }> }).readings);
    expect(published.map((p) => p.seq)).toEqual([1, 3]);
    expect(published.every((p) => /^\d{1,9}(\.\d{1,3})?$/.test(p.register))).toBe(true);
    expect(fwd.rejectedReadings).toBe(1);
    expect(queue.metrics().depth).toBe(0);
  });
});
