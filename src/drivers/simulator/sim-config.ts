/**
 * Simulator configuration (env `GP_SIM_CONFIG` = inline JSON or a file path). Shared with
 * getproperty-api's `pnpm sim:gateway`, so the format is documented in docs/SIMULATOR.md.
 */
export type SimFault =
  | { type: 'timeout'; from?: string; to?: string; probability?: number }
  | { type: 'crc_error'; from?: string; to?: string; probability?: number }
  | { type: 'not_found'; from?: string; to?: string }
  | { type: 'stuck'; from: string; to?: string }
  | { type: 'rollover'; at: string }
  | { type: 'swap'; at: string; newInitialRegister: string };

export interface SimMeterConfig {
  occupied?: boolean;
  initialRegister?: string;
  /** Average consumption per day on a weekday when occupied (kWh or m³). */
  dailyMean?: number;
  faults?: SimFault[];
}

export interface SimConfig {
  seed?: string;
  /** Share of occupied units for meters without an explicit `occupied` (default 0.85). */
  occupancyRate?: number;
  /** Profiles start here (cumulative = initialRegister before it). Default 2026-01-01T00:00:00+07:00. */
  epoch?: string;
  /** Simulated bus latency per read (ms) — 0 for soak runs. */
  latencyMs?: number;
  defaults?: SimMeterConfig;
  meters?: Record<string, SimMeterConfig>;
}

export function parseSimConfig(raw: string | undefined, readFile: (p: string) => string): SimConfig {
  if (!raw) return {};
  const text = raw.trim().startsWith('{') ? raw : readFile(raw);
  const cfg = JSON.parse(text) as SimConfig;
  if (cfg.occupancyRate !== undefined && (cfg.occupancyRate < 0 || cfg.occupancyRate > 1))
    throw new Error('sim: occupancyRate must be within 0..1');
  return cfg;
}
