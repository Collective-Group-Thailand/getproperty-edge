import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildAck, buildEvent, buildHealth, buildTelemetryBatch, topic } from '../../src/protocol/envelopes.js';
import { PROTOCOL_SHA256 } from '../../src/protocol/schema.js';
import type { Reading } from '../../src/protocol/types.js';
import { assertValid, isValid, SchemaError } from '../../src/protocol/validate.js';

const GW = '0192a000-0000-7000-8000-00000000aaaa';
const M1 = '0192a000-0000-7000-8000-000000000001';
const reading = (seq: number, over: Partial<Reading> = {}): Reading => ({
  meterId: M1,
  seq,
  readAt: '2026-11-01T00:15:00+07:00',
  register: '12345.678',
  unit: 'kwh',
  quality: 'good',
  ...over,
});

describe('generated protocol', () => {
  it('is pinned in protocol.lock.json and up to date with the api contract', () => {
    const lock = JSON.parse(readFileSync(new URL('../../protocol.lock.json', import.meta.url), 'utf8')) as {
      sha256: string;
    };
    expect(PROTOCOL_SHA256).toBe(lock.sha256);
    const out = execFileSync('node', ['scripts/gen-protocol.mjs', '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/up to date|vendored schema matches/);
  });

  it('pins the sha256 of the source file', () => {
    let src: string | null = null;
    try {
      src = readFileSync(new URL('../../../getproperty-api/contract/device-protocol.json', import.meta.url), 'utf8');
    } catch {
      /* sibling repo not checked out */
    }
    if (src) expect(createHash('sha256').update(src).digest('hex')).toBe(PROTOCOL_SHA256);
  });
});

describe('envelopes are validated before they leave', () => {
  it('builds a valid TelemetryBatch', () => {
    const b = buildTelemetryBatch(GW, 3, '2026-11-01T00:15:03+07:00', [
      reading(1),
      reading(2, { extra: { voltage: 228.1 } }),
    ]);
    expect(b.readings).toHaveLength(2);
    expect(topic(GW, 'telemetry')).toBe(`gp/v1/${GW}/telemetry`);
  });

  it.each([
    ['register with 4 decimals', { register: '1.2345' }],
    ['negative register', { register: '-1.000' }],
    ['unknown quality', { quality: 'bad' }],
    ['non-numeric extra', { extra: { note: 'x' } }],
    ['readAt without offset', { readAt: 'yesterday' }],
  ])('rejects %s', (_label, over) => {
    expect(() =>
      buildTelemetryBatch(GW, 3, '2026-11-01T00:15:03+07:00', [reading(1, over as Partial<Reading>)]),
    ).toThrow(SchemaError);
  });

  it('rejects empty, oversized and duplicate batches', () => {
    expect(() => buildTelemetryBatch(GW, 1, '2026-11-01T00:15:03+07:00', [])).toThrow(SchemaError);
    const many = Array.from({ length: 201 }, (_, i) => reading(i + 1));
    expect(() => buildTelemetryBatch(GW, 1, '2026-11-01T00:15:03+07:00', many)).toThrow(SchemaError);
    expect(() => buildTelemetryBatch(GW, 1, '2026-11-01T00:15:03+07:00', [reading(5), reading(5)])).toThrow(
      /duplicate/,
    );
  });

  it('builds events, acks and health', () => {
    const e = buildEvent(GW, 'config_applied', 'info', '2026-11-01T00:15:03+07:00', { configVersion: '12' });
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      buildAck('0192a000-0000-7000-8000-0000000000cc', 'accepted', '2026-11-01T00:15:03+07:00').finishedAt,
    ).toBeUndefined();
    expect(() =>
      buildHealth({
        gatewayId: GW,
        agentVersion: '0.1.0',
        configVersion: 1,
        uptimeS: 1,
        bufferedReadings: 0,
        diskFreeMb: 1,
        cpuPct: 101,
        memPct: 1,
        link: 'ethernet',
        rssi: null,
        meters: [],
      }),
    ).toThrow(SchemaError);
  });

  it('validates configs and commands', () => {
    expect(isValid('GatewayConfig', { version: 1, pollIntervalS: 900, heartbeatS: 60, buses: [], meters: [] })).toBe(
      true,
    );
    expect(isValid('GatewayConfig', { version: 1, pollIntervalS: 30, heartbeatS: 60, buses: [], meters: [] })).toBe(
      false,
    );
    expect(() => assertValid('Command', { cmdId: 'x', type: 'read_now', issuedAt: 'now' })).toThrow(SchemaError);
  });
});
