import { describe, expect, it } from 'vitest';
import type { PhysicalCatalogPort } from '@gmj/shared';
import { physicalPort } from './physical-fixtures';
import { buildPanelLayout, connectorAnchor } from './physical-panel-layout';
import {
  FIXED_FACEPLATE_CATALOG_KEYS,
  TECHNICAL_FIXED_MAX_HEIGHT,
  buildFixedFaceplateLayout,
  fixedFaceplateLeds,
  fixedFaceplateRegions,
  fixedTechnicalFaceplateFor,
  hasFixedFaceplate,
  technicalFixedFaceplateHeight,
} from './physical-fixed-faceplate';

/**
 * Camada de **faceplate fixo**: só desenho. Os testes garantem que a passada
 * visual (posição dos blocos, proporção do chassi, legendas, LEDs, ventilação)
 * não cria, remove, renomeia nem reindexa porta — ids, conectores, numeração
 * física e âncora continuam os mesmos do catálogo.
 */

/** F1A-8H20Q: 4 blocos do catálogo, faixa única 0–55 (par em cima). */
function f1aCatalogPorts(): PhysicalCatalogPort[] {
  const groups = [
    ['sfpplus-10g', 28, 0, 'SFP_PLUS', 'SFP_PLUS', '10GE-', 'SERVICE'],
    ['sfp28-25g-a', 8, 28, 'SFP28', 'SFP_PLUS', '25GE-', 'SERVICE'],
    ['sfp28-25g-b', 12, 36, 'SFP28', 'SFP_PLUS', '25GE-', 'SERVICE'],
    ['qsfp28-100g', 8, 48, 'QSFP28', 'QSFP', '100GE-', 'UPLINK'],
  ] as const;
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (const [groupKey, count, start, connector, type, prefix, portFunction] of groups) {
    for (let index = 0; index < count; index += 1) {
      order += 1;
      ports.push({
        name: `${prefix}${start + index}`,
        label: `${prefix}${start + index}`,
        order,
        side: 'DEVICE',
        type,
        connector,
        portFunction,
        speeds: [],
        breakoutCapable: false,
        groupKey,
        interfaceName: null,
        panelNumber: start + index,
        notes: null,
        visual: { row: 1, x: 0, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
      });
    }
  }
  return ports;
}

function assetPorts(catalogPorts: PhysicalCatalogPort[], assetId: string) {
  return catalogPorts.map((port, index) =>
    physicalPort({
      id: `${assetId}-port-${index + 1}`,
      name: port.name,
      label: port.label,
      order: port.order,
      type: port.type,
    }),
  );
}

function layoutFor(catalogKey: string, catalogPorts: PhysicalCatalogPort[]) {
  const id = `asset-${catalogKey}`;
  const entry = {
    ports: catalogPorts,
    panelLayout: { type: 'LOGICAL' as const, width: 100, height: 8 },
  };
  return {
    entry,
    ports: assetPorts(catalogPorts, id),
    plain: buildPanelLayout({ ports: assetPorts(catalogPorts, id), slots: [], modules: [], entry }),
  };
}

describe('faceplate fixo: registro por SKU', () => {
  it('só o F1A ficou nesta camada; os demais migraram para o perfil visual', () => {
    expect([...FIXED_FACEPLATE_CATALOG_KEYS]).toEqual(['huawei-ne8000-f1a-8h20q']);
    expect(hasFixedFaceplate('huawei-ne8000-f1a-8h20q')).toBe(true);
    // SKUs migrados para a biblioteca visual (perfil próprio, outra camada)
    expect(hasFixedFaceplate('huawei-s6750-h36c')).toBe(false);
    expect(hasFixedFaceplate('huawei-s6730-h48x6c')).toBe(false);
    expect(fixedTechnicalFaceplateFor('huawei-s6750-h48x8c')).toBeNull();
    expect(fixedTechnicalFaceplateFor(null)).toBeNull();
  });

  it('a spec é só visual: nada de porta, conector ou nome dentro dela', () => {
    const spec = fixedTechnicalFaceplateFor('huawei-ne8000-f1a-8h20q')!;
    expect(spec.chassis.width).toBeGreaterThan(0);
    expect(spec.ports.width).toBeGreaterThan(0);
    expect(spec.bands).toHaveLength(1);
    // os grupos citados são exatamente os `groupKey` declarados no catálogo
    expect(spec.bands[0]!.groups.map((group) => group.groupKey)).toEqual([
      'sfpplus-10g',
      'sfp28-25g-a',
      'sfp28-25g-b',
      'qsfp28-100g',
    ]);
    expect(spec.vents?.length).toBeGreaterThan(0);
    expect(spec.brand).toBeTruthy();
    expect(spec.leds?.labels).toEqual(['PWR', 'ALM', 'ACT']);
  });

  it('LEDs do chassi com os tons já usados na visão técnica', () => {
    const spec = fixedTechnicalFaceplateFor('huawei-ne8000-f1a-8h20q')!;
    expect(fixedFaceplateLeds(spec)).toEqual([
      { label: 'PWR', tone: 'pwr' },
      { label: 'ALM', tone: 'off' },
      { label: 'ACT', tone: 'act' },
    ]);
  });
});

describe('faceplate do F1A-8H20Q (0–55, 28 colunas × 2 fileiras)', () => {
  const catalogPorts = f1aCatalogPorts();
  const { plain } = layoutFor('f1a', catalogPorts);
  const spec = fixedTechnicalFaceplateFor('huawei-ne8000-f1a-8h20q')!;
  const layout = buildFixedFaceplateLayout(plain, spec);

  it('não cria, remove nem reindexa porta (mesmos ids, mesmos conectores)', () => {
    expect(layout.connectors).toHaveLength(56);
    expect(layout.connectors.map((connector) => connector.portId)).toEqual(
      plain.connectors.map((connector) => connector.portId),
    );
    expect(new Set(layout.connectors.map((connector) => connector.portId)).size).toBe(56);
    for (const connector of layout.connectors) {
      const source = plain.connectors.find((item) => item.portId === connector.portId)!;
      expect(connector.kind).toBe(source.kind);
      expect(connector.shape).toEqual(source.shape);
      expect(connector.portName).toBe(source.portName);
      expect(connector.groupKey).toBe(source.groupKey);
      expect(connector.catalogPort?.panelNumber).toBe(source.catalogPort?.panelNumber);
    }
  });

  it('mantém a numeração física 0–55 no par/ímpar (0 e 1 na mesma coluna)', () => {
    const byNumber = new Map(
      layout.connectors.map((connector) => [connector.catalogPort?.panelNumber ?? -1, connector]),
    );
    expect([...byNumber.keys()].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 56 }, (_value, index) => index),
    );
    // colunas do bloco 0–27: column = floor(n/2), par em cima
    for (const number of [0, 1, 2, 3, 26, 27]) {
      const connector = byNumber.get(number)!;
      expect(connector.column).toBe(Math.floor(number / 2));
      expect(connector.row).toBe(number % 2);
    }
    expect(byNumber.get(0)!.x).toBeCloseTo(byNumber.get(1)!.x, 5);
    expect(byNumber.get(1)!.y).toBeGreaterThan(byNumber.get(0)!.y);
  });

  it('distribui os quatro blocos lado a lado, contíguos e dentro do chassi', () => {
    const span = (groupKey: string) => {
      const items = layout.connectors.filter((connector) => connector.groupKey === groupKey);
      return {
        count: items.length,
        start: Math.min(...items.map((item) => item.x)),
        end: Math.max(...items.map((item) => item.x + item.shape.width)),
        top: Math.min(...items.map((item) => item.y)),
        bottom: Math.max(...items.map((item) => item.y + item.shape.height)),
      };
    };
    const a = span('sfpplus-10g');
    const b = span('sfp28-25g-a');
    const c = span('sfp28-25g-b');
    const d = span('qsfp28-100g');
    expect([a.count, b.count, c.count, d.count]).toEqual([28, 8, 12, 8]);
    expect(a.end).toBeLessThanOrEqual(b.start);
    expect(b.end).toBeLessThanOrEqual(c.start);
    expect(c.end).toBeLessThanOrEqual(d.start);
    // as portas ocupam a maior parte útil da largura frontal
    expect(d.end - a.start).toBeGreaterThan(spec.ports.width * 0.95);
    // e cabem no chassi declarado (com a serigrafia/LEDs à esquerda e vent à direita)
    for (const group of [a, b, c, d]) {
      expect(group.start).toBeGreaterThan(spec.brand!.x + spec.brand!.width);
      expect(group.end).toBeLessThan(spec.vents![0]!.x);
      expect(group.bottom).toBeLessThan(spec.chassis.height);
    }
    // fileiras alinhadas entre os blocos: mesma banda, com cada jaula centrada
    // na célula (o QSFP28 é mais alto que o SFP+ → 0,2 de grade de diferença)
    const tops = [a.top, b.top, c.top, d.top];
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(0.21);
    expect(layout.gridHeight).toBe(spec.chassis.height);
    expect(layout.width).toBe(spec.chassis.width);
  });

  it('mantém a âncora do cabo no centro do conector desenhado', () => {
    const viewport = { scale: 6.5, offsetX: 40, offsetY: 12 };
    for (const connector of [layout.connectors[0]!, layout.connectors.at(-1)!]) {
      const anchor = connectorAnchor(connector, viewport);
      expect(anchor.x).toBe(40 + (connector.x + connector.shape.width / 2) * 6.5);
      expect(anchor.y).toBe(12 + (connector.y + connector.shape.height / 2) * 6.5);
    }
  });

  it('legendas de bloco usam a família + a faixa física, sem caixa em volta', () => {
    const regions = fixedFaceplateRegions(layout);
    expect(regions.map((region) => region.key)).toEqual([
      'sfpplus-10g',
      'sfp28-25g-a',
      'sfp28-25g-b',
      'qsfp28-100g',
    ]);
    expect(regions.map((region) => `${region.label} · ${region.range}`)).toEqual([
      '10GE · 0–27',
      '25GE · 28–35',
      '25GE · 36–47',
      '100GE · 48–55',
    ]);
    expect(regions.map((region) => region.role)).toEqual([
      'service',
      'service',
      'service',
      'uplink',
    ]);
    // zonas derivadas das portas desenhadas (a legenda acompanha o bloco)
    expect(regions[0]!.zone.width).toBeGreaterThan(regions[1]!.zone.width);
    expect(regions.at(-1)!.zone.x).toBeGreaterThan(regions[0]!.zone.x);
  });

  it('a faixa de interfaces CLI só aparece quando todos os nomes existem', () => {
    const names = new Map(
      layout.connectors.map((connector) => [connector.portId, null as string | null]),
    );
    const synced = new Map(names);
    layout.connectors.forEach((connector, index) => {
      if (index < 28) synced.set(connector.portId, `10GE1/0/${index + 1}`);
    });
    const partial = fixedFaceplateRegions(layout, {
      interfaceNameOf: (portId) => synced.get(portId) ?? null,
    });
    expect(partial.map((region) => region.interfaceRange)).toEqual([
      '10GE1/0/1–28',
      null,
      null,
      null,
    ]);
    const none = fixedFaceplateRegions(layout, { interfaceNameOf: () => null });
    expect(none.every((region) => region.interfaceRange === null)).toBe(true);
  });
});

describe('altura visual do faceplate fixo', () => {
  const spec = fixedTechnicalFaceplateFor('huawei-ne8000-f1a-8h20q')!;
  const base = { spec, panelWidthPx: 828, heightU: 1, baseUnitHeight: 30, chromePx: 38 };

  it('nunca fica abaixo da ocupação física nem acima do teto do desenho', () => {
    const height = technicalFixedFaceplateHeight(base);
    expect(height).toBeGreaterThanOrEqual(30);
    expect(height).toBeLessThanOrEqual(TECHNICAL_FIXED_MAX_HEIGHT);
    // a proporção do frontal manda: 119 unidades de chassi em 828px
    const drawing = Math.round(spec.chassis.height * (828 / spec.chassis.width));
    expect(height).toBeGreaterThanOrEqual(38 + drawing);
    expect(height).toBeLessThan(38 + drawing + 8);
  });

  it('um switch 1U não vira um painel de 4–5U', () => {
    // o desenho técnico anterior crescia com a grade (gridHeight × 19px)
    const previous = 38 + 11 * 19;
    expect(technicalFixedFaceplateHeight(base)).toBeLessThan(previous / 2);
    // e o teto continua valendo para qualquer grade declarada
    const tall = technicalFixedFaceplateHeight({ ...base, maxHeightPx: 90 });
    expect(tall).toBeLessThanOrEqual(90);
  });

  it('a linha extra da faixa de interfaces CLI entra na altura (quando existe)', () => {
    const withLine = technicalFixedFaceplateHeight({ ...base, extraHeightPx: 9 });
    expect(withLine - technicalFixedFaceplateHeight(base)).toBe(9);
  });
});
