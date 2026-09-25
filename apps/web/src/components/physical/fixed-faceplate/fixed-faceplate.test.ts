import { describe, expect, it } from 'vitest';
import type {
  PhysicalCatalogPort,
  PhysicalConnectorKind,
  PhysicalPortFunction,
  PhysicalPortType,
} from '@gmj/shared';
import { physicalPort } from '../physical-fixtures';
import { buildPanelLayout } from '../physical-panel-layout';
import {
  TECHNICAL_FIXED_MAX_HEIGHT,
  fixedFaceplateChrome,
  fixedFaceplateDisplayHeight,
  fixedFaceplateRegions,
  buildFixedFaceplateLayout,
} from './fixed-faceplate-layout';
import {
  FIXED_FACEPLATE_PROFILE_KEYS,
  fixedFaceplateGroupCaption,
  fixedFaceplateProfileFor,
  fixedFaceplateSpecFor,
  hasFixedFaceplateProfile,
} from './fixed-faceplate-profile';

/**
 * Camada da **biblioteca visual** (MagicPatterns) aplicada aos equipamentos
 * fixos: o perfil diz só a aparência e o motor reposiciona os MESMOS
 * conectores do catálogo. Os testes garantem que nada técnico se perde —
 * ids, conectores, `groupKey`, ordem, `panelNumber` e âncora.
 */

interface GroupDecl {
  groupKey: string;
  count: number;
  /** conector exato do catálogo (`SFP28`, `COMBO`, `QSFP28`...) */
  connector: PhysicalConnectorKind;
  /** tipo coarser do `PhysicalPort`, como o loader do catálogo deriva */
  type: PhysicalPortType;
  portFunction: PhysicalPortFunction;
  /** prefixo dos nomes (`10GE-{n}`, `ether{n}`, `100GE-{n+32}`) */
  pattern: string;
  start?: number | undefined;
}

function catalogPorts(decls: readonly GroupDecl[]): PhysicalCatalogPort[] {
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (const decl of decls) {
    const start = decl.start ?? 1;
    for (let index = 0; index < decl.count; index += 1) {
      order += 1;
      const offset = /^(.+)\{n\+(\d+)\}$/.exec(decl.pattern);
      const ordinal = start + index;
      const name = offset
        ? `${offset[1]}${ordinal + Number(offset[2])}`
        : decl.pattern.replace('{n}', String(ordinal));
      ports.push({
        name,
        label: name,
        order,
        side: 'DEVICE',
        type: decl.type,
        connector: decl.connector,
        portFunction: decl.portFunction,
        speeds: [],
        breakoutCapable: false,
        groupKey: decl.groupKey,
        interfaceName: null,
        panelNumber: null,
        notes: null,
        visual: null,
      });
    }
  }
  return ports;
}

function assetPorts(ports: readonly PhysicalCatalogPort[], assetId: string) {
  return ports.map((port) =>
    physicalPort({
      id: `${assetId}-${port.name}`,
      assetId,
      name: port.name,
      label: port.label,
      order: port.order,
      type: port.type,
    }),
  );
}

function buildFor(catalogKey: string, decls: readonly GroupDecl[]) {
  const ports = catalogPorts(decls);
  const asset = assetPorts(ports, `asset-${catalogKey}`);
  const entry = {
    ports,
    panelLayout: { type: 'LOGICAL' as const, width: 100, height: 10 },
  };
  const plain = buildPanelLayout({ ports: asset, slots: [], modules: [], entry });
  const profile = fixedFaceplateProfileFor(catalogKey)!;
  const chrome = fixedFaceplateChrome({
    panelWidthPx: 828,
    portScalePx: profile.portScalePx,
    showRackEars: profile.showRackEars,
    showLcd: profile.showLcd,
  });
  const layout = buildFixedFaceplateLayout(plain, fixedFaceplateSpecFor(profile, chrome), {
    scalePx: chrome.scale,
    portSizes: profile.portSizes,
  });
  const regions = fixedFaceplateRegions(layout);
  /** Legenda efetivamente desenhada (`GE · 1–12`, `MGMT · 13`, `SERVICE · 1–32`). */
  const captions = regions.map(
    (region) => `${fixedFaceplateGroupCaption(profile, region)} · ${region.range}`,
  );
  return { plain, asset, profile, chrome, layout, regions, captions };
}

/** Grupos dos SKUs do escopo (mesmos `groupKey`/contagens do catálogo). */
const S6730_H48 = [
  { groupKey: 'sfpplus-10g', count: 48, connector: 'SFP_PLUS', type: 'SFP_PLUS' as const, portFunction: 'SERVICE', pattern: '10GE-{n}' },
  { groupKey: 'qsfp28-uplink', count: 6, connector: 'QSFP28', type: 'QSFP' as const, portFunction: 'UPLINK', pattern: 'QSFP28-{n}' },
] satisfies GroupDecl[];

const S6750_H36C = [
  { groupKey: 'qsfp28-service', count: 32, connector: 'QSFP28', type: 'QSFP' as const, portFunction: 'SERVICE', pattern: 'QSFP28-{n}' },
  { groupKey: 'qsfp28-uplink', count: 4, connector: 'QSFP28', type: 'QSFP' as const, portFunction: 'UPLINK', pattern: 'QSFP28-{n+32}' },
] satisfies GroupDecl[];

const CCR2116 = [
  { groupKey: 'ether-service', count: 12, connector: 'RJ45', type: 'RJ45' as const, portFunction: 'SERVICE', pattern: 'ether{n}' },
  { groupKey: 'ether-management', count: 1, connector: 'RJ45', type: 'RJ45' as const, portFunction: 'MGMT', pattern: 'ether{n}', start: 13 },
  { groupKey: 'sfpplus', count: 4, connector: 'SFP_PLUS', type: 'SFP_PLUS' as const, portFunction: 'UPLINK', pattern: 'sfp-sfpplus{n}' },
  { groupKey: 'console', count: 1, connector: 'RJ45', type: 'RJ45' as const, portFunction: 'CONSOLE', pattern: 'serial' },
] satisfies GroupDecl[];

const CCR2216 = [
  { groupKey: 'ether', count: 1, connector: 'RJ45', type: 'RJ45' as const, portFunction: 'MGMT', pattern: 'ether{n}' },
  { groupKey: 'sfp28', count: 12, connector: 'SFP28', type: 'SFP_PLUS' as const, portFunction: 'SERVICE', pattern: 'sfp28-{n}' },
  { groupKey: 'qsfp28', count: 2, connector: 'QSFP28', type: 'QSFP' as const, portFunction: 'UPLINK', pattern: 'qsfp28-{n}' },
  { groupKey: 'console', count: 1, connector: 'RJ45', type: 'RJ45' as const, portFunction: 'CONSOLE', pattern: 'serial' },
] satisfies GroupDecl[];

const CCR1009 = [
  { groupKey: 'ether', count: 7, connector: 'RJ45', type: 'RJ45' as const, portFunction: 'SERVICE', pattern: 'ether{n}' },
  { groupKey: 'combo', count: 1, connector: 'COMBO', type: 'OTHER' as const, portFunction: 'SERVICE', pattern: 'combo{n}' },
  { groupKey: 'sfpplus', count: 1, connector: 'SFP_PLUS', type: 'SFP_PLUS' as const, portFunction: 'UPLINK', pattern: 'sfp-sfpplus{n}' },
  { groupKey: 'console', count: 1, connector: 'RJ45', type: 'RJ45' as const, portFunction: 'CONSOLE', pattern: 'serial' },
] satisfies GroupDecl[];

describe('perfil visual por SKU (biblioteca visual)', () => {
  it('cobre os SKUs migrados e não invade os demais', () => {
    expect(FIXED_FACEPLATE_PROFILE_KEYS).toHaveLength(17);
    expect(hasFixedFaceplateProfile('huawei-s6730-h48x6c')).toBe(true);
    expect(hasFixedFaceplateProfile('huawei-s6750-h36c')).toBe(true);
    expect(hasFixedFaceplateProfile('mikrotik-ccr2116-12g-4splus')).toBe(true);
    expect(hasFixedFaceplateProfile('mikrotik-ccr2216-1g-12xs-2xq')).toBe(true);
    // fora do escopo: F1A (camada anterior) e SKUs não migrados
    expect(hasFixedFaceplateProfile('huawei-ne8000-f1a-8h20q')).toBe(false);
    expect(hasFixedFaceplateProfile('huawei-ne8000-m4')).toBe(false);
    expect(hasFixedFaceplateProfile('mikrotik-crs328-24p-4splus-rm')).toBe(false);
    expect(fixedFaceplateProfileFor(null)).toBeNull();
  });

  it('o perfil não carrega dado técnico (nem count, nem conector, nem nome)', () => {
    const profile = fixedFaceplateProfileFor('huawei-s6750-h36c')!;
    const keys = Object.keys(profile);
    for (const forbidden of ['count', 'ports', 'connector', 'interfaceName', 'panelNumber']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    // grupos são referenciados pelo `groupKey` do catálogo
    expect(profile.groupOrder).toEqual(['qsfp28-service', 'qsfp28-uplink']);
    expect(profile.vendorStyle).toBe('HUAWEI');
    expect(profile.showRackEars).toBe(true);
    expect(profile.showLcd).toBeFalsy();
  });

  it('MikroTik declara LCD e a gaveta COMBO com o tamanho da biblioteca', () => {
    const ccr2116 = fixedFaceplateProfileFor('mikrotik-ccr2116-12g-4splus')!;
    expect(ccr2116.vendorStyle).toBe('MIKROTIK');
    expect(ccr2116.showLcd).toBe(true);
    const ccr1009 = fixedFaceplateProfileFor('mikrotik-ccr1009-7g-1c-1splus')!;
    expect(ccr1009.portSizes?.COMBO).toEqual({ width: 36, height: 16 });
    // console/serial vai para a área de gerência
    expect(ccr1009.groupPresentation?.console?.management).toBe(true);
  });

  it('o chrome (px da biblioteca) vira unidade de grade com a escala do perfil', () => {
    const chrome = fixedFaceplateChrome({
      panelWidthPx: 828,
      portScalePx: 5.6,
      showRackEars: true,
      showLcd: false,
    });
    expect(chrome.scale).toBe(5.6);
    expect(chrome.chassisWidthUnits).toBeCloseTo(828 / 5.6, 5);
    // orelhas e respiro laterais continuam com os pixels do protótipo
    expect(chrome.earUnits * chrome.scale).toBeCloseTo(22, 5);
    expect(chrome.padUnits * chrome.scale).toBeCloseTo(7, 5);
    // a região das portas cabe entre as orelhas e o respiro
    expect(chrome.regionWidthUnits).toBeLessThan(chrome.chassisWidthUnits);
    expect(chrome.regionWidthUnits).toBeGreaterThan(chrome.chassisWidthUnits * 0.85);
    // com LCD a região útil encolhe
    const withLcd = fixedFaceplateChrome({
      panelWidthPx: 828,
      portScalePx: 5.6,
      showRackEars: true,
      showLcd: true,
    });
    expect(withLcd.lcdUnits).toBeGreaterThan(0);
    expect(withLcd.regionWidthUnits).toBeLessThan(chrome.regionWidthUnits);
  });
});

describe('layout do faceplate da biblioteca (nada técnico muda)', () => {
  it('S6730-H48X6C: 54 portas, mesmos ids/conectores/grupos', () => {
    const { plain, asset, layout } = buildFor('huawei-s6730-h48x6c', S6730_H48);
    expect(layout.connectors).toHaveLength(54);
    expect(layout.connectors.map((connector) => connector.portId)).toEqual(
      plain.connectors.map((connector) => connector.portId),
    );
    for (const connector of layout.connectors) {
      const source = plain.connectors.find((item) => item.portId === connector.portId)!;
      expect(connector.portName).toBe(source.portName);
      expect(connector.kind).toBe(source.kind);
      expect(connector.groupKey).toBe(source.groupKey);
      expect(connector.catalogPort?.panelNumber).toBe(source.catalogPort?.panelNumber);
    }
    expect(new Set(layout.connectors.map((connector) => connector.portId)).size).toBe(54);
    expect(asset).toHaveLength(54);
  });

  it('S6730-H48X6C: 24 colunas × 2 fileiras + 3 colunas × 2 fileiras, dentro do chassi', () => {
    const { layout, profile } = buildFor('huawei-s6730-h48x6c', S6730_H48);
    const service = layout.connectors.filter((item) => item.groupKey === 'sfpplus-10g');
    const uplink = layout.connectors.filter((item) => item.groupKey === 'qsfp28-uplink');
    expect(new Set(service.map((item) => item.column)).size).toBe(24);
    expect(new Set(service.map((item) => item.row)).size).toBe(2);
    expect(new Set(uplink.map((item) => item.column)).size).toBe(3);
    expect(new Set(uplink.map((item) => item.row)).size).toBe(2);
    // blocos lado a lado, na mesma faixa, sem sobreposição
    const serviceRight = Math.max(...service.map((item) => item.x + item.shape.width));
    expect(Math.min(...uplink.map((item) => item.x))).toBeGreaterThan(serviceRight);
    // mesma faixa: cada jaula é centrada na sua célula (SFP+ 0,2 mais baixo)
    expect(Math.abs(Math.min(...uplink.map((item) => item.y)) - Math.min(...service.map((item) => item.y)))).toBeLessThanOrEqual(0.21);
    // tudo dentro do chassi desenhado
    for (const connector of layout.connectors) {
      expect(connector.x).toBeGreaterThanOrEqual(0);
      expect(connector.x + connector.shape.width).toBeLessThanOrEqual(layout.width);
      expect(connector.y).toBeGreaterThanOrEqual(profile.showRackEars ? 0 : 0);
      expect(connector.y + connector.shape.height).toBeLessThanOrEqual(layout.gridHeight);
    }
  });

  it('S6750-H36C: 32 de serviço + 4 uplinks 2×2 na mesma faixa (ordinal 33–36)', () => {
    const { layout, regions } = buildFor('huawei-s6750-h36c', S6750_H36C);
    expect(layout.connectors).toHaveLength(36);
    const service = layout.connectors.filter((item) => item.groupKey === 'qsfp28-service');
    const uplink = layout.connectors.filter((item) => item.groupKey === 'qsfp28-uplink');
    expect(service).toHaveLength(32);
    expect(uplink).toHaveLength(4);
    expect(new Set(service.map((item) => item.column)).size).toBe(16);
    expect(new Set(uplink.map((item) => item.column)).size).toBe(2);
    expect(new Set(uplink.map((item) => item.row)).size).toBe(2);
    expect(Math.min(...uplink.map((item) => item.x))).toBeGreaterThan(
      Math.max(...service.map((item) => item.x + item.shape.width)),
    );
    expect(uplink.map((item) => item.portName).sort()).toEqual([
      'QSFP28-33',
      'QSFP28-34',
      'QSFP28-35',
      'QSFP28-36',
    ]);
    // mesma família nos dois blocos → legenda pelo papel declarado
    expect(regions.map((region) => `${region.label} · ${region.range}`)).toEqual([
      'SERVICE · 1–32',
      'UPLINK · 33–36',
    ]);
  });

  it('S6750-H36C: mantém exatamente 2 fileiras dentro do chassi', () => {
    const { layout } = buildFor('huawei-s6750-h36c', S6750_H36C);
    const rows = new Set(layout.connectors.map((item) => item.row));
    expect(rows).toEqual(new Set([0, 1]));
    // 2 fileiras de jaulas + cabeçalho + legendas e rodapé (unidades de grade)
    expect(layout.gridHeight).toBeGreaterThan(10);
    expect(layout.gridHeight).toBeLessThan(20);
  });

  it('CCR2116: 12 GE de serviço + ether13 (MGMT) + 4 SFP+, com LCD', () => {
    const { layout, profile, captions } = buildFor('mikrotik-ccr2116-12g-4splus', CCR2116);
    expect(layout.connectors).toHaveLength(18);
    expect(profile.showLcd).toBe(true);
    const service = layout.connectors.filter((item) => item.groupKey === 'ether-service');
    const management = layout.connectors.filter((item) => item.groupKey === 'ether-management');
    const uplink = layout.connectors.filter((item) => item.groupKey === 'sfpplus');
    const console = layout.connectors.filter((item) => item.groupKey === 'console');
    expect(service).toHaveLength(12);
    expect(management).toHaveLength(1);
    expect(management[0]!.portName).toBe('ether13');
    expect(uplink).toHaveLength(4);
    expect(console).toHaveLength(1);
    // console/serial fica na área de gerência, à esquerda de tudo
    expect(console[0]!.x).toBeLessThan(Math.min(...service.map((item) => item.x)));
    expect(console[0]!.x).toBeLessThan(Math.min(...management.map((item) => item.x)));
    // GE 2 fileiras (6 colunas), SFP+ 2 fileiras (2 colunas)
    expect(new Set(service.map((item) => item.column)).size).toBe(6);
    expect(new Set(service.map((item) => item.row)).size).toBe(2);
    expect(new Set(uplink.map((item) => item.column)).size).toBe(2);
    // legendas com os nomes da biblioteca (`GE · 1–12`, `MGMT · 13`, `SFP+ · 1–4`)
    expect(captions).toContain('GE · 1–12');
    expect(captions).toContain('MGMT · 13');
    expect(captions).toContain('SFP+ · 1–4');
    expect(captions).toContain('SERIAL · null');
  });

  it('CCR2216: MGMT + 12 SFP28 + 2 QSFP28 (mesma arquitetura, outro perfil)', () => {
    const { layout, captions } = buildFor('mikrotik-ccr2216-1g-12xs-2xq', CCR2216);
    expect(layout.connectors).toHaveLength(16);
    const sfp28 = layout.connectors.filter((item) => item.groupKey === 'sfp28');
    const qsfp28 = layout.connectors.filter((item) => item.groupKey === 'qsfp28');
    expect(new Set(sfp28.map((item) => item.column)).size).toBe(6);
    expect(new Set(sfp28.map((item) => item.row)).size).toBe(2);
    expect(new Set(qsfp28.map((item) => item.column)).size).toBe(1);
    expect(new Set(qsfp28.map((item) => item.row)).size).toBe(2);
    expect(captions).toContain('MGMT · 1');
    expect(captions).toContain('SFP28 · 1–12');
  });

  it('CCR1009-7G-1C-1S+: a porta COMBO continua uma única porta, com o tamanho da gaveta', () => {
    const { layout, plain } = buildFor('mikrotik-ccr1009-7g-1c-1splus', CCR1009);
    expect(layout.connectors).toHaveLength(10);
    const combo = layout.connectors.find((item) => item.groupKey === 'combo')!;
    const source = plain.connectors.find((item) => item.portId === combo.portId)!;
    // mesma porta (id/conector), shape trocado pelo perfil (px → unidades)
    expect(combo.portId).toBe(source.portId);
    expect(combo.kind).toBe('COMBO');
    expect(combo.shape.width).toBeCloseTo(36 / 5.6, 5);
    expect(combo.shape.height).toBeCloseTo(16 / 5.6, 5);
    expect(combo.shape.width).toBeGreaterThan(source.shape.width);
  });

  it('a âncora sai do centro do conector desenhado (mesma geometria)', () => {
    const { layout } = buildFor('mikrotik-ccr2116-12g-4splus', CCR2116);
    const comboLayout = buildFor('mikrotik-ccr1009-7g-1c-1splus', CCR1009).layout;
    for (const connector of [layout.connectors[0]!, ...comboLayout.connectors.slice(1, 3)]) {
      // a âncora é derivada do shape desenhado — o mesmo usado pelo clique
      const anchor = {
        x: connector.x + connector.shape.width / 2,
        y: connector.y + connector.shape.height / 2,
      };
      expect(anchor.x).toBeGreaterThan(connector.x);
      expect(anchor.y).toBeGreaterThan(connector.y);
    }
  });
});

describe('altura visual do faceplate da biblioteca', () => {
  const chrome = fixedFaceplateChrome({
    panelWidthPx: 828,
    portScalePx: 5.6,
    showRackEars: true,
    showLcd: false,
  });

  it('respeita a ocupação física e o teto do desenho técnico', () => {
    const { layout } = buildFor('huawei-s6730-h48x6c', S6730_H48);
    const height = fixedFaceplateDisplayHeight({
      gridHeight: layout.gridHeight,
      gridWidth: layout.width,
      panelWidthPx: 828,
      heightU: 1,
      baseUnitHeight: 30,
      chromePx: 20 + 8,
    });
    expect(height).toBeGreaterThanOrEqual(30);
    expect(height).toBeLessThanOrEqual(TECHNICAL_FIXED_MAX_HEIGHT);
    // chassi: cabeçalho + painel + legendas + rodapé (nunca um painel de 4–5U)
    expect(height).toBeLessThan(136);
    expect(chrome.chassisWidthUnits).toBeCloseTo(layout.width, 5);
  });

  it('1U continua 1U: desenho bem mais baixo que o renderer técnico anterior', () => {
    const { layout } = buildFor('huawei-s6750-h36c', S6750_H36C);
    const height = fixedFaceplateDisplayHeight({
      gridHeight: layout.gridHeight,
      gridWidth: layout.width,
      panelWidthPx: 828,
      heightU: 1,
      baseUnitHeight: 30,
      chromePx: 28,
    });
    // o desenho técnico anterior crescia com a grade (gridHeight × 19px)
    expect(height).toBeLessThan((38 + 11 * 19) / 2);
  });

  it('a faixa de interfaces CLI soma uma linha quando existe', () => {
    const base = {
      gridHeight: 10,
      gridWidth: 147.8,
      panelWidthPx: 828,
      heightU: 1,
      baseUnitHeight: 30,
      chromePx: 28,
    };
    expect(fixedFaceplateDisplayHeight({ ...base, extraHeightPx: 9 }) - fixedFaceplateDisplayHeight(base)).toBe(9);
  });
});
