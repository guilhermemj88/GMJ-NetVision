import { describe, expect, it } from 'vitest';
import { modularChassisMap } from './modular-chassis-map';
import {
  TECHNICAL_RENDER_CATALOG_KEYS,
  assetUsesTechnicalRenderer,
  hasTechnicalRenderer,
  portFamilyPrefix,
  portOrdinalLabel,
  slotRoleAccent,
  technicalChassisDisplayHeight,
  technicalChassisMap,
  technicalGroupBays,
  technicalGroupRole,
  technicalPanelCaptions,
} from './physical-technical';

/**
 * Núcleo da visão técnica: quais modelos têm desenho técnico nesta fase e como
 * o renderer deriva legendas/altura — sempre a partir do que já existe
 * (catálogo + mapa do chassi), sem estrutura paralela.
 */
describe('physical technical rendering', () => {
  it('declara exatamente os modelos desta fase (SKUs exatos, sem placeholders)', () => {
    expect([...TECHNICAL_RENDER_CATALOG_KEYS].sort()).toEqual(
      [
        // switches fixos
        'huawei-s6730-h24x6c',
        'huawei-s6730-h24x6c-v2',
        'huawei-s6730-h48x6c',
        'huawei-s6730-h48x6c-v2',
        'huawei-s6750-h36c',
        'huawei-s6750-h48x8c',
        'huawei-s6750-h48y8c',
        'huawei-s6750-h48y8c-b',
        // roteador fixo
        'huawei-ne8000-f1a-8h20q',
        // roteadores modulares
        'huawei-ne8000-m4',
        'huawei-ne8000-m8-ac',
        'huawei-ne8000-m8-dc',
        'huawei-ne40e-x3-ac',
        'huawei-ne40e-x3-dc',
        'huawei-ne40e-x3a',
        'huawei-ne40e-x8',
        'huawei-ne40e-x8a',
        'huawei-ne40e-x16',
        'huawei-ne40e-x16a',
        // OLTs
        'huawei-ma5683t',
        'huawei-ma5800-x15',
        'huawei-ma5800-x17',
        'huawei-ma5800-x2',
        'huawei-ma5800-x7',
      ].sort(),
    );
  });

  it('mantém placeholders de família fora do desenho técnico', () => {
    expect(hasTechnicalRenderer('huawei-s5700-family')).toBe(false);
    expect(hasTechnicalRenderer('huawei-s5720-family')).toBe(false);
    expect(hasTechnicalRenderer('huawei-s6720-family')).toBe(false);
    expect(hasTechnicalRenderer('huawei-ne40e-x3')).toBe(false);
  });

  it('resolve o renderer por catálogo e modo', () => {
    expect(hasTechnicalRenderer('huawei-ne8000-f1a-8h20q')).toBe(true);
    expect(hasTechnicalRenderer('huawei-s6730-h48x6c')).toBe(true);
    expect(hasTechnicalRenderer('huawei-s6750-h48x8c')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ma5800-x7')).toBe(true);
    // SKUs novos desta fase
    expect(hasTechnicalRenderer('huawei-s6730-h24x6c')).toBe(true);
    expect(hasTechnicalRenderer('huawei-s6750-h36c')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ne8000-m4')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ne8000-m8-dc')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ne40e-x3-dc')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ne40e-x16a')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ma5683t')).toBe(true);
    expect(hasTechnicalRenderer('huawei-ma5800-x2')).toBe(true);
    // fora do escopo (não-Huawei e placeholders)
    expect(hasTechnicalRenderer('mikrotik-crs328-24p-4splus-rm')).toBe(false);
    expect(hasTechnicalRenderer(null)).toBe(false);

    // o modo real nunca troca o desenho
    expect(assetUsesTechnicalRenderer('huawei-s6730-h48x6c', 'REAL')).toBe(false);
    expect(assetUsesTechnicalRenderer('huawei-s6730-h48x6c', 'TECHNICAL')).toBe(true);
    expect(assetUsesTechnicalRenderer('huawei-s6730-h24x6c', 'TECHNICAL')).toBe(true);
    expect(assetUsesTechnicalRenderer('huawei-s6720-family', 'TECHNICAL')).toBe(false);
  });

  it('mapeia o papel do slot para o acento visual', () => {
    expect(slotRoleAccent('SERVICE')).toBe('service');
    expect(slotRoleAccent('SERVICE_OR_UPLINK')).toBe('service');
    expect(slotRoleAccent('LPU')).toBe('service');
    expect(slotRoleAccent('UPLINK')).toBe('uplink');
    expect(slotRoleAccent('CONTROL')).toBe('control');
    expect(slotRoleAccent('MPU')).toBe('control');
    expect(slotRoleAccent('FABRIC')).toBe('fabric');
    expect(slotRoleAccent('SFU')).toBe('fabric');
    expect(slotRoleAccent('POWER')).toBe('power');
    expect(slotRoleAccent('FAN')).toBe('fan');
    expect(slotRoleAccent('UNIVERSAL')).toBe('neutral');
    expect(slotRoleAccent(null)).toBe('neutral');
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

  it('papel do grupo vem do portFunction declarado (nunca inferido)', () => {
    expect(technicalGroupRole('SERVICE')).toBe('service');
    expect(technicalGroupRole('PON')).toBe('service');
    expect(technicalGroupRole('UPLINK')).toBe('uplink');
    expect(technicalGroupRole('MGMT')).toBe('control');
    expect(technicalGroupRole('MGMT_OR_SERVICE')).toBe('control');
    expect(technicalGroupRole('CONSOLE')).toBe('control');
    expect(technicalGroupRole('POWER')).toBe('power');
    expect(technicalGroupRole(null)).toBe('neutral');
    expect(technicalGroupRole(undefined)).toBe('neutral');
  });

  it('baías do painel fixo agrupam por groupKey com papel e faixa reais', () => {
    const bays = technicalGroupBays({
      connectors: [
        bayConnector('port-1', 'QSFP28-1', 'qsfp28-service', 'SERVICE', 4, 0.6),
        bayConnector('port-2', 'QSFP28-2', 'qsfp28-service', 'SERVICE', 8.4, 0.6),
        bayConnector('port-33', 'QSFP28-33', 'qsfp28-uplink', 'UPLINK', 40, 6.4),
        bayConnector('port-36', 'QSFP28-36', 'qsfp28-uplink', 'UPLINK', 44.4, 6.4),
      ],
    });

    expect(bays).toHaveLength(2);
    expect(bays[0]).toMatchObject({ key: 'qsfp28-service', role: 'service', label: 'SERVICE', range: '1–2', count: 2 });
    expect(bays[1]).toMatchObject({ key: 'qsfp28-uplink', role: 'uplink', label: 'UPLINK', range: '33–36', count: 2 });
    // a baía envolve o grupo (com respiro) e não muda nenhuma porta
    expect(bays[0]!.y).toBeLessThan(0.6);
    expect(bays[0]!.height).toBeGreaterThan(0);
    expect(bays[0]!.y).toBeLessThan(bays[1]!.y);
  });

  it('baías sem ordinal e sem papel declarado continuam válidas', () => {
    const bays = technicalGroupBays({
      connectors: [bayConnector('port-a', 'CONSOLE', 'console', null, 2, 1)],
    });

    expect(bays).toHaveLength(1);
    expect(bays[0]).toMatchObject({ role: 'neutral', label: 'PORTS', range: null, count: 1 });
  });
});

function bayConnector(
  portId: string,
  portName: string,
  groupKey: string,
  portFunction: string | null,
  x: number,
  y: number,
) {
  return {
    portId,
    portName,
    kind: 'SFP' as const,
    shape: { width: 4.4, height: 2.6, label: 'QSFP28' },
    x,
    y,
    row: 0,
    column: 0,
    groupKey,
    catalogPort: portFunction
      ? {
          name: portName,
          label: portName,
          order: 1,
          side: 'DEVICE' as const,
          type: 'QSFP' as const,
          connector: 'QSFP28' as const,
          portFunction: portFunction as never,
          speeds: [],
          breakoutCapable: false,
          groupKey,
          interfaceName: null,
          notes: null,
          visual: null,
        }
      : null,
  };
}

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
