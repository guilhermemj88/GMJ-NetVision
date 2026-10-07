const COUNTER_32_MAX = 0xffff_ffffn;
const COUNTER_64_MAX = 0xffff_ffff_ffff_ffffn;
const WRAP_HIGH_WATERMARK = (COUNTER_32_MAX * 3n) / 4n;
const WRAP_LOW_WATERMARK = COUNTER_32_MAX / 4n;

/**
 * Calculates events observed during one interval from an SNMP counter of the
 * given width (`max`). A missing previous sample establishes the baseline. A
 * plausible wrap is distinguished from a reset so neither case can produce a
 * negative delta.
 */
function calculateDeltaForWidth(current: bigint, previous: bigint, max: bigint): bigint {
  if (current >= previous) return current - previous;
  const highWatermark = (max * 3n) / 4n;
  const lowWatermark = max / 4n;
  if (previous >= highWatermark && current <= lowWatermark) {
    return (max - previous) + 1n + current;
  }
  return current;
}

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
  return calculateDeltaForWidth(current, previous, COUNTER_32_MAX);
}

/** Counter64 (HC): wrap praticamente impossivel; a regra permanece por simetria. */
export function calculateCounterDelta64(current: bigint, previous: bigint | undefined): bigint {
  if (previous === undefined) return 0n;
  return calculateDeltaForWidth(current, previous, COUNTER_64_MAX);
}

/**
 * Contador cuja largura nao e conhecida em tempo de leitura (ex.: FCS via
 * dot3HCStatsFCSErrors ou o fallback dot3StatsFCSErrors): aplica a regra de
 * 32 bits quando ambos os lados cabem nela; 64 bits caso contrario.
 */
export function calculateCounterDeltaAuto(current: bigint, previous: bigint): bigint {
  return current <= COUNTER_32_MAX && previous <= COUNTER_32_MAX
    ? calculateDeltaForWidth(current, previous, COUNTER_32_MAX)
    : calculateDeltaForWidth(current, previous, COUNTER_64_MAX);
}

/** Wrap plausivel de um contador de 32 bits (usado tambem pelo motor de alarmes). */
export function isPlausibleCounter32Wrap(previous: bigint, current: bigint): boolean {
  return previous >= WRAP_HIGH_WATERMARK && current <= WRAP_LOW_WATERMARK;
}

/**
 * Delta de FCS/CRC preservando a semantica de "nao coletado" (`null`).
 * Primeira amostra/sem baseline vira 0n, igual aos demais contadores.
 */
export function calculateFcsErrorsDelta(
  current: bigint | null,
  previous: bigint | null | undefined,
): bigint | null {
  if (current === null) return null;
  if (previous === null || previous === undefined) return 0n;
  return calculateCounterDeltaAuto(current, previous);
}
