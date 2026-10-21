import { readFileSync } from 'node:fs';

import { assertSecureUrl } from './transport/https/device-api.js';
import { assertSecureBrokerUrl } from './transport/mqtt/mqtt-link.js';

/**
 * Production device host on Collective's shared AWS platform (D-230, getproperty-api `docs/deployment.md` §4/§5):
 * Caddy's `DEVICE_HOST` (`/v1/device/*` only, gateway client certificates checked against the device CA). The MQTT
 * broker URL (`mqtts://<MQTT_HOST>:8883`) is not configured here — it comes with the bootstrap answer.
 */
export const DEFAULT_DEVICE_API_URL = 'https://device.getproperty.co';

export interface AgentEnv {
  stateDir: string;
  apiBaseUrl: string;
  apiCaFile: string | undefined;
  provisioningCode: string | undefined;
  timeZone: string;
  driverMode: 'hardware' | 'simulator';
  simConfig: string | undefined;
  mqttUrlOverride: string | undefined;
  mqttServername: string | undefined;
  /**
   * `GP_MQTT_WS_FALLBACK`: allow the WebSocket fallback `wss://<MQTT_HOST>/mqtt` after repeated 8883 failures (D-239,
   * O-012 resolved). Off by default; effective only when the bootstrap answer carried `mqtt.wsUrl` (the platform admin
   * enabled the fallback for this gateway). On that path the device JWT is the only credential (no client certificate).
   */
  mqttWsFallback: boolean;
  httpsFallbackAfterS: number;
  /** Cold start: fetch `GET /v1/device/config` when no config arrived on MQTT after this long; 0 = off. */
  configPullAfterS: number;
  queueCapacity: number;
  /** Status page bind address — 127.0.0.1 by default (review #12); a LAN address needs the local admin token. */
  statusHost: string;
  statusPort: number;
  /** Local admin token of the status page for LAN clients (≥ 16 chars); generated into the state dir when unset. */
  statusToken?: string | undefined;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  gpioChip: string;
  ledName: string | undefined;
  otaRoot: string;
  serialNumber: string | null;
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function int(name: string, v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return n;
}

/** Device serial from the device tree (Raspberry Pi / most ARM boards), else null. */
function boardSerial(): string | null {
  for (const p of ['/sys/firmware/devicetree/base/serial-number', '/proc/device-tree/serial-number']) {
    try {
      const s = readFileSync(p, 'utf8').replace(/\0/g, '').trim();
      if (s) return s;
    } catch {
      /* not present */
    }
  }
  return null;
}

function flag(name: string, v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  if (/^(1|on|true|yes)$/i.test(v)) return true;
  if (/^(0|off|false|no)$/i.test(v)) return false;
  throw new Error(`${name} must be on | off`);
}

function statusToken(v: string | undefined): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (!/^[\x21-\x7e]{16,128}$/.test(v)) throw new Error('GP_STATUS_TOKEN must be 16–128 printable characters');
  return v;
}

/**
 * Validated environment (fail fast at boot, values never printed). Everything about meters comes
 * from the cloud config — the environment only says where the agent lives and how to reach the cloud.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const mode = env.GP_DRIVER_MODE ?? 'hardware';
  if (mode !== 'hardware' && mode !== 'simulator') throw new Error('GP_DRIVER_MODE must be hardware | simulator');
  const level = (env.GP_LOG_LEVEL ?? 'info') as AgentEnv['logLevel'];
  if (!LEVELS.includes(level)) throw new Error(`GP_LOG_LEVEL must be one of ${LEVELS.join(', ')}`);
  const tz = env.GP_TZ ?? 'Asia/Bangkok';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new Error(`GP_TZ ${tz} is not an IANA time zone`);
  }
  const apiBaseUrl = env.GP_API_URL || DEFAULT_DEVICE_API_URL;
  let apiUrl: URL;
  try {
    apiUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error('GP_API_URL must be a URL (the device host, e.g. https://device.getproperty.co)');
  }
  assertSecureUrl(apiUrl);
  if (env.GP_MQTT_URL) assertSecureBrokerUrl(env.GP_MQTT_URL);
  return {
    stateDir: env.GP_STATE_DIR ?? '/var/lib/getproperty-edge',
    apiBaseUrl,
    apiCaFile: env.GP_API_CA_FILE || undefined,
    provisioningCode: env.GP_PROVISIONING_CODE || undefined,
    timeZone: tz,
    driverMode: mode,
    simConfig: env.GP_SIM_CONFIG || undefined,
    mqttUrlOverride: env.GP_MQTT_URL || undefined,
    mqttServername: env.GP_MQTT_SERVERNAME || undefined,
    mqttWsFallback: flag('GP_MQTT_WS_FALLBACK', env.GP_MQTT_WS_FALLBACK, false),
    httpsFallbackAfterS: int('GP_HTTPS_FALLBACK_AFTER_S', env.GP_HTTPS_FALLBACK_AFTER_S, 600, 0, 86_400),
    configPullAfterS: int('GP_CONFIG_PULL_AFTER_S', env.GP_CONFIG_PULL_AFTER_S, 120, 0, 86_400),
    queueCapacity: int('GP_QUEUE_CAPACITY', env.GP_QUEUE_CAPACITY, 1_000_000, 1000, 20_000_000),
    statusHost: env.GP_STATUS_HOST || '127.0.0.1',
    statusToken: statusToken(env.GP_STATUS_TOKEN),
    statusPort: int('GP_STATUS_PORT', env.GP_STATUS_PORT, 8080, 0, 65_535),
    logLevel: level,
    gpioChip: env.GP_GPIO_CHIP ?? 'gpiochip0',
    ledName: env.GP_LED || undefined,
    otaRoot: env.GP_OTA_ROOT ?? '/opt/getproperty-edge',
    serialNumber: env.GP_SERIAL ?? boardSerial(),
  };
}
