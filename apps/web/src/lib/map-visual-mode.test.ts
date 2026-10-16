import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_VISUAL_MODE, isMapVisualMode, isMapVisualV2Enabled, resolveMapVisualMode, withMapVisualMode } from './map-visual-mode';
import type { MapPreferences, MapVisualMode } from '@gmj/shared';

describe('flag visual por mapa (Map.filters JSON)', () => {
  it('sem campo salvo o mapa continua em V1', () => {
    expect(DEFAULT_MAP_VISUAL_MODE).toBe('V1');
    expect(resolveMapVisualMode(undefined)).toBe('V1');
    expect(resolveMapVisualMode(null)).toBe('V1');
    expect(resolveMapVisualMode({})).toBe('V1');
  });

  it('só V2 explícito habilita o novo visual', () => {
    expect(resolveMapVisualMode({ visualMode: 'V2' })).toBe('V2');
    expect(isMapVisualV2Enabled({ visualMode: 'V2' })).toBe(true);
    expect(resolveMapVisualMode({ visualMode: 'V1' })).toBe('V1');
    expect(isMapVisualV2Enabled({ visualMode: 'V1' })).toBe(false);
  });

  it('valor desconhecido (mapa antigo/editado à mão) cai para V1', () => {
    const junk = ['v2', 'V3', '', 2, true, null] as unknown[];
    for (const value of junk) {
      expect(isMapVisualMode(value)).toBe(false);
      expect(resolveMapVisualMode({ visualMode: value as MapVisualMode })).toBe('V1');
      expect(isMapVisualV2Enabled({ visualMode: value as MapVisualMode })).toBe(false);
    }
  });

  it('escrever o modo preserva o restante das preferências e não muta a entrada', () => {
    const original: MapPreferences = {
      showTraffic: true,
      showUtilization: true,
      showLabels: true,
      showOffline: false,
      showInterfaces: false,
      showTrafficAnimation: true,
      visualMode: 'V1',
    };
    const upgraded = withMapVisualMode(original, 'V2');
    expect(upgraded).not.toBe(original);
    expect(original.visualMode).toBe('V1');
    expect(upgraded.visualMode).toBe('V2');
    expect(upgraded.showOffline).toBe(false);
    expect({ ...upgraded, visualMode: 'V1' }).toEqual(original);
  });

  it('sobrevive ao round-trip do JSON usado em Map.filters', () => {
    const stored = JSON.parse(
      JSON.stringify(withMapVisualMode({ showTraffic: true, visualMode: 'V1' as MapVisualMode }, 'V2')),
    ) as MapPreferences;
    expect(resolveMapVisualMode(stored)).toBe('V2');
    const rolledBack = JSON.parse(JSON.stringify(withMapVisualMode(stored, 'V1'))) as MapPreferences;
    expect(resolveMapVisualMode(rolledBack)).toBe('V1');
  });
});
