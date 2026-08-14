import { describe, expect, it } from 'vitest';
import { createDemoHistory, demoMap } from './demo';
import { formatBitsPerSecond } from './format';

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

  it('formats network rates', () => {
    expect(formatBitsPerSecond(31_700_000_000)).toBe('31.7 Gbps');
  });
});
