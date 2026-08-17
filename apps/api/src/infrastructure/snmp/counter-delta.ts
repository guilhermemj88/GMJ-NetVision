const COUNTER_32_MAX = 0xffff_ffffn;
const WRAP_HIGH_WATERMARK = (COUNTER_32_MAX * 3n) / 4n;
const WRAP_LOW_WATERMARK = COUNTER_32_MAX / 4n;

/**
 * Calculates events observed during one interval from an SNMP Counter32.
 * A missing previous sample establishes the baseline. A plausible wrap is
 * distinguished from a reset so neither case can produce a negative delta.
 */
export function calculateCounterDelta(
  current: bigint,
  previous: bigint | undefined,
): bigint {
  if (previous === undefined) return 0n;
  if (current >= previous) return current - previous;
  if (previous >= WRAP_HIGH_WATERMARK && current <= WRAP_LOW_WATERMARK) {
    return (COUNTER_32_MAX - previous) + 1n + current;
  }
  return current;
}
