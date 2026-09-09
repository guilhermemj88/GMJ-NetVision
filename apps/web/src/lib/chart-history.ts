export interface TimestampedChartPoint {
  timestamp: string;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2) return ordered[middle] ?? null;
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

/** Median interval between consecutive samples — the collection's own cadence. */
function typicalInterval<T extends TimestampedChartPoint>(points: T[]): number | null {
  const timestamps = [...new Set(points
    .map((point) => Date.parse(point.timestamp))
    .filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const intervals = timestamps.slice(1).flatMap((timestamp, index) => {
    const previous = timestamps[index];
    if (previous === undefined) return [];
    const interval = timestamp - previous;
    return interval > 0 ? [interval] : [];
  });
  return median(intervals);
}

/**
 * Adds null-valued UI sentinels only to break lines across unexpectedly long
 * collection gaps. The expected cadence is measured from the samples themselves
 * (not the aggregation bucket), so sparse but regular collections (e.g. optical
 * DDM every five minutes) stay connected even when the period bucket is finer.
 */
export function withTemporalGapMarkers<T extends TimestampedChartPoint>(
  points: T[],
  createGap: (timestamp: string) => T,
): T[] {
  if (points.length < 2) return points;
  const interval = typicalInterval(points);
  if (interval === null || interval <= 0) return points;
  const result: T[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    result.push(point);
    const next = points[index + 1];
    if (!next) continue;
    const currentTimestamp = Date.parse(point.timestamp);
    const nextTimestamp = Date.parse(next.timestamp);
    const delta = nextTimestamp - currentTimestamp;
    if (!Number.isFinite(delta) || delta <= 0) continue;
    const missingSamples = Math.max(0, Math.floor(delta / interval) - 1);
    if (missingSamples >= 3) {
      result.push(createGap(new Date(currentTimestamp + interval).toISOString()));
    }
  }
  return result;
}
