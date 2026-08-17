export const MIN_OPTICAL_DBM = -60;
export const MAX_OPTICAL_DBM = 20;

export function normalizeOpticalDbm(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric) || numeric < MIN_OPTICAL_DBM || numeric > MAX_OPTICAL_DBM) {
    return null;
  }
  return Math.round(numeric * 100) / 100;
}

export function microWattsToDbm(value: unknown): number | null {
  const microWatts = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(microWatts) || microWatts <= 0) return null;
  return normalizeOpticalDbm(10 * Math.log10(microWatts / 1000));
}
