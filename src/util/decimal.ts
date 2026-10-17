/**
 * Registers are handled as integer milli-units (bigint) so kWh / m³ never pass through float arithmetic
 * after the driver. The wire format is the protocol decimal string `^\d{1,9}(\.\d{1,3})?$`.
 */
export const REGISTER_MAX_MILLI = 999_999_999_999n;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

export function parseDecimal(value: string, places: number): bigint {
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) throw new Error(`not a non-negative decimal: ${value}`);
  const int = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > places) throw new Error(`more than ${places} decimals: ${value}`);
  return BigInt(int) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, '0') || '0');
}

export const parseMilli = (value: string): bigint => parseDecimal(value, 3);

export function formatMilli(milli: bigint): string {
  if (milli < 0n) throw new Error('negative register');
  const int = milli / 1000n;
  const frac = milli % 1000n;
  return `${int}.${frac.toString().padStart(3, '0')}`;
}

/** Rounds a driver float (e.g. IEEE-754 float32 kWh) to milli-units, half away from zero. */
export function milliFromNumber(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error(`non-finite register: ${value}`);
  if (value < 0) throw new Error(`negative register: ${value}`);
  // Float32 values carry ~7 significant digits; toFixed(3) rounds the binary value half-up.
  return parseMilli(value.toFixed(3));
}

/** Multiplies milli-units by a decimal scale string (≤ 6 decimals), rounding half-up. */
export function applyScale(milli: bigint, scale: string): bigint {
  const s = parseDecimal(scale, 6);
  const scaled = milli * s;
  return (scaled + 500_000n) / 1_000_000n;
}

export function isRegisterString(value: string): boolean {
  return /^\d{1,9}(\.\d{1,3})?$/.test(value);
}
