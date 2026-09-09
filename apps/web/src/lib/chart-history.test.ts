import { describe, expect, it } from 'vitest';
import { withTemporalGapMarkers } from './chart-history';

describe('withTemporalGapMarkers', () => {
  type Point = { timestamp: string; value: number | null };
  const point = (timestamp: string, value: number | null = 1): Point => ({ timestamp, value });
  const gaps = (points: Point[]): Point[] =>
    withTemporalGapMarkers(points, (timestamp) => point(timestamp, null));
  const minutes = (offsets: number[]): Point[] => offsets.map((offset) =>
    point(new Date(Date.UTC(2026, 7, 23, 12, offset, 0)).toISOString()),
  );

  it('keeps dense one-minute samples connected', () => {
    expect(gaps(minutes([0, 1, 2, 3, 4])).filter((item) => item.value === null))
      .toHaveLength(0);
  });

  it.each([
    [[0, 1, 2, 3, 4, 6], 0],
    [[0, 1, 2, 3, 4, 7], 0],
    [[0, 1, 2, 3, 4, 8], 1],
  ])('tolerates up to two missing one-minute samples before breaking (%j)', (offsets, markers) => {
    const result = gaps(minutes(offsets));
    expect(result.filter((item) => item.value === null)).toHaveLength(markers);
  });

  it('keeps sparse but regular five-minute optical samples connected', () => {
    expect(gaps(minutes([0, 5, 10, 15, 20])).filter((item) => item.value === null))
      .toHaveLength(0);
  });

  it('breaks across a long gap after regular five-minute optical samples', () => {
    expect(gaps(minutes([0, 5, 10, 30])).filter((item) => item.value === null))
      .toHaveLength(1);
  });

  it('does not insert unstable markers for invalid, duplicate or out-of-order timestamps', () => {
    const points = [
      point('2026-08-23T10:01:00.000Z'),
      point('invalid'),
      point('2026-08-23T10:01:00.000Z'),
      point('2026-08-23T10:00:00.000Z'),
    ];
    expect(gaps(points)).toEqual(points);
  });
});
