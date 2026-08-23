import { describe, expect, it } from 'vitest';
import { aggregateMetricHistory, historyBucketMilliseconds } from './history';
import type { MetricPoint } from './types';

function point(timestamp: string, value: number, deltas = value): MetricPoint {
  return {
    timestamp,
    rxBps: value,
    txBps: value * 2,
    rxErrors: deltas,
    txErrors: deltas + 1,
    rxDiscards: deltas + 2,
    txDiscards: deltas + 3,
  };
}

describe('historical metric aggregation', () => {
  it('aggregates 1h history into one-minute buckets with average and max traffic', () => {
    const result = aggregateMetricHistory([
      point('2026-08-23T12:00:05.000Z', 10),
      point('2026-08-23T12:00:45.000Z', 30),
      point('2026-08-23T12:01:05.000Z', 50),
    ], '1h');

    expect(historyBucketMilliseconds('1h')).toBe(60_000);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      timestamp: '2026-08-23T12:00:00.000Z',
      rxBps: 20,
      txBps: 40,
      rxBpsMax: 30,
      txBpsMax: 60,
    });
    expect(result[1]?.timestamp).toBe('2026-08-23T12:01:00.000Z');
  });

  it('aggregates 6h history into five-minute buckets without filling gaps', () => {
    const result = aggregateMetricHistory([
      point('2026-08-23T10:01:00.000Z', 10),
      point('2026-08-23T10:04:59.000Z', 20),
      point('2026-08-23T10:11:00.000Z', 30),
    ], '6h');

    expect(historyBucketMilliseconds('6h')).toBe(5 * 60_000);
    expect(result.map((item) => item.timestamp)).toEqual([
      '2026-08-23T10:00:00.000Z',
      '2026-08-23T10:10:00.000Z',
    ]);
    expect(result[0]?.rxBps).toBe(15);
  });

  it('sums error and discard deltas inside each bucket', () => {
    const result = aggregateMetricHistory([
      point('2026-08-23T12:00:05.000Z', 10, 1),
      point('2026-08-23T12:00:45.000Z', 20, 4),
    ], '1h');

    expect(result[0]).toMatchObject({
      rxErrors: 5,
      txErrors: 7,
      rxDiscards: 9,
      txDiscards: 11,
    });
  });

  it('keeps 15m samples raw with their original timestamps', () => {
    const input = [point('2026-08-23T12:00:05.123Z', 10)];
    expect(aggregateMetricHistory(input, '15m')).toEqual(input);
  });
});
