import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Backoff } from '../../src/util/backoff.js';
import { VirtualClock } from '../../src/util/clock.js';
import { applyScale, formatMilli, milliFromNumber, parseMilli } from '../../src/util/decimal.js';
import { isoWithOffset, nextAlignedTick, tzOffsetMinutes } from '../../src/util/time.js';
import { AGENT_VERSION } from '../../src/version.js';

describe('decimal registers', () => {
  it('round-trips protocol decimal strings through milli-units', () => {
    expect(formatMilli(parseMilli('12345.678'))).toBe('12345.678');
    expect(formatMilli(parseMilli('1532.04'))).toBe('1532.040');
    expect(formatMilli(parseMilli('7'))).toBe('7.000');
    expect(() => parseMilli('1.2345')).toThrow();
    expect(() => parseMilli('-1')).toThrow();
  });
  it('rounds float32 meter values to 3 decimals without float drift', () => {
    const f32 = new Float32Array([12345.678])[0]!; // 12345.677734375
    expect(formatMilli(milliFromNumber(f32))).toBe('12345.678');
    expect(formatMilli(milliFromNumber(0.1 + 0.2))).toBe('0.300');
  });
  it('applies decimal scales exactly, half-up', () => {
    expect(formatMilli(applyScale(parseMilli('100.000'), '40'))).toBe('4000.000');
    expect(formatMilli(applyScale(parseMilli('1.005'), '0.5'))).toBe('0.503');
    expect(formatMilli(applyScale(12_345n * 1000n, '0.01'))).toBe('123.450');
  });
});

describe('time', () => {
  it('formats readAt in Asia/Bangkok with the +07:00 offset', () => {
    const ms = Date.parse('2026-10-31T17:15:00Z');
    expect(tzOffsetMinutes(ms, 'Asia/Bangkok')).toBe(420);
    expect(isoWithOffset(ms, 'Asia/Bangkok')).toBe('2026-11-01T00:15:00+07:00');
    expect(isoWithOffset(ms, 'UTC')).toBe('2026-10-31T17:15:00+00:00');
  });
  it('aligns ticks to :00/:15/:30/:45 local', () => {
    const t = Date.parse('2026-11-01T00:07:31+07:00');
    expect(isoWithOffset(nextAlignedTick(t, 900, 'Asia/Bangkok'), 'Asia/Bangkok')).toBe('2026-11-01T00:15:00+07:00');
    const exact = Date.parse('2026-11-01T00:15:00+07:00');
    expect(isoWithOffset(nextAlignedTick(exact, 900, 'Asia/Bangkok'), 'Asia/Bangkok')).toBe(
      '2026-11-01T00:30:00+07:00',
    );
    // hourly in a half-hour zone still lands on the local hour
    const ist = Date.parse('2026-11-01T10:10:00+05:30');
    expect(isoWithOffset(nextAlignedTick(ist, 3600, 'Asia/Kolkata'), 'Asia/Kolkata')).toBe('2026-11-01T11:00:00+05:30');
  });
});

describe('VirtualClock', () => {
  it('fires timers in order as time advances', async () => {
    const c = new VirtualClock(1000);
    const fired: string[] = [];
    c.setTimeout(() => fired.push('b'), 200);
    c.setTimeout(() => fired.push('a'), 100);
    const h = c.setTimeout(() => fired.push('x'), 150);
    c.clearTimeout(h);
    await c.advance(150);
    expect(fired).toEqual(['a']);
    await c.advance(100);
    expect(fired).toEqual(['a', 'b']);
    expect(c.now()).toBe(1250);
  });
});

describe('Backoff', () => {
  it('grows exponentially with full jitter and caps', () => {
    const b = new Backoff(100, 1000, () => 0.999);
    const seq = Array.from({ length: 6 }, () => b.next());
    expect(seq[0]).toBeLessThan(100);
    expect(seq[3]).toBeGreaterThan(seq[1]!);
    expect(Math.max(...seq)).toBeLessThanOrEqual(1000);
    b.reset();
    expect(b.next()).toBeLessThan(100);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(AGENT_VERSION).toBe(pkg.version);
  });
});
