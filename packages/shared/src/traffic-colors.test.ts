import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAFFIC_COLOR_A_TO_B,
  DEFAULT_TRAFFIC_COLOR_B_TO_A,
  matchTrafficColorPreset,
  TRAFFIC_COLOR_PRESETS,
} from './traffic-colors';

describe('traffic color presets', () => {
  it('exposes the default cyan/purple identity', () => {
    expect(DEFAULT_TRAFFIC_COLOR_A_TO_B).toBe('#40c8e8');
    expect(DEFAULT_TRAFFIC_COLOR_B_TO_A).toBe('#9575f0');
  });

  it('lists five presets with valid, distinct hex colors', () => {
    expect(TRAFFIC_COLOR_PRESETS).toHaveLength(5);
    for (const preset of TRAFFIC_COLOR_PRESETS) {
      expect(preset.aToB).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(preset.bToA).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(preset.aToB).not.toBe(preset.bToA);
    }
  });

  it('matches null/null to the DEFAULT palette', () => {
    expect(matchTrafficColorPreset(null, null)).toBe('DEFAULT');
  });

  it('matches a stored preset pair', () => {
    const preset = TRAFFIC_COLOR_PRESETS.find((item) => item.id === 'BLUE_ORANGE')!;
    expect(matchTrafficColorPreset(preset.aToB, preset.bToA)).toBe('BLUE_ORANGE');
  });

  it('falls back to CUSTOM for an unknown pair', () => {
    expect(matchTrafficColorPreset('#123456', '#654321')).toBe('CUSTOM');
  });
});
