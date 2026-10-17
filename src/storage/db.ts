import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Agent database (node:sqlite — built into Node 24, so the SEA binary carries no native addon).
 * WAL + synchronous=FULL: a reading is durable once `append` returns (persist before publish).
 */
export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1 — store-and-forward queue, per-meter sequence state, outbox, key-value state
  `
  CREATE TABLE readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meter_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    read_at TEXT NOT NULL,
    read_at_ms INTEGER NOT NULL,
    hour_bucket INTEGER NOT NULL,
    register TEXT NOT NULL,
    unit TEXT NOT NULL,
    quality TEXT NOT NULL,
    extra TEXT,
    config_version INTEGER NOT NULL,
    published_at INTEGER,
    UNIQUE (meter_id, seq)
  );
  CREATE INDEX readings_meter_hour ON readings (meter_id, hour_bucket, id);
  CREATE TABLE meter_state (
    meter_id TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL,
    last_raw_milli TEXT,
    rollover_offset_milli TEXT NOT NULL DEFAULT '0',
    last_register_milli TEXT,
    last_read_at_ms INTEGER
  );
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_suffix TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  );
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  `,
  // 2 — pulse registers and command dedup
  `
  CREATE TABLE pulse_state (
    meter_id TEXT PRIMARY KEY,
    config_initial TEXT NOT NULL,
    initial_register TEXT NOT NULL,
    litres_per_pulse INTEGER NOT NULL,
    pulses INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE commands (
    cmd_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    ack TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL
  );
  `,
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Small persistent key-value store for agent state (applied config, boot flags, OTA markers). */
export class KvStore {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}

export function bumpCounter(db: Db, name: string, by = 1): void {
  db.prepare(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value',
  ).run(name, by);
}

export function readCounter(db: Db, name: string): number {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number } | undefined;
  return row?.value ?? 0;
}
