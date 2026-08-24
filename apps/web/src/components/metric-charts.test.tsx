import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  TRAFFIC_CURVE_TYPE,
  TRAFFIC_PEAK_HAS_LINE,
  TRAFFIC_PEAK_RENDERING,
  TrafficHistoryTooltip,
  trafficPeakValue,
} from './metric-charts';

describe('traffic history rendering', () => {
  it('uses step-after averages and isolated peak markers without a peak line', () => {
    expect(TRAFFIC_CURVE_TYPE).toBe('stepAfter');
    expect(TRAFFIC_PEAK_RENDERING).toBe('SCATTER');
    expect(TRAFFIC_PEAK_HAS_LINE).toBe(false);
    expect(trafficPeakValue(10, 25)).toBe(25);
    expect(trafficPeakValue(10, 10)).toBeNull();
  });

  it('shows average, maximum and sample count in the tooltip', () => {
    const html = renderToStaticMarkup(
      <TrafficHistoryTooltip
        active
        payload={[{ payload: {
          timestamp: '2026-08-23T12:00:00.000Z',
          sampleCount: 3,
          rxBps: 10,
          txBps: 20,
          rxBpsMax: 30,
          txBpsMax: 40,
        } }]}
      />,
    );
    expect(html).toContain('RX média');
    expect(html).toContain('RX máximo');
    expect(html).toContain('TX média');
    expect(html).toContain('TX máximo');
    expect(html).toContain('3 amostras no bucket');
  });
});
