import type { TelemetryBatch } from '../src/protocol/types.js';
import { assertValid, type PayloadName } from '../src/protocol/validate.js';

/**
 * Reference ingest (mirrors getproperty-api's ingest rules, D-143): validates every envelope against the
 * contract, checks topic gateway = payload gateway = certificate CN, dedups on (meterId, seq) and keeps
 * enough per-meter state to prove "zero lost, zero duplicates accepted, in order".
 */
export class IngestStub {
  accepted = 0;
  duplicates = 0;
  invalid = 0;
  identityMismatch = 0;
  outOfOrder = 0;
  batches = 0;
  readonly events: Array<{ type: string; [k: string]: unknown }> = [];
  readonly health: unknown[] = [];
  readonly acks: Array<{ cmdId: string; status: string; [k: string]: unknown }> = [];
  lwt = 0;
  private readonly seen = new Map<string, { bits: Uint8Array; max: number }>();
  readonly lastRegister = new Map<string, string>();
  readonly qualities = new Map<string, number>();
  /** Keep every accepted reading (small tests); off for the soak run. */
  readonly keep: TelemetryBatch['readings'] | null;

  constructor(opts: { keepReadings?: boolean } = {}) {
    this.keep = opts.keepReadings === false ? null : [];
  }

  handle(cn: string, topic: string, payload: Buffer): void {
    const m = /^gp\/v1\/([0-9a-f-]{36})\/(telemetry|health|events|cmd\/ack)$/.exec(topic);
    if (!m) return;
    const [, gw, kind] = m;
    if (cn !== `gw-${gw}` && cn !== 'cloud') {
      this.identityMismatch++;
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(payload.toString('utf8'));
    } catch {
      this.invalid++;
      return;
    }
    if (kind === 'health' && (doc as { status?: string }).status === 'offline_lwt') {
      this.lwt++;
      return;
    }
    const name: PayloadName =
      kind === 'telemetry'
        ? 'TelemetryBatch'
        : kind === 'health'
          ? 'Health'
          : kind === 'events'
            ? 'DeviceEvent'
            : 'CommandAck';
    try {
      assertValid(name, doc);
    } catch {
      this.invalid++;
      return;
    }
    if ((doc as { gatewayId?: string }).gatewayId && (doc as { gatewayId: string }).gatewayId !== gw) {
      this.identityMismatch++;
      return;
    }
    if (kind === 'telemetry') this.telemetry(doc as TelemetryBatch);
    else if (kind === 'health') this.health.push(doc);
    else if (kind === 'events') this.events.push(doc as { type: string });
    else this.acks.push(doc as { cmdId: string; status: string });
  }

  /** Same envelope over HTTPS fallback (`POST /v1/device/readings/batch`). */
  telemetry(batch: TelemetryBatch): void {
    this.batches++;
    for (const r of batch.readings) {
      let s = this.seen.get(r.meterId);
      if (!s) {
        s = { bits: new Uint8Array(4096), max: 0 };
        this.seen.set(r.meterId, s);
      }
      if (r.seq >= s.bits.length * 8) {
        const bigger = new Uint8Array(Math.max(s.bits.length * 2, Math.ceil((r.seq + 1) / 8) + 1024));
        bigger.set(s.bits);
        s.bits = bigger;
      }
      const byte = r.seq >> 3;
      const bit = 1 << (r.seq & 7);
      if (s.bits[byte]! & bit) {
        this.duplicates++;
        continue;
      }
      s.bits[byte]! |= bit;
      if (r.seq < s.max) this.outOfOrder++;
      s.max = Math.max(s.max, r.seq);
      this.accepted++;
      this.lastRegister.set(r.meterId, r.register);
      this.qualities.set(r.quality, (this.qualities.get(r.quality) ?? 0) + 1);
      this.keep?.push(r);
    }
  }

  /** Seqs 1..max present for every meter (no gap) — returns the meters with gaps. */
  gaps(): string[] {
    const out: string[] = [];
    for (const [meter, s] of this.seen) {
      for (let q = 1; q <= s.max; q++) {
        if (!(s.bits[q >> 3]! & (1 << (q & 7)))) {
          out.push(meter);
          break;
        }
      }
    }
    return out;
  }

  maxSeq(meterId: string): number {
    return this.seen.get(meterId)?.max ?? 0;
  }

  meters(): number {
    return this.seen.size;
  }
}
