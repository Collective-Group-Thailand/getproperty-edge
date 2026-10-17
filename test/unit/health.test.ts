import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { HealthReporter } from '../../src/health/health-reporter.js';
import { MeterStatusTracker } from '../../src/health/meter-status.js';
import {
  cpuPct,
  defaultRouteInterface,
  type HostProbe,
  linkTypeOf,
  parseMemPct,
  parseMmcliRssi,
  parseProcStat,
  parseWirelessRssi,
  SystemMetrics,
} from '../../src/health/system-metrics.js';
import type { TopicSuffix } from '../../src/protocol/types.js';
import { assertValid } from '../../src/protocol/validate.js';
import type { Link } from '../../src/transport/link.js';
import { VirtualClock } from '../../src/util/clock.js';
import { silentLogger } from '../../src/util/logger.js';

const GW = '0192a000-0000-7000-8000-00000000aaaa';
const M1 = '0192a000-0000-7000-8000-000000000001';
const M2 = '0192a000-0000-7000-8000-000000000002';

const ROUTE_WIFI = `Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0
wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0`;
const WIRELESS = `Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 wlan0: 0000   54.  -56.  -256        0      0      0      0     12        0`;

function host(files: Record<string, string>, exec: Record<string, string> = {}): HostProbe {
  return {
    readFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error('ENOENT');
    },
    statfsFreeBytes: async () => 1800 * 1024 * 1024,
    exec: async (cmd) => {
      if (cmd in exec) return exec[cmd]!;
      throw new Error('ENOENT');
    },
  };
}

describe('system metrics parsers', () => {
  it('computes CPU % from /proc/stat deltas', () => {
    const a = parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3')!;
    const b = parseProcStat('cpu  130 0 120 850 0 0 0 0 0 0\n')!;
    expect(cpuPct(a, b)).toBe(50);
  });
  it('reads memory from MemAvailable', () => {
    expect(parseMemPct('MemTotal:  512000 kB\nMemFree: 10000 kB\nMemAvailable: 358400 kB\n')).toBe(30);
  });
  it('derives link type and RSSI from the default route', () => {
    expect(defaultRouteInterface(ROUTE_WIFI)).toBe('wlan0');
    expect(linkTypeOf('eth0')).toBe('ethernet');
    expect(linkTypeOf('end0')).toBe('ethernet');
    expect(linkTypeOf('wlan0')).toBe('wifi');
    expect(linkTypeOf('wwan0')).toBe('lte');
    expect(linkTypeOf('ppp0')).toBe('lte');
    expect(parseWirelessRssi(WIRELESS, 'wlan0')).toBe(-56);
    expect(parseMmcliRssi('{"modem":{"signal":{"lte":{"rssi":"-71.00","rsrp":"-99"}}}}')).toBe(-71);
    expect(parseMmcliRssi('not json')).toBeNull();
  });
  it('snapshots a wifi gateway', async () => {
    const m = new SystemMetrics(
      host({
        '/proc/stat': 'cpu  1 0 1 8 0 0 0\n',
        '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 690 kB\n',
        '/proc/net/route': ROUTE_WIFI,
        '/proc/net/wireless': WIRELESS,
      }),
      '/var/lib/x',
    );
    expect(await m.snapshot()).toEqual({ cpuPct: 0, memPct: 31, diskFreeMb: 1800, link: 'wifi', rssi: -56 });
  });
  it('snapshots an LTE gateway through mmcli', async () => {
    const lteRoute = ROUTE_WIFI.replace(/wlan0/g, 'wwan0');
    const m = new SystemMetrics(
      host({ '/proc/net/route': lteRoute }, { mmcli: '{"modem":{"signal":{"lte":{"rssi":"-80.00"}}}}' }),
      '/x',
    );
    const s = await m.snapshot();
    expect(s.link).toBe('lte');
    expect(s.rssi).toBe(-80);
  });
});

describe('MeterStatusTracker', () => {
  it('reports ok/timeout/crc_error/not_found and raises meter_offline once after 3 failures', () => {
    const offline: string[] = [];
    const t = new MeterStatusTracker(3, (id) => offline.push(id));
    t.reset([M1, M2]);
    t.failed(M1, 'timeout');
    expect(t.get(M1).status).toBe('not_found'); // never answered
    t.ok(M2, 1, '2026-11-01T00:15:00+07:00');
    t.failed(M2, 'timeout');
    t.failed(M2, 'crc_error');
    t.failed(M2, 'timeout');
    t.failed(M2, 'timeout');
    expect(t.get(M2)).toMatchObject({ status: 'timeout', lastReadAt: '2026-11-01T00:15:00+07:00' });
    expect(offline).toEqual([M2]);
    t.ok(M2, 2, '2026-11-01T00:30:00+07:00');
    expect(t.snapshot([M1, M2]).map((s) => s.status)).toEqual(['not_found', 'ok']);
  });
});

class Link1 extends EventEmitter implements Link {
  connected = true;
  sent: Array<{ suffix: TopicSuffix; payload: string }> = [];
  async publish(suffix: TopicSuffix, payload: string) {
    this.sent.push({ suffix, payload });
  }
}

describe('HealthReporter', () => {
  it('publishes a schema-valid heartbeat every heartbeatS with the protocol fields', async () => {
    const clock = new VirtualClock(0);
    const link = new Link1();
    const tracker = new MeterStatusTracker();
    tracker.ok(M1, 0, '2026-11-01T00:15:00+07:00');
    tracker.failed(M2, 'crc_error');
    const r = new HealthReporter(
      {
        gatewayId: GW,
        agentVersion: '0.1.0',
        configVersion: () => 12,
        bufferedReadings: () => 42,
        meters: () => tracker.snapshot([M1, M2]),
        uptimeS: () => 86400.7,
      },
      new SystemMetrics(host({ '/proc/net/route': '' }), '/x'),
      link,
      clock,
      silentLogger(),
      60,
    );
    r.start();
    await new Promise((res) => setTimeout(res, 10));
    await clock.advance(120_000);
    await new Promise((res) => setTimeout(res, 10));
    expect(link.sent.length).toBe(3);
    const h = assertValid('Health', JSON.parse(link.sent[0]!.payload));
    expect(h).toMatchObject({
      gatewayId: GW,
      agentVersion: '0.1.0',
      configVersion: 12,
      uptimeS: 86400,
      bufferedReadings: 42,
      diskFreeMb: 1800,
      link: 'ethernet',
      rssi: null,
    });
    expect(h.meters).toEqual([
      { meterId: M1, lastReadAt: '2026-11-01T00:15:00+07:00', status: 'ok' },
      { meterId: M2, lastReadAt: null, status: 'crc_error' },
    ]);
    r.stop();
  });
});
