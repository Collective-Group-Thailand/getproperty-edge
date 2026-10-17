import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';

import type { LinkType } from '../protocol/types.js';

/** Host access behind an interface so health is unit-testable with canned /proc content. */
export interface HostProbe {
  readFile(path: string): Promise<string>;
  statfsFreeBytes(path: string): Promise<number>;
  exec(cmd: string, args: string[]): Promise<string>;
}

export const realHost: HostProbe = {
  readFile: (p) => fsp.readFile(p, 'utf8'),
  statfsFreeBytes: async (p) => {
    const s = await fsp.statfs(p);
    return s.bavail * s.bsize;
  },
  exec: async (cmd, args) => (await promisify(execFile)(cmd, args, { timeout: 5000 })).stdout,
};

export interface CpuSample {
  idle: number;
  total: number;
}

export function parseProcStat(text: string): CpuSample | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] ?? 0) + (v[4] ?? 0);
  const total = v.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}

export function cpuPct(prev: CpuSample, cur: CpuSample): number {
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return clampPct(((dt - (cur.idle - prev.idle)) / dt) * 100);
}

export function parseMemPct(meminfo: string): number | null {
  const get = (k: string) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo);
    return m ? Number(m[1]) : null;
  };
  const total = get('MemTotal');
  const avail = get('MemAvailable');
  if (!total || avail === null) return null;
  return clampPct(((total - avail) / total) * 100);
}

/** Interface carrying the default route (first `00000000` destination in /proc/net/route). */
export function defaultRouteInterface(route: string): string | null {
  for (const line of route.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length > 2 && f[1] === '00000000') return f[0]!;
  }
  return null;
}

export function linkTypeOf(iface: string | null): LinkType {
  if (!iface) return 'ethernet';
  if (/^(wl|wlan|wifi)/.test(iface)) return 'wifi';
  if (/^(wwan|ppp|usb|rmnet|cdc-wdm|wwp)/.test(iface)) return 'lte';
  return 'ethernet';
}

/** /proc/net/wireless: `wlan0: 0000   54.  -56.  -256 …` → -56 dBm */
export function parseWirelessRssi(text: string, iface: string): number | null {
  const line = text.split('\n').find((l) => l.trim().startsWith(`${iface}:`));
  if (!line) return null;
  const f = line.trim().split(/\s+/);
  const level = Number(String(f[3]).replace(/\.$/, ''));
  return Number.isFinite(level) && level < 0 ? Math.round(level) : null;
}

/** `mmcli -m any --signal-get -J` → lte.rssi (dBm), else null. UNVERIFIED against a live modem. */
export function parseMmcliRssi(json: string): number | null {
  try {
    const j = JSON.parse(json) as { modem?: { signal?: Record<string, Record<string, string>> } };
    const sig = j.modem?.signal;
    for (const tech of ['5g', 'lte', 'umts', 'gsm']) {
      const v = Number(sig?.[tech]?.rssi);
      if (Number.isFinite(v) && v < 0) return Math.round(v);
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export interface SystemSnapshot {
  cpuPct: number;
  memPct: number;
  diskFreeMb: number;
  link: LinkType;
  rssi: number | null;
}

/** CPU (from /proc/stat deltas), memory (MemAvailable), disk (statfs of the state dir), link and RSSI. */
export class SystemMetrics {
  private prevCpu: CpuSample | null = null;

  constructor(
    private readonly host: HostProbe,
    private readonly stateDir: string,
  ) {}

  async snapshot(): Promise<SystemSnapshot> {
    const [stat, meminfo, route] = await Promise.all([
      this.host.readFile('/proc/stat').catch(() => ''),
      this.host.readFile('/proc/meminfo').catch(() => ''),
      this.host.readFile('/proc/net/route').catch(() => ''),
    ]);
    let cpu = 0;
    const cur = parseProcStat(stat) ?? osCpuSample();
    if (this.prevCpu) cpu = cpuPct(this.prevCpu, cur);
    this.prevCpu = cur;
    const mem = parseMemPct(meminfo) ?? clampPct(((totalmem() - freemem()) / totalmem()) * 100);
    const free = await this.host.statfsFreeBytes(this.stateDir).catch(() => 0);
    const iface = defaultRouteInterface(route);
    const link = linkTypeOf(iface);
    let rssi: number | null = null;
    if (link === 'wifi' && iface) {
      rssi = parseWirelessRssi(await this.host.readFile('/proc/net/wireless').catch(() => ''), iface);
    } else if (link === 'lte') {
      rssi = parseMmcliRssi(await this.host.exec('mmcli', ['-m', 'any', '--signal-get', '-J']).catch(() => ''));
    }
    return { cpuPct: cpu, memPct: mem, diskFreeMb: Math.floor(free / 1024 / 1024), link, rssi };
  }
}

function osCpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  return { idle, total };
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}
