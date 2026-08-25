import { describe, expect, it } from 'vitest';
import { withTemporalGapMarkers } from './chart-history';

describe('withTemporalGapMarkers', () => {
  type Point = { timestamp: string; value: number | null };
  const point = (timestamp: string, value: number | null = 1): Point => ({ timestamp, value });
  const gaps = (points: Point[], period: '15m' | '1h' | '6h'): Point[] =>
    withTemporalGapMarkers(points, period, (timestamp) => point(timestamp, null));

  it.each([
    ['2026-08-23T00:03:00.000Z', 0],
    ['2026-08-23T00:04:00.000Z', 0],
    ['2026-08-23T00:05:00.000Z', 1],
  ])('tolerates up to two missing one-minute buckets before %s', (last, markerCount) => {
    const result = gaps([
      point('2026-08-23T00:00:00.000Z'),
      point('2026-08-23T00:01:00.000Z'),
      point(last),
    ], '1h');
    expect(result.filter((item) => item.value === null)).toHaveLength(markerCount);
  });

  it.each([
    ['2026-08-23T10:15:00.000Z', 0],
    ['2026-08-23T10:20:00.000Z', 0],
    ['2026-08-23T10:25:00.000Z', 1],
  ])('tolerates up to two missing five-minute buckets before %s', (last, markerCount) => {
    const result = gaps([
      point('2026-08-23T10:00:00.000Z'),
      point('2026-08-23T10:05:00.000Z'),
      point(last),
    ], '6h');
    expect(result.filter((item) => item.value === null)).toHaveLength(markerCount);
  });

  it.each([
    ['2026-08-23T10:03:00.000Z', 0],
    ['2026-08-23T10:04:00.000Z', 0],
    ['2026-08-23T10:05:00.000Z', 1],
  ])('uses the median raw interval before %s', (last, markerCount) => {
    const result = gaps([
      point('2026-08-23T10:00:00.000Z'),
      point('2026-08-23T10:01:00.000Z'),
      point(last),
    ], '15m');
    expect(result.filter((item) => item.value === null)).toHaveLength(markerCount);
  });

  it('does not insert unstable markers for invalid, duplicate or out-of-order timestamps', () => {
    const points = [
      point('2026-08-23T10:01:00.000Z'),
      point('invalid'),
      point('2026-08-23T10:01:00.000Z'),
      point('2026-08-23T10:00:00.000Z'),
    ];
    expect(gaps(points, '15m')).toEqual(points);
  });
});
