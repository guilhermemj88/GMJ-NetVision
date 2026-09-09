import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpticalHistoryPoint } from '@gmj/shared';
import {
  OpticalHistoryTooltip,
  formatAxisDbm,
  laneIdsWithPower,
  opticalChartData,
  opticalSeries,
} from './optical-history-charts';

const point: OpticalHistoryPoint = {
  timestamp: '2026-08-23T12:00:00.000Z',
  sampleCount: 2,
  rxAvg: -12,
  rxMin: -13,
  rxMax: -11,
  txAvg: 0.2,
  txMin: 0.1,
  txMax: 0.3,
  lanes: [0, 1, 2, 3].map((lane) => ({
    lane,
    sampleCount: 2,
    rxAvg: -12 + lane,
    rxMin: -13 + lane,
    rxMax: -11 + lane,
    txAvg: 0.2 + lane,
    txMin: 0.1 + lane,
    txMax: 0.3 + lane,
  })),
};

describe('optical history rendering', () => {
  it('uses one scalar series for single-lane optics', () => {
    expect(opticalSeries([], 'rx')).toEqual([
      { dataKey: 'rxAvg', name: 'RX', stroke: '#43d6b5' },
    ]);
  });

  it('uses one independent RX and TX series per optical lane', () => {
    expect(opticalSeries([0, 1, 2, 3], 'rx').map((series) => series.dataKey)).toEqual([
      'lane_0_rxAvg', 'lane_1_rxAvg', 'lane_2_rxAvg', 'lane_3_rxAvg',
    ]);
    expect(opticalSeries([0, 1, 2, 3], 'tx').map((series) => series.dataKey)).toEqual([
      'lane_0_txAvg', 'lane_1_txAvg', 'lane_2_txAvg', 'lane_3_txAvg',
    ]);
  });

  it('maps four-lane history and exposes lane average, min and max in the tooltip', () => {
    const data = opticalChartData([point], [0, 1, 2, 3], '1h');
    expect(data[0]).toMatchObject({
      lane_0_rxAvg: -12,
      lane_3_rxAvg: -9,
      lane_0_txAvg: 0.2,
      lane_3_txAvg: 3.2,
    });
    const html = renderToStaticMarkup(
      <OpticalHistoryTooltip
        active
        direction="rx"
        laneIds={[0, 1, 2, 3]}
        payload={[{ payload: data[0]! }]}
      />,
    );
    expect(html).toContain('Lane 0 · média');
    expect(html).toContain('· mín');
    expect(html).toContain('· máx');
    expect(html).toContain('2 amostras no bucket');
  });

  it('generates four-lane series for 15m, 1h and 6h without dropping valid lanes', () => {
    for (const period of ['15m', '1h', '6h'] as const) {
      const data = opticalChartData([point], [0, 1, 2, 3], period);
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        lane_0_rxAvg: -12,
        lane_1_rxAvg: -11,
        lane_2_rxAvg: -10,
        lane_3_rxAvg: -9,
      });
    }
  });

  it('breaks lane series only across unexpectedly long collection gaps', () => {
    const at = (timestamp: string): OpticalHistoryPoint => ({ ...point, timestamp });
    const continuous = opticalChartData([
      at('2026-08-23T12:00:00.000Z'),
      at('2026-08-23T12:05:00.000Z'),
      at('2026-08-23T12:10:00.000Z'),
      at('2026-08-23T12:15:00.000Z'),
    ], [0, 1, 2, 3], '1h');
    const broken = opticalChartData([
      at('2026-08-23T12:00:00.000Z'),
      at('2026-08-23T12:05:00.000Z'),
      at('2026-08-23T12:10:00.000Z'),
      at('2026-08-23T12:30:00.000Z'),
    ], [0, 1, 2, 3], '1h');

    expect(continuous.every((item) => item.source !== null)).toBe(true);
    expect(broken.filter((item) => item.source === null)).toHaveLength(1);
    expect(broken.find((item) => item.source === null)).toMatchObject({
      lane_0_rxAvg: null,
      lane_3_txAvg: null,
    });
  });

  it('excludes bias-only lanes from power series and falls back to scalar when needed', () => {
    const biasOnly: OpticalHistoryPoint = {
      timestamp: '2026-08-23T12:00:00.000Z',
      sampleCount: 1,
      rxAvg: -4.2,
      rxMin: -4.2,
      rxMax: -4.2,
      txAvg: -3.01,
      txMin: -3.01,
      txMax: -3.01,
      lanes: [{ lane: 0, sampleCount: 1, rxAvg: null, rxMin: null, rxMax: null, txAvg: null, txMin: null, txMax: null }],
    };

    expect(laneIdsWithPower([biasOnly], [0], 'rx')).toEqual([]);
    expect(laneIdsWithPower([biasOnly], [0], 'tx')).toEqual([]);
    expect(opticalSeries([], 'rx')).toEqual([
      { dataKey: 'rxAvg', name: 'RX', stroke: '#43d6b5' },
    ]);
    expect(opticalSeries([], 'tx')).toEqual([
      { dataKey: 'txAvg', name: 'TX', stroke: '#44a8e8' },
    ]);
  });

  it('selects RX lanes independently of TX lanes', () => {
    const mixed: OpticalHistoryPoint = {
      timestamp: '2026-08-23T12:00:00.000Z',
      sampleCount: 1,
      rxAvg: -4.2,
      rxMin: -4.2,
      rxMax: -4.2,
      txAvg: -3.01,
      txMin: -3.01,
      txMax: -3.01,
      lanes: [
        { lane: 0, sampleCount: 1, rxAvg: -3.7, rxMin: -3.7, rxMax: -3.7, txAvg: null, txMin: null, txMax: null },
        { lane: 1, sampleCount: 1, rxAvg: null, rxMin: null, rxMax: null, txAvg: 0.6, txMin: 0.6, txMax: 0.6 },
      ],
    };

    expect(laneIdsWithPower([mixed], [0, 1], 'rx')).toEqual([0]);
    expect(laneIdsWithPower([mixed], [0, 1], 'tx')).toEqual([1]);
  });

  it('formats the Y-axis with two decimals and no dBm suffix', () => {
    expect(formatAxisDbm(1.37)).toBe('1.37');
    expect(formatAxisDbm(1.1)).toBe('1.10');
    expect(formatAxisDbm(-4.2)).toBe('-4.20');
    expect(formatAxisDbm(0)).toBe('0.00');
  });
});
