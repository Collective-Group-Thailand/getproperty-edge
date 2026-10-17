const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** UTC offset of `timeZone` at instant `ms`, in minutes (Asia/Bangkok → 420). */
export function tzOffsetMinutes(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO 8601 with the zone offset, second precision: `2026-11-01T00:15:00+07:00` (protocol `readAt`). */
export function isoWithOffset(ms: number, timeZone: string): string {
  const off = tzOffsetMinutes(ms, timeZone);
  const d = new Date(Math.floor(ms / 1000) * 1000 + off * 60_000);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

/**
 * Next instant strictly after `ms` that is a multiple of `intervalS` counted from local midnight
 * (900 s → :00/:15/:30/:45 local wall clock), so cut-off readings exist (D-031).
 */
export function nextAlignedTick(ms: number, intervalS: number, timeZone: string): number {
  const intervalMs = intervalS * 1000;
  const offMs = tzOffsetMinutes(ms, timeZone) * 60_000;
  const local = ms + offMs;
  const next = (Math.floor(local / intervalMs) + 1) * intervalMs;
  return next - offMs;
}

/** Local-wall-clock day of week (0 = Sunday) and hour, used by the simulator profiles. */
export function localDayHour(ms: number, timeZone: string): { dayIndex: number; weekday: number; hour: number } {
  const local = ms + tzOffsetMinutes(ms, timeZone) * 60_000;
  const dayIndex = Math.floor(local / 86_400_000);
  const d = new Date(local);
  return { dayIndex, weekday: d.getUTCDay(), hour: d.getUTCHours() };
}
