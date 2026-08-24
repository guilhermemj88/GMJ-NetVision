import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpticalHistoryPoint } from '@gmj/shared';
import {
  OpticalHistoryTooltip,
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
});
