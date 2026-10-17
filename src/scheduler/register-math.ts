import type { DriverReading } from '../drivers/types.js';
import type { ReadingQuality } from '../protocol/types.js';
import type { MeterSeqState } from '../queue/reading-queue.js';
import { REGISTER_MAX_MILLI } from '../util/decimal.js';

export interface ProcessedRegister {
  registerMilli: bigint;
  rawMilli: bigint;
  rolloverOffsetMilli: bigint;
  quality: ReadingQuality;
  /** Set when the register went down without a detectable rollover — still sent; the cloud decides. */
  decrease?: { previousMilli: bigint; currentMilli: bigint };
}

/**
 * Register maths before enqueue (D-030): rollover detection with a persisted offset
 * (`overflow_corrected`), monotonic sanity (a decrease is sent unchanged with `register_decrease`, never
 * dropped — CR-007; the cloud routes it to the owner review queue) and quality precedence
 * register_decrease > estimated_by_gateway > overflow_corrected > clock_suspect > good.
 */
export function processRegister(
  dr: DriverReading,
  st: Pick<MeterSeqState, 'lastRawMilli' | 'rolloverOffsetMilli' | 'lastRegisterMilli'>,
  flags: { clockSuspect: boolean },
): ProcessedRegister {
  const raw = dr.registerMilli;
  let offset = st.rolloverOffsetMilli;
  let overflow = false;
  if (dr.rolloverAtMilli && st.lastRawMilli !== null && raw < st.lastRawMilli) {
    const drop = st.lastRawMilli - raw;
    // A wrap shows as a large drop from near the top to near zero; small drops are real decreases.
    if (drop > dr.rolloverAtMilli / 2n) {
      offset += dr.rolloverAtMilli;
      overflow = true;
    }
  }
  let reg = raw + offset;
  if (reg > REGISTER_MAX_MILLI) {
    reg = reg % (REGISTER_MAX_MILLI + 1n);
    overflow = true;
  }
  const decreased = st.lastRegisterMilli !== null && reg < st.lastRegisterMilli && !overflow;
  const quality: ReadingQuality = decreased
    ? 'register_decrease'
    : dr.estimated
      ? 'estimated_by_gateway'
      : overflow
        ? 'overflow_corrected'
        : flags.clockSuspect
          ? 'clock_suspect'
          : 'good';
  const out: ProcessedRegister = { registerMilli: reg, rawMilli: raw, rolloverOffsetMilli: offset, quality };
  if (decreased) out.decrease = { previousMilli: st.lastRegisterMilli!, currentMilli: reg };
  return out;
}
