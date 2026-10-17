import { join } from 'node:path';

import type { OtaFs } from './ota-fs.js';

export type Slot = 'a' | 'b';
export const BINARY = 'getproperty-edge';

/** Pending trial of a freshly installed slot — a plain KEY=VALUE file the shell guard can read too. */
export interface PendingTrial {
  slot: Slot;
  previous: Slot;
  version: string;
  fromVersion: string;
  /** Epoch seconds: the new version must publish health before this or it is rolled back. */
  deadline: number;
  attempts: number;
}

export function formatEnv(obj: Record<string, string | number>): string {
  return (
    Object.entries(obj)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('\n') + '\n'
  );
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=([A-Za-z0-9._:+-]*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * A/B update slots: `<root>/slots/{a,b}/getproperty-edge`, `<root>/slots/current → <active>` (what systemd
 * starts; only `slots/` is writable by the service user, `<root>` and the guard script stay root-owned), trial state in `<stateDir>/ota/pending.env`, rollback marker `rolled-back.env` written by
 * whoever rolled back (the agent's health gate or `scripts/ota-guard.sh` before start).
 */
export class AbSlots {
  constructor(
    private readonly fs: OtaFs,
    readonly root: string,
    readonly stateDir: string,
  ) {}

  get currentLink(): string {
    return join(this.root, 'slots', 'current');
  }
  slotDir(s: Slot): string {
    return join(this.root, 'slots', s);
  }
  binary(s: Slot): string {
    return join(this.slotDir(s), BINARY);
  }
  private get pendingPath(): string {
    return join(this.stateDir, 'ota', 'pending.env');
  }
  private get rolledBackPath(): string {
    return join(this.stateDir, 'ota', 'rolled-back.env');
  }

  async active(): Promise<Slot> {
    const target = await this.fs.readlink(this.currentLink);
    return target && /(^|\/)b\/?$/.test(target) ? 'b' : 'a';
  }

  async inactive(): Promise<Slot> {
    return (await this.active()) === 'a' ? 'b' : 'a';
  }

  /** Streams the artifact into the inactive slot as `.partial`, verifies size + sha256, then renames. */
  async install(slot: Slot, chunks: AsyncIterable<Buffer>, expect: { sha256: string; size: number }): Promise<string> {
    await this.fs.mkdirp(this.slotDir(slot));
    const partial = `${this.binary(slot)}.partial`;
    const got = await this.fs.writeStream(partial, chunks, expect.size);
    if (got.size !== expect.size || got.sha256 !== expect.sha256) {
      await this.fs.remove(partial);
      throw new Error(`integrity check failed (size ${got.size}/${expect.size}, sha256 ${got.sha256.slice(0, 12)}…)`);
    }
    await this.fs.chmod(partial, 0o755);
    await this.fs.rename(partial, this.binary(slot));
    return this.binary(slot);
  }

  /** Points `current` at the new slot and records the trial (the next start runs the new binary). */
  async switchTo(trial: PendingTrial): Promise<void> {
    if (!(await this.fs.exists(this.binary(trial.slot)))) throw new Error(`slot ${trial.slot} has no binary`);
    await this.fs.mkdirp(join(this.stateDir, 'ota'));
    await this.fs.writeTextAtomic(this.pendingPath, formatEnv(toEnv(trial)));
    await this.fs.symlinkAtomic(trial.slot, this.currentLink);
  }

  async pending(): Promise<PendingTrial | null> {
    const t = await this.fs.readText(this.pendingPath);
    if (!t) return null;
    const e = parseEnv(t);
    if ((e.SLOT !== 'a' && e.SLOT !== 'b') || (e.PREVIOUS !== 'a' && e.PREVIOUS !== 'b') || !e.VERSION) return null;
    return {
      slot: e.SLOT,
      previous: e.PREVIOUS,
      version: e.VERSION,
      fromVersion: e.FROM_VERSION ?? '',
      deadline: Number(e.DEADLINE ?? 0),
      attempts: Number(e.ATTEMPTS ?? 0),
    };
  }

  /** The trial passed the health gate: keep the new slot. */
  async commit(): Promise<void> {
    await this.fs.remove(this.pendingPath);
  }

  /** The trial failed: point `current` back at the previous slot and leave a marker for the old agent. */
  async rollback(reason: string): Promise<PendingTrial | null> {
    const p = await this.pending();
    if (!p) return null;
    await this.fs.symlinkAtomic(p.previous, this.currentLink);
    await this.fs.writeTextAtomic(
      this.rolledBackPath,
      formatEnv({ VERSION: p.version, FROM_VERSION: p.fromVersion, REASON: reason.replace(/[^A-Za-z0-9._:+-]/g, '_') }),
    );
    await this.fs.remove(this.pendingPath);
    return p;
  }

  /** Reads and clears the rollback marker (reported as `ota_rolled_back` by the running agent). */
  async takeRolledBack(): Promise<{ version: string; fromVersion: string; reason: string } | null> {
    const t = await this.fs.readText(this.rolledBackPath);
    if (!t) return null;
    await this.fs.remove(this.rolledBackPath);
    const e = parseEnv(t);
    return { version: e.VERSION ?? '', fromVersion: e.FROM_VERSION ?? '', reason: e.REASON ?? '' };
  }
}

function toEnv(t: PendingTrial): Record<string, string | number> {
  return {
    SLOT: t.slot,
    PREVIOUS: t.previous,
    VERSION: t.version,
    FROM_VERSION: t.fromVersion,
    DEADLINE: t.deadline,
    ATTEMPTS: t.attempts,
  };
}
