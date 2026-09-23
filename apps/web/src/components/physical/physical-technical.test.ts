import { describe, expect, it } from 'vitest';
import { modularChassisMap } from './modular-chassis-map';
import {
  TECHNICAL_RENDER_CATALOG_KEYS,
  assetUsesTechnicalRenderer,
  hasTechnicalRenderer,
  portFamilyPrefix,
  portOrdinalLabel,
  technicalChassisDisplayHeight,
  technicalChassisMap,
  technicalPanelCaptions,
} from './physical-technical';

/**
 * Núcleo da visão técnica: quais modelos têm desenho técnico nesta fase e como
 * o renderer deriva legendas/altura — sempre a partir do que já existe
 * (catálogo + mapa do chassi), sem estrutura paralela.
 */
describe('physical technical rendering', () => {
  it('declara exatamente os modelos desta fase', () => {
    expect([...TECHNICAL_RENDER_CATALOG_KEYS].sort()).toEqual(
      [
        'huawei-ma5800-x7',
        'huawei-ne8000-f1a-8h20q',
        'huawei-s6730-h48x6c',
        'huawei-s6730-h48x6c-v2',
        'huawei-s6750-h48x8c',
        'huawei-s6750-h48y8c',
        'huawei-s6750-h48y8c-b',
      ].sort(),
    );
  });

  it('resolve o renderer por catálogo e modo', () => {
    expect(hasTechnicalRenderer('huawei-ne8000-f1a-8h20q')).toBe(true);
    expect(hasTechnicalRenderer('huawei-s6730-h48x6c')).toBe(true);
    expect(hasTechnicalRenderer('huawei-s6750-h48x8c')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ma5800-x7')).toBe(true);
    // fora do escopo da primeira fase
    expect(hasTechnicalRenderer('huawei-s6730-h24x6c')).toBe(false);
    expect(hasTechnicalRenderer('mikrotik-crs328-24p-4splus-rm')).toBe(false);
    expect(hasTechnicalRenderer(null)).toBe(false);

    // o modo real nunca troca o desenho
    expect(assetUsesTechnicalRenderer('huawei-s6730-h48x6c', 'REAL')).toBe(false);
    expect(assetUsesTechnicalRenderer('huawei-s6730-h48x6c', 'TECHNICAL')).toBe(true);
    expect(assetUsesTechnicalRenderer('huawei-s6730-h24x6c', 'TECHNICAL')).toBe(false);
  });

  it('deriva o chassi técnico do mesmo mapa, sem a fotografia', () => {
    const x7 = modularChassisMap('huawei-ma5800-x7')!;
    const technical = technicalChassisMap(x7);
    expect(technical.image).toBeUndefined();
    expect(technical.slots).toEqual(x7.slots);
    expect(technical.catalogKey).toBe('huawei-ma5800-x7');
  });

  it('espaça os slots do chassi técnico respeitando a ocupação física', () => {
    // X7: 6 slots, 6U, teto de 560px → 46 + 6×64 = 430px (acima das 6U físicas)
    expect(
      technicalChassisDisplayHeight({
        slotCount: 6,
        heightU: 6,
        baseUnitHeight: 30,
        chromePx: 46,
        maxHeightPx: 560,
      }),
    ).toBe(430);
    // chassi de 1 slot nunca fica menor que a altura física
    expect(
      technicalChassisDisplayHeight({
        slotCount: 1,
        heightU: 6,
        baseUnitHeight: 30,
        chromePx: 46,
        maxHeightPx: 560,
      }),
    ).toBe(180);
  });

  it('gera legendas de grupo a partir dos nomes declarados', () => {
    const captions = technicalPanelCaptions({
      connectors: [
        connector('10GE-1', 'sfpplus-10g', 3, 0.6),
        connector('10GE-2', 'sfpplus-10g', 5, 0.6),
        connector('10GE-3', 'sfpplus-10g', 7, 0.6),
        connector('100GE-1', '100ge-cages', 25, 6.4),
        connector('100GE-2', '100ge-cages', 29, 6.4),
      ],
    });
    expect(captions.map((caption) => caption.label)).toEqual(['10GE × 3', '100GE × 2']);
    expect(captions[0]).toMatchObject({ key: 'sfpplus-10g', count: 3, y: 0 });
  });

  it('extrai família e ordinal do nome da porta', () => {
    expect(portFamilyPrefix('10GE-12')).toBe('10GE');
    expect(portFamilyPrefix('SFP28-1')).toBe('SFP28');
    expect(portFamilyPrefix('GPON-16')).toBe('GPON');
    expect(portFamilyPrefix('CONSOLE')).toBe('CONSOLE');
    expect(portOrdinalLabel('10GE-12')).toBe('12');
    expect(portOrdinalLabel('QSFP28-6')).toBe('6');
    expect(portOrdinalLabel('CONSOLE')).toBeNull();
  });
});

function connector(portName: string, groupKey: string, x: number, y: number) {
  return {
    portId: `port-${portName}`,
    portName,
    kind: 'SFP' as const,
    shape: { width: 3.2, height: 2.2, label: 'SFP' },
    x,
    y,
    row: 0,
    column: 0,
    groupKey,
    catalogPort: null,
  };
}
