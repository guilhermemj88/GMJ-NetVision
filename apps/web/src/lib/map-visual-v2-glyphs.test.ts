import { describe, expect, it } from 'vitest';
import {
  MAP_GLYPH_BASE_SIZE,
  MAP_GLYPH_COMPACT_MAX_PX,
  isMapGlyphCompact,
  mapGlyphEffectiveSize,
  resolveMapDeviceGlyphV2,
} from './map-visual-v2-glyphs';
import { resolveDeviceGlyphV2 } from '@/components/network-device-glyphs-v2';

describe('glifos do V2 no mapa real', () => {
  it('usa o desenho novo de dois chassis no CORE_SWITCH', () => {
    expect(resolveMapDeviceGlyphV2('CORE_SWITCH')).toBe('CORE_SWITCH');
  });

  it('mantém a equivalência do laboratório para os demais tipos', () => {
    for (const type of [
      'CORE_ROUTER',
      'EDGE_ROUTER',
      'ROUTER',
      'SWITCH',
      'AGGREGATION',
      'OLT',
      'CLOUD',
      'IX',
      'BNG',
    ]) {
      expect(resolveMapDeviceGlyphV2(type)).toBe(resolveDeviceGlyphV2(type));
    }
  });

  it('tipos sem glifo V2 caem no desenho V1 (nada de glifo inventado)', () => {
    for (const type of ['CARRIER', 'PEER', 'GENERIC', 'DATACENTER', 'CUSTOMERS', 'TRANSPORT']) {
      expect(resolveMapDeviceGlyphV2(type)).toBeNull();
    }
  });

  it('não altera o mapa provisório do laboratório', () => {
    expect(resolveDeviceGlyphV2('CORE_SWITCH')).toBe('SWITCH');
  });
});

describe('tamanho e variante compacta do glifo', () => {
  it('o nó é escalado por --node-scale', () => {
    expect(mapGlyphEffectiveSize(100)).toBe(MAP_GLYPH_BASE_SIZE);
    expect(mapGlyphEffectiveSize(75)).toBe(24);
    expect(mapGlyphEffectiveSize(150)).toBe(48);
    expect(mapGlyphEffectiveSize(Number.NaN)).toBe(MAP_GLYPH_BASE_SIZE);
  });

  it('BNG é compacta em 24 px ou menos e normal acima disso', () => {
    expect(MAP_GLYPH_COMPACT_MAX_PX).toBe(24);
    expect(isMapGlyphCompact('BNG', mapGlyphEffectiveSize(75))).toBe(true);
    expect(isMapGlyphCompact('BNG', mapGlyphEffectiveSize(50))).toBe(true);
    expect(isMapGlyphCompact('BNG', mapGlyphEffectiveSize(100))).toBe(false);
    expect(isMapGlyphCompact('BNG', mapGlyphEffectiveSize(150))).toBe(false);
  });

  it('a variante compacta é opt-in, só do BNG', () => {
    for (const type of ['SWITCH', 'CORE_SWITCH', 'OLT', 'AGGREGATION'] as const) {
      expect(isMapGlyphCompact(type, 16)).toBe(false);
    }
  });
});
