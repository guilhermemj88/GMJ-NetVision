import { describe, expect, it } from 'vitest';
import { createDemoHistory, demoMap, demoMaps } from './demo';
import { calculateUtilization, formatBitsPerSecond, utilizationLevel } from './format';

describe('demo domain', () => {
  it('contains a connected ISP topology', () => {
    expect(demoMap.devices.length).toBeGreaterThanOrEqual(10);
    expect(demoMap.links.length).toBeGreaterThan(demoMap.devices.length);
    expect(
      demoMap.nodes.every((node) => demoMap.devices.some((device) => device.id === node.deviceId)),
    ).toBe(true);
  });

  it('creates smooth deterministic history', () => {
    const first = createDemoHistory('core-01-if-1', '1h');
    const second = createDemoHistory('core-01-if-1', '1h');
    expect(first).toEqual(second);
    expect(first).toHaveLength(60);
    expect(Math.abs((first[1]?.txBps ?? 0) - (first[0]?.txBps ?? 0))).toBeLessThan(1_000_000_000);
  });

  it('provides independent map views over the global inventory', () => {
    expect(demoMaps).toHaveLength(3);
    expect(demoMaps.filter((map) => map.isDefault)).toHaveLength(1);
    expect(demoMaps.every((map) => map.devices.length === demoMap.devices.length)).toBe(true);
    expect(demoMaps[1]?.nodes.length).toBeLessThan(demoMap.nodes.length);
  });

  it('keeps canonical full-duplex directions and classifies threshold boundaries', () => {
    const link = demoMap.links[0]!;
    expect(link.directions.A_TO_B.bps).toBe(link.txBps);
    expect(link.directions.B_TO_A.bps).toBe(link.rxBps);
    expect(calculateUtilization(1_100, 1_000)).toBeCloseTo(110);
    expect([39.99, 40, 70, 90, 100, 100.01].map((value) => utilizationLevel(value))).toEqual([
      'NORMAL',
      'ATTENTION',
      'HIGH',
      'CRITICAL',
      'CRITICAL',
      'INCONSISTENT',
    ]);
    expect(utilizationLevel(55, { attention: 60, high: 80, critical: 95, maximum: 100 })).toBe(
      'NORMAL',
    );
  });

  it('formats network rates', () => {
    expect(formatBitsPerSecond(31_700_000_000)).toBe('31.7 Gbps');
  });
});
