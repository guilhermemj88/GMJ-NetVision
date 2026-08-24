import { describe, expect, it } from 'vitest';
import { withTemporalGapMarkers } from './chart-history';

describe('withTemporalGapMarkers', () => {
  it('inserts a null sentinel so a chart does not connect across a missing bucket', () => {
    const result = withTemporalGapMarkers<{ timestamp: string; value: number | null }>(
      [
        { timestamp: '2026-08-23T12:00:00.000Z', value: 10 },
        { timestamp: '2026-08-23T12:10:00.000Z', value: 30 },
      ],
      '6h',
      (timestamp) => ({ timestamp, value: null }),
    );

    expect(result).toEqual([
      { timestamp: '2026-08-23T12:00:00.000Z', value: 10 },
      { timestamp: '2026-08-23T12:05:00.000Z', value: null },
      { timestamp: '2026-08-23T12:10:00.000Z', value: 30 },
    ]);
  });

  it('does not add synthetic points when consecutive buckets exist', () => {
    const points: Array<{ timestamp: string; value: number | null }> = [
      { timestamp: '2026-08-23T12:00:00.000Z', value: 10 },
      { timestamp: '2026-08-23T12:05:00.000Z', value: 20 },
    ];
    expect(withTemporalGapMarkers(points, '6h', (timestamp) => ({ timestamp, value: null })))
      .toEqual(points);
  });
});
