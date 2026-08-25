import { historyBucketMilliseconds, type HistoryPeriod } from '@gmj/shared';

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

function expectedInterval<T extends TimestampedChartPoint>(points: T[], period: HistoryPeriod): number {
  const bucket = historyBucketMilliseconds(period);
  if (bucket !== null) return bucket;
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
  return Math.min(median(intervals) ?? 60_000, 60_000);
}

/** Adds null-valued UI sentinels only to break lines across missing time buckets. */
export function withTemporalGapMarkers<T extends TimestampedChartPoint>(
  points: T[],
  period: HistoryPeriod,
  createGap: (timestamp: string) => T,
): T[] {
  if (points.length < 2) return points;
  const interval = expectedInterval(points, period);
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
    if (!Number.isFinite(delta) || delta <= 0 || interval <= 0) continue;
    const missingBuckets = Math.max(0, Math.floor(delta / interval) - 1);
    if (missingBuckets >= 3) {
      result.push(createGap(new Date(currentTimestamp + interval).toISOString()));
    }
  }
  return result;
}
