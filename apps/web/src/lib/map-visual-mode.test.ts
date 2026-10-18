import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_VISUAL_MODE, isMapVisualMode, isMapVisualV2Enabled, normalizeMapVisualMode, resolveMapVisualMode, withMapVisualMode } from './map-visual-mode';
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

  it('Fase J: aceita os nomes explícitos MAP_VISUAL_V1 / MAP_VISUAL_V2', () => {
    expect(normalizeMapVisualMode('MAP_VISUAL_V1')).toBe('V1');
    expect(normalizeMapVisualMode('MAP_VISUAL_V2')).toBe('V2');
    expect(resolveMapVisualMode({ visualMode: 'MAP_VISUAL_V2' as MapVisualMode })).toBe('V2');
    expect(resolveMapVisualMode({ visualMode: 'MAP_VISUAL_V1' as MapVisualMode })).toBe('V1');
    expect(isMapVisualV2Enabled({ visualMode: 'MAP_VISUAL_V2' as MapVisualMode })).toBe(true);
    // Nomes parecidos porém inválidos continuam caindo para V1 (rollback seguro).
    for (const value of ['MAP_VISUAL', 'MAP_VISUAL_V3', 'map_visual_v2', ' MAP_VISUAL_V2 ']) {
      expect(normalizeMapVisualMode(value)).toBeNull();
      expect(resolveMapVisualMode({ visualMode: value as MapVisualMode })).toBe('V1');
    }
  });

  it('a flag continua sendo lida de Map.filters e preserva os demais filtros', () => {
    const filters = {
      showTraffic: true,
      showUtilization: false,
      showLabels: true,
      showOffline: true,
      showInterfaces: false,
      showTrafficAnimation: false,
      visualMode: 'MAP_VISUAL_V2' as MapVisualMode,
    };
    expect(resolveMapVisualMode(filters)).toBe('V2');
    const rolledBack = withMapVisualMode(filters, 'V1');
    expect(resolveMapVisualMode(rolledBack)).toBe('V1');
    expect({ ...rolledBack, visualMode: 'MAP_VISUAL_V2' }).toEqual(filters);
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
