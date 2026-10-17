import type { MeterConfig, MeterHealthStatus, MeterUnit } from '../protocol/types.js';

/** Raw result of one meter read, before register maths (rollover, scale, sanity) in the scheduler. */
export interface DriverReading {
  /** Cumulative register in milli-units (kWh·10⁻³ or litres for m³) after the driver/map scaling. */
  registerMilli: bigint;
  unit: MeterUnit;
  /** Instant values (voltage, current, powerW…) — informational, never billed. */
  extra?: Record<string, number>;
  /** Register wraps to 0 after this value (milli); enables `overflow_corrected`. */
  rolloverAtMilli?: bigint;
  /** The register is maintained by the gateway and may have lost counts (pulse meter after power loss). */
  estimated?: boolean;
}

export type ReadFailure = Exclude<MeterHealthStatus, 'ok'>;

export class MeterReadError extends Error {
  constructor(
    readonly status: ReadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'MeterReadError';
  }
}

/**
 * A meter model or meter family (D-013). New hardware = a new driver (or a JSON register map for a
 * Modbus model), never a protocol change.
 */
export interface MeterDriver {
  readonly name: string;
  read(meter: MeterConfig): Promise<DriverReading>;
  /** Cheap presence check used by the config dry-run. */
  probe?(meter: MeterConfig): Promise<void>;
  close?(): Promise<void>;
}
