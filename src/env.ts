import { readFileSync } from 'node:fs';

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
  httpsFallbackAfterS: number;
  /** Cold start: fetch `GET /v1/device/config` when no config arrived on MQTT after this long; 0 = off. */
  configPullAfterS: number;
  queueCapacity: number;
  statusHost: string;
  statusPort: number;
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
  return {
    stateDir: env.GP_STATE_DIR ?? '/var/lib/getproperty-edge',
    apiBaseUrl: env.GP_API_URL ?? 'https://api.getproperty.invalid',
    apiCaFile: env.GP_API_CA_FILE || undefined,
    provisioningCode: env.GP_PROVISIONING_CODE || undefined,
    timeZone: tz,
    driverMode: mode,
    simConfig: env.GP_SIM_CONFIG || undefined,
    mqttUrlOverride: env.GP_MQTT_URL || undefined,
    mqttServername: env.GP_MQTT_SERVERNAME || undefined,
    httpsFallbackAfterS: int('GP_HTTPS_FALLBACK_AFTER_S', env.GP_HTTPS_FALLBACK_AFTER_S, 600, 0, 86_400),
    configPullAfterS: int('GP_CONFIG_PULL_AFTER_S', env.GP_CONFIG_PULL_AFTER_S, 120, 0, 86_400),
    queueCapacity: int('GP_QUEUE_CAPACITY', env.GP_QUEUE_CAPACITY, 1_000_000, 1000, 20_000_000),
    statusHost: env.GP_STATUS_HOST ?? '0.0.0.0',
    statusPort: int('GP_STATUS_PORT', env.GP_STATUS_PORT, 8080, 0, 65_535),
    logLevel: level,
    gpioChip: env.GP_GPIO_CHIP ?? 'gpiochip0',
    ledName: env.GP_LED || undefined,
    otaRoot: env.GP_OTA_ROOT ?? '/opt/getproperty-edge',
    serialNumber: env.GP_SERIAL ?? boardSerial(),
  };
}
