import type { HistoryPeriod, MetricPoint } from './types';

const HISTORY_BUCKET_MILLISECONDS: Record<HistoryPeriod, number | null> = {
  '15m': null,
  '1h': 60_000,
  '6h': 5 * 60_000,
  '24h': 15 * 60_000,
  '7d': 60 * 60_000,
};

export function historyBucketMilliseconds(period: HistoryPeriod): number | null {
  return HISTORY_BUCKET_MILLISECONDS[period];
}

/**
 * Reduces historical samples without filling empty buckets. Traffic is averaged
 * for the main series and its maximum is retained separately; interval error and
 * discard deltas are summed. Bucket timestamps always identify the bucket start.
 */
export function aggregateMetricHistory(
  points: MetricPoint[],
  period: HistoryPeriod,
): MetricPoint[] {
  const bucketMilliseconds = historyBucketMilliseconds(period);

  type Bucket = {
    timestamp: number;
    count: number;
    rxBps: number;
    txBps: number;
    rxBpsMax: number;
    txBpsMax: number;
    rxErrors: number;
    txErrors: number;
    rxDiscards: number;
    txDiscards: number;
  };

  const buckets = new Map<number, Bucket>();
  const ordered = [...points].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );

  for (const point of ordered) {
    const pointTimestamp = Date.parse(point.timestamp);
    if (!Number.isFinite(pointTimestamp)) continue;
    const timestamp = bucketMilliseconds === null
      ? pointTimestamp
      : Math.floor(pointTimestamp / bucketMilliseconds) * bucketMilliseconds;
    const bucket = buckets.get(timestamp) ?? {
      timestamp,
      count: 0,
      rxBps: 0,
      txBps: 0,
      rxBpsMax: 0,
      txBpsMax: 0,
      rxErrors: 0,
      txErrors: 0,
      rxDiscards: 0,
      txDiscards: 0,
    };
    const sampleCount = point.sampleCount ?? 1;
    bucket.count += sampleCount;
    bucket.rxBps += point.rxBps * sampleCount;
    bucket.txBps += point.txBps * sampleCount;
    bucket.rxBpsMax = Math.max(bucket.rxBpsMax, point.rxBpsMax ?? point.rxBps);
    bucket.txBpsMax = Math.max(bucket.txBpsMax, point.txBpsMax ?? point.txBps);
    bucket.rxErrors += point.rxErrors;
    bucket.txErrors += point.txErrors;
    bucket.rxDiscards += point.rxDiscards;
    bucket.txDiscards += point.txDiscards;
    buckets.set(timestamp, bucket);
  }

  return [...buckets.values()].map((bucket) => ({
    timestamp: new Date(bucket.timestamp).toISOString(),
    rxBps: bucket.rxBps / bucket.count,
    txBps: bucket.txBps / bucket.count,
    rxBpsMax: bucket.rxBpsMax,
    txBpsMax: bucket.txBpsMax,
    sampleCount: bucket.count,
    rxErrors: bucket.rxErrors,
    txErrors: bucket.txErrors,
    rxDiscards: bucket.rxDiscards,
    txDiscards: bucket.txDiscards,
  }));
}
