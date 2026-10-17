import type { StatementSync } from 'node:sqlite';

import type { MeterUnit, Reading, ReadingQuality } from '../protocol/types.js';
import { bumpCounter, type Db, readCounter, transaction } from '../storage/db.js';

export interface NewReading {
  meterId: string;
  readAtMs: number;
  /** ISO 8601 with offset, as published */
  readAt: string;
  /** Decimal string `^\d{1,9}(\.\d{1,3})?$` */
  register: string;
  unit: MeterUnit;
  quality: ReadingQuality;
  extra?: Record<string, number>;
  configVersion: number;
  /** Register maths state to persist together with the reading (same transaction). */
  state?: { rawMilli: bigint; rolloverOffsetMilli: bigint; registerMilli: bigint };
}

export interface QueuedReading extends Reading {
  id: number;
  configVersion: number;
}

export interface MeterSeqState {
  lastSeq: number;
  lastRawMilli: bigint | null;
  rolloverOffsetMilli: bigint;
  lastRegisterMilli: bigint | null;
  lastReadAtMs: number | null;
}

export interface SeqGap {
  meterId: string;
  fromSeq: number;
  toSeq: number;
  evicted: number;
  reason: 'buffer_eviction' | 'buffer_hard_limit';
}

export interface QueueMetrics {
  depth: number;
  oldestReadAt: string | null;
  evictedTotal: number;
  appendedTotal: number;
  ackedTotal: number;
  inflight: number;
}

export interface ReadingQueueOptions {
  /**
   * Maximum buffered readings. Default 1,000,000 ≥ 30 days × 300 meters × 96 reads/day (864,000;
   * protocol §4 — its "~8.6 M" figure is 10× the arithmetic, see PROGRESS).
   */
  capacity?: number;
  onSeqGap?: (gap: SeqGap) => void;
  now?: () => number;
}

interface Row {
  id: number;
  meter_id: string;
  seq: number;
  read_at: string;
  register: string;
  unit: string;
  quality: string;
  extra: string | null;
  config_version: number;
}

/**
 * Append-only on-disk queue (protocol §4): persist before publish, delete only on PUBACK,
 * evict the oldest *interval* readings when full but never the last reading per meter per hour.
 */
export class ReadingQueue {
  readonly capacity: number;
  private depth: number;
  /** Highest id handed out to the transport since the last rewind; rows above it are not in flight. */
  private cursor = 0;
  private inflightIds = new Set<number>();
  private readonly stmts: {
    getState: StatementSync;
    upsertState: StatementSync;
    insert: StatementSync;
    next: StatementSync;
    del: StatementSync;
    mark: StatementSync;
    oldest: StatementSync;
    evictable: StatementSync;
    oldestAny: StatementSync;
  };

  constructor(
    private readonly db: Db,
    private readonly opts: ReadingQueueOptions = {},
  ) {
    this.capacity = opts.capacity ?? 1_000_000;
    this.depth = (db.prepare('SELECT count(*) AS n FROM readings').get() as { n: number }).n;
    this.stmts = {
      getState: db.prepare('SELECT * FROM meter_state WHERE meter_id = ?'),
      upsertState: db.prepare(
        `INSERT INTO meter_state (meter_id, last_seq, last_raw_milli, rollover_offset_milli, last_register_milli, last_read_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(meter_id) DO UPDATE SET last_seq = excluded.last_seq, last_raw_milli = excluded.last_raw_milli,
           rollover_offset_milli = excluded.rollover_offset_milli, last_register_milli = excluded.last_register_milli,
           last_read_at_ms = excluded.last_read_at_ms`,
      ),
      insert: db.prepare(
        `INSERT INTO readings (meter_id, seq, read_at, read_at_ms, hour_bucket, register, unit, quality, extra, config_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      next: db.prepare(
        'SELECT id, meter_id, seq, read_at, register, unit, quality, extra, config_version FROM readings WHERE id > ? ORDER BY id LIMIT ?',
      ),
      del: db.prepare('DELETE FROM readings WHERE id IN (SELECT value FROM json_each(?))'),
      mark: db.prepare('UPDATE readings SET published_at = ? WHERE id IN (SELECT value FROM json_each(?))'),
      oldest: db.prepare('SELECT read_at FROM readings ORDER BY id LIMIT 1'),
      evictable: db.prepare(
        `SELECT r.id, r.meter_id, r.seq FROM readings r
         WHERE EXISTS (SELECT 1 FROM readings r2 WHERE r2.meter_id = r.meter_id AND r2.hour_bucket = r.hour_bucket AND r2.id > r.id)
         ORDER BY r.id LIMIT ?`,
      ),
      oldestAny: db.prepare('SELECT id, meter_id, seq FROM readings ORDER BY id LIMIT ?'),
    };
  }

  meterState(meterId: string): MeterSeqState {
    const row = this.stmts.getState.get(meterId) as
      | {
          last_seq: number;
          last_raw_milli: string | null;
          rollover_offset_milli: string;
          last_register_milli: string | null;
          last_read_at_ms: number | null;
        }
      | undefined;
    if (!row)
      return { lastSeq: 0, lastRawMilli: null, rolloverOffsetMilli: 0n, lastRegisterMilli: null, lastReadAtMs: null };
    return {
      lastSeq: row.last_seq,
      lastRawMilli: row.last_raw_milli === null ? null : BigInt(row.last_raw_milli),
      rolloverOffsetMilli: BigInt(row.rollover_offset_milli),
      lastRegisterMilli: row.last_register_milli === null ? null : BigInt(row.last_register_milli),
      lastReadAtMs: row.last_read_at_ms,
    };
  }

  /** Assigns the next per-meter seq and persists the readings in one transaction. Returns the assigned seqs. */
  append(readings: NewReading[]): number[] {
    if (readings.length === 0) return [];
    const seqs = transaction(this.db, () => {
      const out: number[] = [];
      for (const r of readings) {
        const st = this.meterState(r.meterId);
        const seq = st.lastSeq + 1;
        this.stmts.insert.run(
          r.meterId,
          seq,
          r.readAt,
          r.readAtMs,
          Math.floor(r.readAtMs / 3_600_000),
          r.register,
          r.unit,
          r.quality,
          r.extra && Object.keys(r.extra).length ? JSON.stringify(r.extra) : null,
          r.configVersion,
        );
        this.stmts.upsertState.run(
          r.meterId,
          seq,
          r.state ? r.state.rawMilli.toString() : (st.lastRawMilli?.toString() ?? null),
          r.state ? r.state.rolloverOffsetMilli.toString() : st.rolloverOffsetMilli.toString(),
          r.state ? r.state.registerMilli.toString() : (st.lastRegisterMilli?.toString() ?? null),
          r.readAtMs,
        );
        out.push(seq);
      }
      bumpCounter(this.db, 'readings_appended', readings.length);
      return out;
    });
    this.depth += readings.length;
    if (this.depth > this.capacity) this.evict(this.depth - this.capacity);
    return seqs;
  }

  /**
   * Next batch (≤ max readings, one configVersion) not already in flight, in append order.
   * The caller must `ack` or `release` the ids.
   */
  nextBatch(max = 200): { ids: number[]; configVersion: number; readings: Reading[] } | null {
    const rows = this.stmts.next.all(this.cursor, max) as unknown as Row[];
    if (rows.length === 0) return null;
    const version = rows[0]!.config_version;
    const cut = rows.findIndex((r) => r.config_version !== version);
    const batch = cut === -1 ? rows : rows.slice(0, cut);
    const ids = batch.map((r) => r.id);
    this.cursor = ids[ids.length - 1]!;
    for (const id of ids) this.inflightIds.add(id);
    this.stmts.mark.run(this.now(), JSON.stringify(ids));
    return { ids, configVersion: version, readings: batch.map(toReading) };
  }

  /** PUBACK (or HTTPS 2xx) received: the readings are durable in the cloud — delete them. */
  ack(ids: number[]): void {
    if (ids.length === 0) return;
    const res = this.stmts.del.run(JSON.stringify(ids));
    for (const id of ids) this.inflightIds.delete(id);
    this.depth -= Number(res.changes);
    bumpCounter(this.db, 'readings_acked', Number(res.changes));
  }

  /** The publish failed or the link dropped: everything not yet acked is sent again, in order. */
  rewind(): void {
    this.cursor = 0;
    this.inflightIds.clear();
  }

  hasPending(): boolean {
    return (this.db.prepare('SELECT 1 AS x FROM readings WHERE id > ? LIMIT 1').get(this.cursor) ?? null) !== null;
  }

  metrics(): QueueMetrics {
    const oldest = this.stmts.oldest.get() as { read_at: string } | undefined;
    return {
      depth: this.depth,
      oldestReadAt: oldest?.read_at ?? null,
      evictedTotal: readCounter(this.db, 'readings_evicted'),
      appendedTotal: readCounter(this.db, 'readings_appended'),
      ackedTotal: readCounter(this.db, 'readings_acked'),
      inflight: this.inflightIds.size,
    };
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private evict(excess: number): void {
    // Evict a little more than needed (0.5 % of capacity) so eviction does not run on every append.
    const target = excess + Math.max(1, Math.floor(this.capacity * 0.005));
    const victims = this.stmts.evictable.all(target) as unknown as Array<{ id: number; meter_id: string; seq: number }>;
    const removed = this.deleteVictims(victims, 'buffer_eviction');
    if (removed < excess) {
      // Only hourly keeper readings are left and the buffer is still over capacity: drop the oldest
      // ones rather than lose new readings (disk protection). Reported as a seq_gap (critical).
      const rest = this.stmts.oldestAny.all(excess - removed) as unknown as Array<{
        id: number;
        meter_id: string;
        seq: number;
      }>;
      this.deleteVictims(rest, 'buffer_hard_limit');
    }
  }

  private deleteVictims(
    victims: Array<{ id: number; meter_id: string; seq: number }>,
    reason: SeqGap['reason'],
  ): number {
    if (victims.length === 0) return 0;
    const ids = victims.map((v) => v.id);
    transaction(this.db, () => {
      this.stmts.del.run(JSON.stringify(ids));
      bumpCounter(this.db, 'readings_evicted', ids.length);
    });
    for (const id of ids) this.inflightIds.delete(id);
    this.depth -= ids.length;
    const perMeter = new Map<string, SeqGap>();
    for (const v of victims) {
      const g = perMeter.get(v.meter_id);
      if (!g) perMeter.set(v.meter_id, { meterId: v.meter_id, fromSeq: v.seq, toSeq: v.seq, evicted: 1, reason });
      else {
        g.fromSeq = Math.min(g.fromSeq, v.seq);
        g.toSeq = Math.max(g.toSeq, v.seq);
        g.evicted++;
      }
    }
    for (const g of perMeter.values()) this.opts.onSeqGap?.(g);
    return ids.length;
  }
}

function toReading(r: Row): Reading {
  const reading: Reading = {
    meterId: r.meter_id,
    seq: r.seq,
    readAt: r.read_at,
    register: r.register,
    unit: r.unit as MeterUnit,
    quality: r.quality as ReadingQuality,
  };
  if (r.extra) reading.extra = JSON.parse(r.extra) as Record<string, number>;
  return reading;
}
