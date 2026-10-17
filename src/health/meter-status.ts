import type { MeterHealth, MeterHealthStatus } from '../protocol/types.js';

interface Entry {
  status: MeterHealthStatus;
  lastReadAtMs: number | null;
  lastReadAt: string | null;
  failures: number;
  offlineReported: boolean;
}

/** Per-meter bus result for Health (`ok | timeout | crc_error | not_found`) and meter_offline detection. */
export class MeterStatusTracker {
  private readonly m = new Map<string, Entry>();

  constructor(
    private readonly offlineAfter = 3,
    private readonly onOffline?: (meterId: string, status: MeterHealthStatus, failures: number) => void,
  ) {}

  reset(meterIds: string[]): void {
    for (const id of [...this.m.keys()]) if (!meterIds.includes(id)) this.m.delete(id);
    for (const id of meterIds) if (!this.m.has(id)) this.m.set(id, blank());
  }

  ok(meterId: string, atMs: number, atIso: string): void {
    const e = this.m.get(meterId) ?? blank();
    e.status = 'ok';
    e.lastReadAtMs = atMs;
    e.lastReadAt = atIso;
    e.failures = 0;
    e.offlineReported = false;
    this.m.set(meterId, e);
  }

  failed(meterId: string, status: Exclude<MeterHealthStatus, 'ok'>): void {
    const e = this.m.get(meterId) ?? blank();
    // A meter that never answered since the binding is reported not_found rather than timeout.
    e.status = status === 'timeout' && e.lastReadAtMs === null ? 'not_found' : status;
    e.failures++;
    if (e.failures >= this.offlineAfter && !e.offlineReported) {
      e.offlineReported = true;
      this.onOffline?.(meterId, e.status, e.failures);
    }
    this.m.set(meterId, e);
  }

  get(meterId: string): { status: MeterHealthStatus; lastReadAt: string | null; lastReadAtMs: number | null } {
    const e = this.m.get(meterId) ?? blank();
    return { status: e.status, lastReadAt: e.lastReadAt, lastReadAtMs: e.lastReadAtMs };
  }

  snapshot(meterIds: string[]): MeterHealth[] {
    return meterIds.map((id) => {
      const e = this.m.get(id) ?? blank();
      return { meterId: id, lastReadAt: e.lastReadAt, status: e.status };
    });
  }
}

function blank(): Entry {
  // Not yet polled: reported `ok` with lastReadAt null until the first attempt says otherwise.
  return { status: 'ok', lastReadAtMs: null, lastReadAt: null, failures: 0, offlineReported: false };
}
