import type { StatementSync } from 'node:sqlite';

import type { TopicSuffix } from '../protocol/types.js';
import { bumpCounter, type Db } from '../storage/db.js';

export interface OutboxItem {
  id: number;
  suffix: TopicSuffix;
  payload: string;
}

/**
 * Durable outbox for events and command acks: persisted before any publish, deleted on PUBACK, so an
 * event raised while offline (power_loss, seq_gap, config_applied…) still reaches the cloud.
 */
export class Outbox {
  private cursor = 0;
  private readonly insert: StatementSync;
  private readonly next: StatementSync;
  private readonly del: StatementSync;
  private readonly trim: StatementSync;

  constructor(
    private readonly db: Db,
    private readonly capacity = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    this.insert = db.prepare('INSERT INTO outbox (topic_suffix, payload, created_at_ms) VALUES (?, ?, ?)');
    this.next = db.prepare('SELECT id, topic_suffix, payload FROM outbox WHERE id > ? ORDER BY id LIMIT ?');
    this.del = db.prepare('DELETE FROM outbox WHERE id = ?');
    this.trim = db.prepare(
      'DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY id LIMIT max(0, (SELECT count(*) FROM outbox) - ?))',
    );
  }

  push(suffix: TopicSuffix, payload: unknown): void {
    this.insert.run(suffix, JSON.stringify(payload), this.now());
    const res = this.trim.run(this.capacity);
    if (Number(res.changes) > 0) bumpCounter(this.db, 'outbox_dropped', Number(res.changes));
  }

  take(max = 20): OutboxItem[] {
    const rows = this.next.all(this.cursor, max) as unknown as Array<{
      id: number;
      topic_suffix: string;
      payload: string;
    }>;
    if (rows.length) this.cursor = rows[rows.length - 1]!.id;
    return rows.map((r) => ({ id: r.id, suffix: r.topic_suffix as TopicSuffix, payload: r.payload }));
  }

  ack(id: number): void {
    this.del.run(id);
  }

  rewind(): void {
    this.cursor = 0;
  }

  depth(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM outbox').get() as { n: number }).n;
  }

  hasPending(): boolean {
    return this.db.prepare('SELECT 1 AS x FROM outbox WHERE id > ? LIMIT 1').get(this.cursor) !== undefined;
  }
}
