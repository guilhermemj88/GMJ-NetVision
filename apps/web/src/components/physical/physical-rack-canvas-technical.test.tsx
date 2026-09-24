import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PhysicalAsset,
  PhysicalCatalogPort,
  PhysicalConnectorKind,
  PhysicalPort,
  PhysicalPortFunction,
  PhysicalVisualPlacement,
} from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import { modularChassisMap } from './modular-chassis-map';
import type { PhysicalSelection, PhysicalVisualMode } from './physical-types';
import {
  catalogEntry,
  physicalAsset,
  physicalConnection,
  physicalModule,
  physicalPort,
  physicalRack,
  physicalSlot,
} from './physical-fixtures';
import {
  SLOT_LAB_ASSET_ID,
  type SlotLabState,
  buildSlotLabAsset,
  buildSlotLabCatalog,
  tryInstallModule,
} from './slot-lab';

/**
 * Visão **TÉCNICA**: mesma verdade (catálogo → layout → portas → cabos), outro
 * desenho. Só os modelos desta fase trocam; o resto continua no modo real.
 */

interface GroupSpec {
  groupKey: string;
  count: number;
  connector: PhysicalConnectorKind;
  type: PhysicalPort['type'];
  portFunction: PhysicalPortFunction;
  pattern: string;
  /**
   * `interfaceNamePattern` confirmado no catálogo (`100GE1/0/{n}`). Quando
   * declarado, o nome apresentado da porta passa a ser o nome da interface.
   */
  interfacePattern?: string | undefined;
  /** Primeiro número físico do grupo no painel (0 no F1A-8H20Q). */
  panelStart?: number;
  visual: PhysicalVisualPlacement;
}

interface DeviceSpec {
  catalogKey: string;
  model: string;
  assetId: string;
  startU: number;
  panelHeight: number;
  groups: GroupSpec[];
}

const noop = () => undefined;

function templateRef(catalogKey: string, model: string) {
  return {
    id: `template-${catalogKey}`,
    catalogKey,
    name: model,
    category: 'SWITCH' as const,
    manufacturer: 'Huawei',
    family: '',
    model,
    kind: 'NETWORK' as const,
    heightU: 1,
    description: '',
    vendorVerified: true,
    structureConfirmed: true,
    referenceUrl: null,
    origin: 'SYSTEM' as const,
    ports: [],
    slots: [],
    modules: [],
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  };
}

function buildFixedDevice(spec: DeviceSpec) {
  const catalogPorts: PhysicalCatalogPort[] = [];
  const ports: PhysicalPort[] = [];
  let order = 0;
  for (const group of spec.groups) {
    for (let index = 1; index <= group.count; index += 1) {
      order += 1;
      const start = group.panelStart ?? 1;
      // padrão do catálogo: `10GE-{n}` ou ordinal contínuo `{n+32}`
      const offset = /^(.+)\{n\+(\d+)\}$/.exec(group.pattern);
      const name = offset
        ? `${offset[1]}${start + index - 1 + Number(offset[2])}`
        : group.pattern.replace('{n}', String(start + index - 1));
      const interfaceName = group.interfacePattern
        ? group.interfacePattern.replace(
            '{n}',
            String(group.panelStart === undefined ? index : start + index - 1),
          )
        : null;
      catalogPorts.push({
        name,
        label: name,
        order,
        side: 'DEVICE',
        type: group.type,
        connector: group.connector,
        portFunction: group.portFunction,
        speeds: [],
        breakoutCapable: false,
        groupKey: group.groupKey,
        interfaceName,
        panelNumber: group.panelStart === undefined ? null : start + index - 1,
        notes: null,
        visual: group.visual,
      });
      ports.push(
        physicalPort({
          id: `${spec.assetId}-${name}`,
          assetId: spec.assetId,
          name,
          label: name,
          order,
          side: 'DEVICE',
          type: group.type,
        }),
      );
    }
  }
  return {
    entry: catalogEntry({
      catalogKey: spec.catalogKey,
      name: `Huawei ${spec.model}`,
      manufacturer: 'Huawei',
      model: spec.model,
      panelLayout: { type: 'LOGICAL', width: 100, height: spec.panelHeight },
      ports: catalogPorts,
    }),
    asset: physicalAsset({
      id: spec.assetId,
      name: spec.model,
      startU: spec.startU,
      heightU: 1,
      templateId: `template-${spec.catalogKey}`,
      template: templateRef(spec.catalogKey, spec.model),
      ports,
    }),
    ports,
  };
}

/** F1A-8H20Q: 8×100GE + 20×25GE + 28×10GE (mesmas coordenadas do catálogo). */
/**
 * F1A-8H20Q: painel frontal oficial em UMA faixa de 28 colunas × 2 fileiras,
 * numerado de 0 a 55 (28 SFP+ 0-27, 8 SFP28 28-35, 12 SFP28 36-47 e 8 QSFP28
 * 48-55) — mesmas coordenadas e numeração do catálogo.
 */
const F1A: DeviceSpec = {
  catalogKey: 'huawei-ne8000-f1a-8h20q',
  model: 'F1A-8H20Q',
  assetId: 'asset-f1a',
  startU: 40,
  panelHeight: 7,
  groups: [
    {
      groupKey: 'sfpplus-10g',
      count: 28,
      connector: 'SFP_PLUS',
      type: 'SFP_PLUS',
      portFunction: 'SERVICE',
      pattern: '10GE-{n}',
      panelStart: 0,
      visual: { row: 1, x: 2, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
    },
    {
      groupKey: 'sfp28-25g-a',
      count: 8,
      connector: 'SFP28',
      type: 'SFP_PLUS',
      portFunction: 'SERVICE',
      pattern: '25GE-{n}',
      panelStart: 28,
      visual: { row: 1, x: 55.4, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
    },
    {
      groupKey: 'sfp28-25g-b',
      count: 12,
      connector: 'SFP28',
      type: 'SFP_PLUS',
      portFunction: 'SERVICE',
      pattern: '25GE-{n}',
      panelStart: 36,
      visual: { row: 1, x: 70.8, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
    },
    {
      groupKey: 'qsfp28-100g',
      count: 8,
      connector: 'QSFP28',
      type: 'QSFP',
      portFunction: 'UPLINK',
      pattern: '100GE-{n}',
      panelStart: 48,
      visual: { row: 1, x: 93.8, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
    },
  ],
};

/** S6730-H48X6C: 48×10GE + 6×QSFP28. */
const S6730: DeviceSpec = {
  catalogKey: 'huawei-s6730-h48x6c',
  model: 'S6730-H48X6C',
  assetId: 'asset-s6730',
  startU: 38,
  panelHeight: 10,
  groups: [
    {
      groupKey: 'sfpplus-10g',
      count: 48,
      connector: 'SFP_PLUS',
      type: 'SFP_PLUS',
      portFunction: 'SERVICE',
      pattern: '10GE-{n}',
      visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
    },
    {
      groupKey: 'qsfp28-uplink',
      count: 6,
      connector: 'QSFP28',
      type: 'QSFP',
      portFunction: 'UPLINK',
      pattern: 'QSFP28-{n}',
      visual: { row: 3, columns: 6, x: 38, y: 6.4, gapX: 0.6 },
    },
  ],
};

/** S6750-H48X8C: 48×SFP28 + 8×QSFP28 (sem imagem no projeto hoje). */
const S6750: DeviceSpec = {
  catalogKey: 'huawei-s6750-h48x8c',
  model: 'S6750-H48X8C',
  assetId: 'asset-s6750',
  startU: 36,
  panelHeight: 10,
  groups: [
    {
      groupKey: 'sfp28-service',
      count: 48,
      connector: 'SFP28',
      type: 'SFP_PLUS',
      portFunction: 'SERVICE',
      pattern: 'SFP28-{n}',
      visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
    },
    {
      groupKey: 'qsfp28-uplink',
      count: 8,
      connector: 'QSFP28',
      type: 'QSFP',
      portFunction: 'UPLINK',
      pattern: 'QSFP28-{n}',
      visual: { row: 3, columns: 8, x: 32, y: 6.4, gapX: 0.6 },
    },
  ],
};

/** Chassi X7 (fixture): slots do próprio manifesto + placa GPFD no slot de serviço. */
function x7Rack() {
  const map = modularChassisMap('huawei-ma5800-x7')!;
  const boardSlot = map.slots.find((slot) => slot.role === 'SERVICE_OR_UPLINK')!;
  const slotId = `x7-slot-${boardSlot.ordinal}`;
  const boardPorts = Array.from({ length: 16 }, (_value, index) =>
    physicalPort({
      id: `x7-gpon-${index + 1}`,
      assetId: 'asset-x7',
      slotId,
      moduleId: 'x7-module',
      name: `GPON-${index + 1}`,
      label: `GPON-${index + 1}`,
      order: index + 1,
      side: 'DEVICE',
      // FIBER → receptáculo óptico (PON), nunca RJ45
      type: 'FIBER',
    }),
  );
  const board = physicalModule({
    id: 'x7-module',
    assetId: 'asset-x7',
    slotId,
    slotIndex: boardSlot.ordinal,
    name: 'GPFD 16 portas GPON',
    model: 'H802GPFD',
    ports: boardPorts,
  });
  const asset = physicalAsset({
    id: 'asset-x7',
    name: 'OLT-X7',
    kind: 'OLT',
    startU: 20,
    heightU: 6,
    templateId: 'template-huawei-ma5800-x7',
    template: templateRef('huawei-ma5800-x7', 'MA5800-X7'),
    ports: boardPorts,
    modules: [board],
    slots: map.slots.map((mapped) => {
      const slot = physicalSlot({
        id: `x7-slot-${mapped.ordinal}`,
        assetId: 'asset-x7',
        index: mapped.ordinal,
        label: `Slot ${mapped.ordinal}`,
      });
      return mapped.ordinal === boardSlot.ordinal
        ? { ...slot, module: board, ports: boardPorts }
        : slot;
    }),
  });
  return physicalRack({ units: 42, assets: [asset] });
}

function renderRack(
  assets: ReturnType<typeof physicalAsset>[],
  options: {
    visualMode?: PhysicalVisualMode;
    catalog?: ReturnType<typeof catalogEntry>[];
    connections?: ReturnType<typeof physicalConnection>[];
    selection?: PhysicalSelection;
    showAnchors?: boolean;
    showSlots?: boolean;
    showBbox?: boolean;
    showModuleKeys?: boolean;
    slotFit?: (slotId: string) => { tone: 'ok' | 'bad'; reason?: string | null } | null;
    onRemoveModule?: (slotId: string) => void;
  } = {},
) {
  return renderToStaticMarkup(
    <PhysicalRackCanvas
      rack={physicalRack({ units: 42, assets })}
      connections={options.connections ?? []}
      mode="all"
      selection={options.selection ?? null}
      path={null}
      visualMode={options.visualMode ?? 'REAL'}
      catalog={options.catalog ?? []}
      showAnchors={options.showAnchors ?? false}
      showSlots={options.showSlots ?? false}
      showBbox={options.showBbox ?? false}
      showModuleKeys={options.showModuleKeys ?? false}
      slotFit={options.slotFit}
      onRemoveModule={options.onRemoveModule}
      onSelectAsset={noop}
      onSelectPort={noop}
      onSelectConnection={noop}
      onClear={noop}
    />,
  );
}

describe('visão técnica no rack canvas', () => {
  it('F1A: painel contínuo 0–55 em 28 colunas × 2 fileiras, com os 4 blocos', () => {
    const { entry, asset } = buildFixedDevice(F1A);

    const real = renderRack([asset], { catalog: [entry], visualMode: 'REAL' });
    expect(real).toContain('data-visual="REAL"');
    expect(real).toContain('ne8000-f1a-8h20q-front.png');

    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    // sem fotografia: o desenho é o painel geométrico
    expect(technical).not.toContain('ne8000-f1a-8h20q-front.png');
    expect(technical.match(/data-port-id=/g)).toHaveLength(56);
    expect(technical).toContain('10GE × 28');
    expect(technical).toContain('25GE × 8');
    expect(technical).toContain('25GE × 12');
    expect(technical).toContain('100GE × 8');
    // rótulo curto = número físico do painel (0–55, não 1–56)
    expect(technical).toContain('aria-label="Porta 10GE-0 (conector SFP+)"');
    expect(technical).toContain('aria-label="Porta 100GE-55 (conector QSFP28)"');
    expect(technical).toContain('class="physical-port__label"');
  });

  it('F1A: as baías anunciam a numeração física 0–27 / 28–35 / 36–47 / 48–55', () => {
    const { entry, asset } = buildFixedDevice(F1A);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    for (const range of ['0–27', '28–35', '36–47', '48–55']) {
      expect(html, range).toContain(`<b>${range}</b>`);
    }
    // uma única faixa: os quatro blocos no mesmo tom de topo das baías
    const tops = [...html.matchAll(/class="physical-fixed-bay [^"]*"[^>]*top:(\d+)px/g)].map(
      (match) => Number(match[1]),
    );
    expect(tops).toHaveLength(4);
    expect(new Set(tops).size).toBe(1);
    // nenhuma faixa de interface declarada (CLI do F1A vem por discovery)
    expect(html).not.toContain('physical-fixed-bay__interface');
  });

  it('S6730-H48X6C: 48×10GE + 6×QSFP28 no desenho técnico', () => {
    const { entry, asset } = buildFixedDevice(S6730);
    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    expect(technical).not.toContain('s6730-h48x6c-front.png');
    expect(technical.match(/data-port-id=/g)).toHaveLength(54);
    expect(technical).toContain('10GE × 48');
    expect(technical).toContain('QSFP28 × 6');
  });

  it('S6750-H48X8C: 48×SFP28 + 8×QSFP28 no desenho técnico', () => {
    const { entry, asset } = buildFixedDevice(S6750);
    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    expect(technical.match(/data-port-id=/g)).toHaveLength(56);
    expect(technical).toContain('SFP28 × 48');
    expect(technical).toContain('QSFP28 × 8');
  });

  it('MA5800-X7: chassi, slots e placa desenhados sem fotografia', () => {
    const rack7 = x7Rack();
    const real = renderRack([...rack7.assets], { visualMode: 'REAL' });
    expect(real).toContain('huawei-ma5800-x7-front.png');
    expect(real).toContain('huawei-gpfd-16-gpon-front.png');

    const technical = renderRack([...rack7.assets], { visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    // chassis sem foto, mas com os slots do mapa
    expect(technical).not.toContain('huawei-ma5800-x7-front.png');
    expect(technical).toContain('data-chassis-panel="huawei-ma5800-x7"');
    expect(technical.match(/data-slot-key=/g)).toHaveLength(6);
    // papel do slot legível
    expect(technical).toContain('Slot 1 · Serviço/Uplink');
    // placa desenhada pelo renderer geométrico, com legenda e hotspots
    expect(technical).not.toContain('huawei-gpfd-16-gpon-front.png');
    expect(technical).toContain('GPON × 16');
    expect(technical.match(/data-port-id="x7-gpon-/g)).toHaveLength(16);
    expect(technical).toContain('data-port-id="x7-gpon-1"');
    // PON óptico: receptáculo com classe própria, nunca RJ45
    expect(technical.match(/class="[^"]*physical-port--pon/g)).toHaveLength(16);
    expect(technical).not.toContain('physical-port--rj45');
    // acento de papel nos slots + slots vazios operacionais
    expect(technical).toContain('role-service');
    expect(technical).toContain('>Vazio<');
  });

  it('S6730-H24X6C: 24×10GE + 6×QSFP28 no desenho técnico', () => {
    const { entry, asset } = buildFixedDevice({
      catalogKey: 'huawei-s6730-h24x6c',
      model: 'S6730-H24X6C',
      assetId: 'asset-h24',
      startU: 38,
      panelHeight: 8,
      groups: [
        {
          groupKey: 'sfpplus-10g',
          count: 24,
          connector: 'SFP_PLUS',
          type: 'SFP_PLUS',
          portFunction: 'SERVICE',
          pattern: '10GE-{n}',
          visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
        },
        {
          groupKey: 'qsfp28-uplink',
          count: 6,
          connector: 'QSFP28',
          type: 'QSFP',
          portFunction: 'UPLINK',
          pattern: 'QSFP28-{n}',
          visual: { row: 3, columns: 6, x: 38, y: 6.4, gapX: 0.6 },
        },
      ],
    });
    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    expect(technical.match(/data-port-id=/g)).toHaveLength(30);
    expect(technical).toContain('10GE × 24');
    expect(technical).toContain('QSFP28 × 6');
  });

  it('S6750-H36C: 32×QSFP28 + 4×QSFP28 com ordinais contínuos (33–36)', () => {
    const { entry, asset, ports } = buildFixedDevice({
      catalogKey: 'huawei-s6750-h36c',
      model: 'S6750-H36C',
      assetId: 'asset-h36c',
      startU: 38,
      panelHeight: 8,
      groups: [
        {
          groupKey: 'qsfp28-service',
          count: 32,
          connector: 'QSFP28',
          type: 'QSFP',
          portFunction: 'SERVICE',
          pattern: 'QSFP28-{n}',
          visual: { row: 1, columns: 16, x: 4, y: 0.6, gapX: 0.8 },
        },
        {
          groupKey: 'qsfp28-uplink',
          count: 4,
          connector: 'QSFP28',
          type: 'QSFP',
          portFunction: 'UPLINK',
          pattern: 'QSFP28-{n+32}',
          visual: { row: 3, columns: 4, x: 58, y: 6.4, gapX: 0.8 },
        },
      ],
    });
    expect(ports.map((port) => port.name)).toEqual([
      ...Array.from({ length: 32 }, (_v, index) => `QSFP28-${index + 1}`),
      'QSFP28-33',
      'QSFP28-34',
      'QSFP28-35',
      'QSFP28-36',
    ]);
    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    expect(technical.match(/data-port-id=/g)).toHaveLength(36);
    expect(technical).toContain('QSFP28 × 32');
    expect(technical).toContain('QSFP28 × 4');
  });

  it('NE8000-M8: slots de linha com acento de papel, caso B e vazios', () => {
    const map = modularChassisMap('huawei-ne8000-m8-dc')!;
    const boardSlot = map.slots.find((slot) => slot.role === 'SERVICE')!;
    const slotId = `m8-slot-${boardSlot.ordinal}`;
    const board = physicalModule({
      id: 'm8-module',
      assetId: 'asset-m8',
      slotId,
      slotIndex: boardSlot.ordinal,
      name: 'Placa de linha genérica',
      model: 'sem mapa frontal',
      ports: [],
    });
    const asset = physicalAsset({
      id: 'asset-m8',
      name: 'ROUTER-M8',
      kind: 'NETWORK',
      startU: 1,
      heightU: 3,
      templateId: 'template-huawei-ne8000-m8-dc',
      template: templateRef('huawei-ne8000-m8-dc', 'NetEngine 8000 M8 (DC)'),
      ports: [],
      modules: [board],
      slots: map.slots.map((mapped) => {
        const slot = physicalSlot({
          id: `m8-slot-${mapped.ordinal}`,
          assetId: 'asset-m8',
          index: mapped.ordinal,
          label: `Slot ${mapped.ordinal}`,
        });
        return mapped.ordinal === boardSlot.ordinal ? { ...slot, module: board } : slot;
      }),
    });
    const technical = renderRack([asset], { visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    expect(technical).toContain('data-chassis-panel="huawei-ne8000-m8-dc"');
    expect(technical.match(/data-slot-key=/g)).toHaveLength(8);
    // papel SERVICE → acento azul
    expect(technical.match(/role-service/g)?.length ?? 0).toBe(8);
    // slot vazio: estado operacional sem geometria inventada
    expect(technical.match(/>Vazio</g)).toHaveLength(7);
    // placa sem mapa frontal: badge honesto e nenhuma porta inventada
    expect(technical).toContain('Mapa frontal não disponível');
    expect(technical).not.toContain('data-port-id=');
  });

  it('MA5683T: sem estrutura de slots no catálogo, nota honesta na visão técnica', () => {
    const asset = physicalAsset({
      id: 'asset-ma5683t',
      name: 'OLT-MA5683T',
      kind: 'OLT',
      startU: 20,
      heightU: 1,
      templateId: 'template-huawei-ma5683t',
      template: templateRef('huawei-ma5683t', 'MA5683T'),
    });
    const real = renderRack([asset], { visualMode: 'REAL' });
    // fotografia continua valendo no modo real
    expect(real).toContain('huawei-ma5683t-front.png');

    const technical = renderRack([asset], { visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    expect(technical).toContain('data-chassis-panel="huawei-ma5683t"');
    expect(technical).toContain('data-slot-count="0"');
    expect(technical).toContain('Estrutura de slots não confirmada no catálogo');
    expect(technical.match(/data-slot-key=/g)).toBeNull();
  });

  it('slot vazio mostra módulos compatíveis declarados pelo catálogo', () => {
    const rack7 = x7Rack();
    const entry = catalogEntry({
      catalogKey: 'huawei-ma5800-x7',
      name: 'Huawei MA5800-X7',
      manufacturer: 'Huawei',
      family: 'MA5800',
      model: 'MA5800-X7',
      kind: 'OLT',
      heightU: 6,
      slots: Array.from({ length: 6 }, (_v, index) => ({
        index: index + 1,
        label: `Slot ${index + 1}`,
        description: '',
        moduleKeys: ['huawei-gpfd-16-gpon'],
        slotRole: index === 0 ? 'SERVICE_OR_UPLINK' : 'UNIVERSAL',
        groupKey: null,
        capacityNote: null,
        visual: null,
      })),
      modules: [
        {
          key: 'huawei-gpfd-16-gpon',
          name: 'GPFD 16 portas GPON',
          model: 'H802GPFD',
          partNumber: 'H802GPFD',
          description: '',
          slotsRequired: 1,
          vendorVerified: false,
          ports: [],
        },
      ],
    });
    const technical = renderRack([...rack7.assets], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
    });
    expect(technical).toContain('compatível: H802GPFD');
  });

  it('placeholder de família sem painel exato continua no modo real', () => {
    const { entry, asset } = buildFixedDevice({
      ...S6730,
      catalogKey: 'huawei-s6720-family',
      model: 'S6720 (família)',
      assetId: 'asset-s6720-family',
    });
    const html = renderRack([asset], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
    });
    expect(html).toContain('data-visual="REAL"');
    expect(html).not.toContain('physical-port__label');
  });

  it('no modo técnico a âncora do cabo continua no conector desenhado', () => {
    const { entry, asset } = buildFixedDevice(S6730);
    const other = physicalAsset({
      id: 'asset-other',
      name: 'SW-02',
      startU: 30,
      heightU: 1,
      ports: [
        physicalPort({
          id: 'asset-other-port',
          assetId: 'asset-other',
          name: 'GE1',
          connectionId: 'conn-tech',
          state: 'CONNECTED',
        }),
      ],
    });
    const connection = physicalConnection({
      id: 'conn-tech',
      portAId: 'asset-s6730-10GE-1',
      portBId: 'asset-other-port',
      a: {
        portId: 'asset-s6730-10GE-1',
        portName: '10GE-1',
        side: 'DEVICE',
        assetId: 'asset-s6730',
        assetName: 'S6730-H48X6C',
        rackId: 'rack-1',
        rackName: 'Rack 01',
        siteId: 'site-1',
        siteName: 'POP Centro',
      },
      b: {
        portId: 'asset-other-port',
        portName: 'GE1',
        side: 'DEVICE',
        assetId: 'asset-other',
        assetName: 'SW-02',
        rackId: 'rack-1',
        rackName: 'Rack 01',
        siteId: 'site-1',
        siteName: 'POP Centro',
      },
    });
    const html = renderRack([asset, other], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      connections: [connection],
    });
    const button = /<button[^>]*data-port-id="asset-s6730-10GE-1"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).not.toBe('');
    const style = /style="([^"]+)"/.exec(button)?.[1] ?? '';
    const value = (name: string) =>
      Number(new RegExp(`${name}:\\s*(-?[\\d.]+)(?:px)?`).exec(style)?.[1] ?? Number.NaN);
    const articleStyle =
      /<article[^>]*data-asset-id="asset-s6730"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const panelStyle =
      /<div class="physical-faceplate__panel"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const offset = (source: string, name: string) =>
      Number(new RegExp(`${name}:\\s*(-?[\\d.]+)(?:px)?`).exec(source)?.[1] ?? Number.NaN);
    const offsetX = offset(articleStyle, 'left') + offset(panelStyle, 'left');
    const offsetY = offset(articleStyle, 'top') + offset(panelStyle, 'top');
    const cable = /<path[^>]*d="M ([\d.]+) ([\d.]+)[^>]*class="physical-cable /.exec(html);
    expect(cable).not.toBeNull();
    const expectedX = offsetX + value('left') + value('width') / 2;
    const expectedY = offsetY + value('top') + value('height') / 2;
    expect(Math.abs(Number(cable![1]) - expectedX)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(cable![2]) - expectedY)).toBeLessThanOrEqual(1);
  });

  it('no modo técnico os cabos continuam desenháveis (local e ponta remota)', () => {
    const { entry, asset } = buildFixedDevice(S6730);
    const remote = physicalConnection({
      id: 'conn-remote-tech',
      portAId: 'asset-s6730-10GE-2',
      portBId: 'port-remote',
      a: {
        portId: 'asset-s6730-10GE-2',
        portName: '10GE-2',
        side: 'DEVICE',
        assetId: 'asset-s6730',
        assetName: 'S6730-H48X6C',
        rackId: 'rack-1',
        rackName: 'Rack 01',
        siteId: 'site-1',
        siteName: 'POP A',
      },
      b: {
        portId: 'port-remote',
        portName: '100GE-2',
        side: 'DEVICE',
        assetId: 'asset-remote',
        assetName: 'SW-CBF-MPLS-01',
        rackId: 'rack-9',
        rackName: 'Rack 02',
        siteId: 'site-2',
        siteName: 'POP Cabo Frio',
      },
    });
    const html = renderRack([asset], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      connections: [remote],
    });
    expect(html).toContain('physical-cable-endpoint is-external');
    expect(html).toContain('FIBRA EXTERNA');
    expect(html).toContain('class="physical-cable physical-cable--fiber');
  });

  it('regressão: F1A continua com 56 hotspots nos dois modos', () => {
    const { entry, asset } = buildFixedDevice(F1A);
    const real = renderRack([asset], { catalog: [entry], visualMode: 'REAL' });
    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(real.match(/data-port-name=/g)).toHaveLength(56);
    expect(technical.match(/data-port-id=/g)).toHaveLength(56);
  });
});

/**
 * Slot Lab: encaixe real (bbox do mapa → placa → portas → âncora), orientação
 * declarada pelo mapa e módulos declarados pelo catálogo. Nada é inventado.
 */
describe('slot lab (encaixe real e orientação)', () => {
  /** Instala módulos pelo mesmo caminho da bancada (recusa incompatível). */
  function installAll(catalogKey: string, installs: Array<[number, string]>) {
    let state: SlotLabState = {};
    for (const [ordinal, moduleKey] of installs) {
      const result = tryInstallModule(state, catalogKey, ordinal, moduleKey);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    return { asset: buildSlotLabAsset(catalogKey, state), entry: buildSlotLabCatalog(catalogKey, state) };
  }

  const num = (source: string, name: string) =>
    Number(new RegExp(`${name}:\\s*(-?[\\d.]+)(?:px)?`).exec(source)?.[1] ?? Number.NaN);
  const pct = (source: string, name: string) =>
    Number(new RegExp(`${name}:\\s*(-?[\\d.]+)%`).exec(source)?.[1] ?? Number.NaN);

  it('X2/X7/M4 declaram slots horizontais; X15/X17/M8 verticais', () => {
    const cases: Array<[string, 'HORIZONTAL' | 'VERTICAL']> = [
      ['huawei-ma5800-x2', 'HORIZONTAL'],
      ['huawei-ma5800-x7', 'HORIZONTAL'],
      ['huawei-ne8000-m4', 'HORIZONTAL'],
      ['huawei-ma5800-x15', 'VERTICAL'],
      ['huawei-ma5800-x17', 'VERTICAL'],
      ['huawei-ne8000-m8-dc', 'VERTICAL'],
    ];
    for (const [catalogKey, orientation] of cases) {
      // sem módulo instalado: o slot vazio continua desenhado na orientação do mapa
      const html = renderRack([buildSlotLabAsset(catalogKey, {})], {
        catalog: [buildSlotLabCatalog(catalogKey, {})],
        visualMode: 'TECHNICAL',
      });
      const orientations = new Set(html.match(/data-slot-orientation="(\w+)"/g) ?? []);
      expect(orientations).toEqual(new Set([`data-slot-orientation="${orientation}"`]));
      expect(html).not.toContain('data-port-id=');
    }
  });

  it('placa instalada em slot vertical gira 90° e mantém as 16 portas legíveis', () => {
    for (const catalogKey of [
      'huawei-ma5800-x2',
      'huawei-ma5800-x7',
      'huawei-ma5800-x15',
      'huawei-ma5800-x17',
    ]) {
      const { asset, entry } = installAll(catalogKey, [[1, 'huawei-gpfd-16']]);
      const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
      const vertical = catalogKey === 'huawei-ma5800-x15' || catalogKey === 'huawei-ma5800-x17';

      expect(html).toContain(`data-module-rotation="${vertical ? 90 : 0}"`);
      expect(html.match(/data-port-id=/g)).toHaveLength(16);
      expect(html.includes('is-vertical-module')).toBe(vertical);
      expect(html.includes('rotate(90deg)')).toBe(vertical);
      // porta desenhada nunca abaixo do mínimo clicável (7px)
      const widths = [...html.matchAll(/data-port-id="[^"]+"[^>]*style="[^"]*width:(\d+)px/g)].map(
        (match) => Number(match[1]),
      );
      expect(widths.length).toBeGreaterThan(0);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(7);
    }
  });

  it('placa vertical: a âncora do cabo coincide com o centro do conector girado', () => {
    const { asset, entry } = installAll('huawei-ma5800-x15', [[1, 'huawei-gpfd-16']]);
    const port = asset.ports.find((candidate) => candidate.name === 'GPON-1')!;
    const other = physicalAsset({
      id: 'asset-remote',
      name: 'BHE-VTA-01',
      startU: 30,
      heightU: 1,
      ports: [
        physicalPort({
          id: 'asset-remote-port',
          assetId: 'asset-remote',
          name: 'GE1',
        }),
      ],
    });
    const connection = physicalConnection({
      id: 'conn-vertical',
      portAId: port.id,
      portBId: 'asset-remote-port',
      a: {
        portId: port.id,
        portName: port.name,
        side: 'DEVICE',
        assetId: asset.id,
        assetName: asset.name,
        rackId: 'rack-1',
        rackName: 'Rack 01',
        siteId: 'site-1',
        siteName: 'POP Centro',
      },
      b: {
        portId: 'asset-remote-port',
        portName: 'GE1',
        side: 'DEVICE',
        assetId: 'asset-remote',
        assetName: 'BHE-VTA-01',
        rackId: 'rack-1',
        rackName: 'Rack 01',
        siteId: 'site-1',
        siteName: 'POP Centro',
      },
    });
    const html = renderRack([asset, other], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      connections: [connection],
      showAnchors: true,
    });

    // âncora: círculo do mesmo portId na camada de debug
    const dot = new RegExp(`<circle[^>]*data-anchor-port="${port.id}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(dot).not.toBe('');
    const anchorX = Number(/cx="([\d.]+)"/.exec(dot)?.[1] ?? Number.NaN);
    const anchorY = Number(/cy="([\d.]+)"/.exec(dot)?.[1] ?? Number.NaN);

    // desenho: mesma cadeia de caixas usada pelo canvas (artigo → painel → área →
    // slot → contêiner girado → porta) — a conta do CSS rotate(90deg) é a mesma
    // função usada pela âncora.
    const articleStyle =
      new RegExp(`<article[^>]*data-asset-id="${SLOT_LAB_ASSET_ID}"[^>]*style="([^"]+)"`).exec(html)?.[1] ??
      '';
    const panelStyle =
      /<div class="physical-faceplate__panel"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const areaStyle =
      /<div class="physical-modular-panel-area"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const slotTag =
      /<div class="physical-modular-panel__slot[^>]*data-slot-ordinal="1"[^>]*>/.exec(html)?.[0] ?? '';
    const slotStyle = /style="([^"]+)"/.exec(slotTag)?.[1] ?? '';
    const modulePanelTag =
      /<div class="physical-modular-panel__module-panel is-vertical-module"[^>]*>/.exec(html)?.[0] ??
      '';
    const moduleStyle = /style="([^"]+)"/.exec(modulePanelTag)?.[1] ?? '';
    const buttonTag = new RegExp(`<button[^>]*data-port-id="${port.id}"[^>]*>`).exec(html)?.[0] ?? '';
    const buttonStyle = /style="([^"]+)"/.exec(buttonTag)?.[1] ?? '';

    const areaWidth = num(areaStyle, 'width');
    const areaHeight = num(areaStyle, 'height');
    const originX = num(articleStyle, 'left') + num(panelStyle, 'left') + num(areaStyle, 'left');
    const originY = num(articleStyle, 'top') + num(panelStyle, 'top') + num(areaStyle, 'top');
    const slotX = (pct(slotStyle, 'left') / 100) * areaWidth;
    const slotY = (pct(slotStyle, 'top') / 100) * areaHeight;
    const containerLeft = num(moduleStyle, 'left');
    const containerTop = num(moduleStyle, 'top');
    // rotate(90deg) com origem 0 0: (u, v) → (origemX - v, origemY + u)
    const visualX = originX + slotX + containerLeft - (num(buttonStyle, 'top') + num(buttonStyle, 'height') / 2);
    const visualY =
      originY + slotY + containerTop + (num(buttonStyle, 'left') + num(buttonStyle, 'width') / 2);

    // 2px de tolerância: o desenho arredonda width/height e nunca desce de 7px
    expect(Math.abs(anchorX - visualX)).toBeLessThanOrEqual(2);
    expect(Math.abs(anchorY - visualY)).toBeLessThanOrEqual(2);
    // e o cabo começa exatamente nessa âncora
    const cable = /<path[^>]*d="M ([\d.]+) ([\d.]+)[^>]*class="physical-cable /.exec(html);
    expect(cable).not.toBeNull();
    expect(Math.abs(Number(cable![1]) - anchorX)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(Number(cable![2]) - anchorY)).toBeLessThanOrEqual(1.5);
    // a âncora é de uma porta específica (perto da ponta da placa), não do centro do slot
    const slotHeight = (pct(slotStyle, 'height') / 100) * areaHeight;
    const slotCenterY = originY + slotY + slotHeight / 2;
    expect(Math.abs(anchorY - slotCenterY)).toBeGreaterThan(20);
  });

  it('slot vazio não inventa porta: placa cega e nenhum conector', () => {
    const { asset, entry } = installAll('huawei-ma5800-x7', []);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    expect(html).toContain('physical-modular-panel__blank');
    expect(html).toContain('>Vazio<');
    expect(html).not.toContain('data-port-id=');
    expect(html.match(/data-slot-state="EMPTY"/g)).toHaveLength(6);
  });

  it('módulo instalado desenha somente as portas declaradas no catálogo', () => {
    const mpla = installAll('huawei-ma5800-x2', [[1, 'huawei-h902mpla']]);
    const mplaHtml = renderRack([mpla.asset], { catalog: [mpla.entry], visualMode: 'TECHNICAL' });
    expect(mplaHtml.match(/data-port-id=/g)).toHaveLength(4);
    expect(mplaHtml).toContain('UPLINK-1');

    // MPSC é slot de controle no mapa do X2 (slot 3)
    const mpsc = installAll('huawei-ma5800-x2', [[3, 'huawei-h901mpsc']]);
    const mpscHtml = renderRack([mpsc.asset], { catalog: [mpsc.entry], visualMode: 'TECHNICAL' });
    expect(mpscHtml.match(/data-port-id=/g)).toHaveLength(7);
    expect(mpscHtml).toContain('data-slot-role="CONTROL"');
    expect(mpscHtml).toContain('physical-port--console');
    expect(mpscHtml).toContain('physical-port--mgmt');
  });

  it('GPON e XGS-PON usam visual óptico e nunca RJ45', () => {
    const xgspon = installAll('huawei-ma5800-x2', [[1, 'huawei-xgspon-16']]);
    const html = renderRack([xgspon.asset], { catalog: [xgspon.entry], visualMode: 'TECHNICAL' });
    expect(html.match(/physical-port--pon/g)).toHaveLength(16);
    expect(html).not.toContain('physical-port--rj45');
  });

  it('módulo incompatível é recusado com motivo (não é desenhado)', () => {
    // PAC600S12-CB é fonte: nenhum slot mapeado aceita fonte no mapa atual.
    const result = tryInstallModule({}, 'huawei-ma5800-x2', 1, 'huawei-pac600s12-cb');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Incompatível');
    expect(result.state).toEqual({});
    const html = renderRack([buildSlotLabAsset('huawei-ma5800-x2', {})], {
      catalog: [buildSlotLabCatalog('huawei-ma5800-x2', {})],
      visualMode: 'TECHNICAL',
    });
    expect(html).not.toContain('PAC600S12-CB');
  });

  it('modo real continua com as fotografias e sem rotação', () => {
    const { asset, entry } = installAll('huawei-ma5800-x15', [[1, 'huawei-gpfd-16']]);
    const real = renderRack([asset], { catalog: [entry], visualMode: 'REAL' });
    expect(real).toContain('huawei-ma5800-x15-front.png');
    expect(real).toContain('huawei-gpfd-16-gpon-front.png');
    expect(real).toContain('data-module-rotation="0"');
    expect(real).not.toContain('rotate(90deg)');

    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(technical).not.toContain('huawei-ma5800-x15-front.png');
    expect(technical).not.toContain('huawei-gpfd-16-gpon-front.png');
  });

  it('porta continua clicável e mantém estado/LLDP/seleção', () => {
    const { asset, entry } = installAll('huawei-ma5800-x7', [[1, 'huawei-gpfd-16']]);
    const first = asset.modules[0]!.ports[0]!;
    const patch = (ports: PhysicalPort[]) =>
      ports.map((port) =>
        port.id === first.id
          ? {
              ...port,
              state: 'CONNECTED' as const,
              lldp: {
                adjacencyId: 'adj-1',
                remoteHostname: 'BHE-VTA-01',
                remotePortName: 'GE1/0/1',
                confidence: 'HIGH',
                resolved: true,
                ambiguous: false,
                source: 'lldp',
                observedAt: '2026-09-23T12:00:00.000Z',
              },
            }
          : port,
      );
    const patched: PhysicalAsset = {
      ...asset,
      ports: patch(asset.ports),
      modules: asset.modules.map((module) => ({ ...module, ports: patch(module.ports) })),
      slots: asset.slots.map((slot) =>
        slot.module ? { ...slot, module: { ...slot.module, ports: patch(slot.module.ports) } } : slot,
      ),
    };
    const html = renderRack([patched], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      selection: { kind: 'port', id: first.id },
    });

    const button = new RegExp(`<button[^>]*data-port-id="${first.id}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(button).toContain('type="button"');
    expect(button).toContain('state-connected');
    expect(button).toContain('is-selected');
    expect(button).toContain('LLDP BHE-VTA-01/GE1/0/1');
  });

  it('toggles de debug expõem slots, bbox e moduleKeys do catálogo', () => {
    const { asset, entry } = installAll('huawei-ma5800-x7', [[1, 'huawei-gpfd-16']]);
    const html = renderRack([asset], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      showSlots: true,
      showBbox: true,
      showModuleKeys: true,
    });

    expect(html).toContain('is-slots-visible');
    expect(html).toContain('is-bbox-visible');
    expect(html).toContain('physical-modular-panel__slot-keys');
    expect(html).toContain('huawei-xgspon-16');
    expect(html).toContain('data-slot-key=');
  });
});

/**
 * Segunda passada (referência visual correta): cabeçalho de chassi, moldura de
 * placa (ModuleShell), blank panel e realce de encaixe do LAB. Tudo aparência:
 * geometria, âncoras e interação continuam os mesmos.
 */
describe('chrome técnico do chassi e da placa', () => {
  function installAll(catalogKey: string, installs: Array<[number, string]>) {
    let state: SlotLabState = {};
    for (const [ordinal, moduleKey] of installs) {
      const result = tryInstallModule(state, catalogKey, ordinal, moduleKey);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    return { asset: buildSlotLabAsset(catalogKey, state), entry: buildSlotLabCatalog(catalogKey, state) };
  }

  it('cabeçalho técnico: marca, LEDs rotulados, chip de U e resumo do chassi', () => {
    const { asset, entry } = installAll('huawei-ma5800-x7', [[1, 'huawei-gpfd-16']]);
    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    expect(technical).toContain('physical-technical-brand');
    expect(technical).toContain('physical-technical-leds');
    expect(technical).toContain('>PWR<');
    expect(technical).toContain('>ALM<');
    expect(technical).toContain('>ACT<');
    expect(technical).toContain('physical-technical-u');
    expect(technical).toContain('physical-technical-summary');
    expect(technical).toContain('serviço/uplink');

    // modo real não ganha cabeçalho técnico
    const real = renderRack([asset], { catalog: [entry], visualMode: 'REAL' });
    expect(real).not.toContain('physical-technical-leds');
    expect(real).not.toContain('physical-technical-summary');
  });

  it('ModuleShell: moldura com código, LEDs e ejetor só onde há folga', () => {
    const horizontal = installAll('huawei-ma5800-x7', [[1, 'huawei-gpfd-16']]);
    const html = renderRack([horizontal.asset], {
      catalog: [horizontal.entry],
      visualMode: 'TECHNICAL',
    });

    expect(html).toContain('data-module-category="service"');
    expect(html).toContain('data-module-code="H802GPFD"');
    expect(html).toContain('physical-module-shell__label');
    expect(html).toContain('physical-module-shell__leds');
    expect(html).toContain('>RUN<');
    // a moldura é camada de aparência: as portas continuam no contêiner
    expect(html.match(/data-port-id=/g)).toHaveLength(16);
    expect(html).toContain('data-module-chrome=');

    // modo real continua sem moldura desenhada
    const real = renderRack([horizontal.asset], {
      catalog: [horizontal.entry],
      visualMode: 'REAL',
    });
    expect(real).not.toContain('physical-module-shell');
  });

  it('placa vertical usa a moldura vertical e o código no eixo do slot', () => {
    const vertical = installAll('huawei-ma5800-x15', [[1, 'huawei-gpfd-16']]);
    const html = renderRack([vertical.asset], {
      catalog: [vertical.entry],
      visualMode: 'TECHNICAL',
    });

    expect(html).toContain('physical-module-shell is-vertical');
    expect(html).toContain('data-module-code="H802GPFD"');
    expect(html.match(/data-port-id=/g)).toHaveLength(16);
  });

  it('realce de encaixe do LAB marca compatível e incompatível com motivo', () => {
    const { asset, entry } = installAll('huawei-ma5800-x7', []);
    const html = renderRack([asset], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      slotFit: (slotId) => {
        const ordinal = Number(/slot-(\d+)$/.exec(slotId)?.[1] ?? Number.NaN);
        if (!Number.isFinite(ordinal)) return null;
        return ordinal === 0 ? { tone: 'ok' } : { tone: 'bad', reason: 'aceita huawei-gpfd-16' };
      },
    });

    expect(html).toContain('data-slot-fit="ok"');
    expect(html).toContain('data-slot-fit="bad"');
    expect(html).toContain('is-fit-ok');
    expect(html).toContain('is-fit-bad');
    expect(html).toContain('physical-slot-reason');
    expect(html).toContain('aceita huawei-gpfd-16');
    // armado não pode virar porta nem módulo: nada além do realce
    expect(html).not.toContain('data-port-id=');

    // sem a função do LAB, nenhum realce é desenhado
    const plain = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(plain).not.toContain('data-slot-fit');
    expect(plain).not.toContain('is-fit-ok');
  });

  it('o botão de remover placa só existe quando o LAB fornece a ação', () => {
    const { asset, entry } = installAll('huawei-ma5800-x7', [[1, 'huawei-gpfd-16']]);
    const withAction = renderRack([asset], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      onRemoveModule: () => undefined,
    });
    expect(withAction).toContain('physical-modular-panel__slot-remove');
    expect(withAction).toContain('aria-label="Remover H802GPFD');

    const withoutAction = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(withoutAction).not.toContain('physical-modular-panel__slot-remove');
  });

  it('slot vazio continua sendo placa cega com código do papel (sem porta)', () => {
    const { asset, entry } = installAll('huawei-ma5800-x7', []);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    expect(html).toContain('physical-modular-panel__blank');
    expect(html.match(/data-slot-state="EMPTY"/g)).toHaveLength(6);
    expect(html).not.toContain('data-port-id=');
    expect(html).not.toContain('physical-module-shell');
  });
});

/**
 * Terceira passada: faceplate dos equipamentos FIXOS (baías por grupo, rodapé
 * de marca/LEDs, ventilação) e a regra dura de **nenhuma fotografia** no modo
 * técnico. Tudo aparência: portas, conectores, âncoras e contagem intactos.
 */
describe('faceplate fixo e política de fotografia (modo técnico)', () => {
  const H36C: DeviceSpec = {
    catalogKey: 'huawei-s6750-h36c',
    model: 'S6750-H36C',
    assetId: 'asset-face-h36c',
    startU: 38,
    panelHeight: 8,
    groups: [
      {
        groupKey: 'qsfp28-service',
        count: 32,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'SERVICE',
        pattern: 'QSFP28-{n}',
        visual: { row: 1, columns: 16, x: 4, y: 0.6, gapX: 0.8 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 4,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n+32}',
        visual: { row: 3, columns: 4, x: 58, y: 6.4, gapX: 0.8 },
      },
    ],
  };

  it('H36C: baías SERVICE 1–32 / UPLINK 33–36, rodapé e ventilação (36 portas)', () => {
    const { entry, asset } = buildFixedDevice(H36C);
    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    // nada de porta mudou
    expect(technical.match(/data-port-id=/g)).toHaveLength(36);
    expect(technical).toContain('physical-fixed-frame');
    expect(technical.match(/class="physical-fixed-bay /g)).toHaveLength(2);
    expect(technical).toContain('data-bay-role="service"');
    expect(technical).toContain('data-bay-role="uplink"');
    expect(technical).toContain('data-bay-key="qsfp28-service"');
    expect(technical).toContain('data-bay-key="qsfp28-uplink"');
    // rótulo do grupo com a faixa REAL de numeração do catálogo
    expect(technical).toContain('SERVICE<b>1–32</b>');
    expect(technical).toContain('UPLINK<b>33–36</b>');
    // rodapé com marca/modelo/LEDs/resumo e área de ventilação
    expect(technical).toContain('physical-fixed-footer');
    expect(technical).toContain('S6750-H36C');
    expect(technical).toContain('physical-fixed-vent');
    expect(technical).toContain('physical-technical-leds');
    expect(technical).not.toContain('physical-image-panel__image');
  });

  it('H36C: a baía de uplink fica depois da baía de serviço (sem sobreposição)', () => {
    const { entry, asset } = buildFixedDevice(H36C);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    const bayTop = (key: string) => {
      const match = new RegExp(`data-bay-key="${key}"[^>]*style="([^"]*)"`).exec(html);
      const top = /top:\s*(-?\d+)px/.exec(match?.[1] ?? '');
      return Number(top?.[1] ?? Number.NaN);
    };
    expect(bayTop('qsfp28-uplink')).toBeGreaterThan(bayTop('qsfp28-service'));
  });

  it('F1A: quatro baías na ordem física do catálogo, sem mexer nas 56 portas', () => {
    const { entry, asset } = buildFixedDevice(F1A);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    expect(html.match(/data-port-id=/g)).toHaveLength(56);
    expect(html.match(/data-bay-key=/g)).toHaveLength(4);
    const order = [
      'data-bay-key="sfpplus-10g"',
      'data-bay-key="sfp28-25g-a"',
      'data-bay-key="sfp28-25g-b"',
      'data-bay-key="qsfp28-100g"',
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(html.indexOf(order[index - 1]!)).toBeLessThan(html.indexOf(order[index]!));
    }
    expect(html).toContain('SERVICE<b>0–27</b>');
    expect(html).toContain('SERVICE<b>28–35</b>');
    expect(html).toContain('SERVICE<b>36–47</b>');
    expect(html).toContain('UPLINK<b>48–55</b>');
  });

  it('S6730-H48X6C: baía de serviço (1–48) e de uplink (1–6)', () => {
    const { entry, asset } = buildFixedDevice(S6730);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    expect(html.match(/data-port-id=/g)).toHaveLength(54);
    expect(html).toContain('SERVICE<b>1–48</b>');
    expect(html).toContain('UPLINK<b>1–6</b>');
  });

  it('o modo real do equipamento fixo fica sem baías, rodapé e ventilação', () => {
    const { entry, asset } = buildFixedDevice(H36C);
    const real = renderRack([asset], { catalog: [entry], visualMode: 'REAL' });

    expect(real).toContain('data-visual="REAL"');
    expect(real).not.toContain('physical-fixed-bay');
    expect(real).not.toContain('physical-fixed-footer');
    expect(real).not.toContain('physical-fixed-vent');
    expect(real).not.toContain('SERVICE<b>1–32</b>');
    expect(real.match(/data-port-id=/g)).toHaveLength(36);
  });

  it('no modo técnico nenhuma fotografia de chassi é usada (fixo e modular)', () => {
    // S6730-H48X6C tem foto no pacote real → no técnico ela é descartada
    const fixed = buildFixedDevice(S6730);
    const realPhoto = renderRack([fixed.asset], {
      catalog: [fixed.entry],
      visualMode: 'REAL',
    });
    expect(realPhoto).toContain('s6730-h48x6c');
    const technicalFixed = renderRack([fixed.asset], {
      catalog: [fixed.entry],
      visualMode: 'TECHNICAL',
    });
    expect(technicalFixed).not.toContain('physical-image-panel');
    expect(technicalFixed).not.toContain('-front.png');

    // modular: mesmo com foto disponível, o técnico desenha o chassi geométrico
    const modular = buildSlotLabAsset('huawei-ma5800-x2', {});
    const modularEntry = buildSlotLabCatalog('huawei-ma5800-x2', {});
    const technicalModular = renderRack([modular], {
      catalog: [modularEntry],
      visualMode: 'TECHNICAL',
    });
    expect(technicalModular).not.toContain('physical-modular-panel__image');
    expect(technicalModular).toContain('data-chassis-panel="huawei-ma5800-x2"');
  });

  it('a âncora do cabo continua no centro do conector desenhado com as baías', () => {
    const { entry, asset } = buildFixedDevice(H36C);
    const last = asset.ports.find((port) => port.name === 'QSFP28-36')!;
    const other = physicalAsset({
      id: 'asset-face-other',
      name: 'SW-02',
      startU: 30,
      heightU: 1,
      ports: [
        physicalPort({
          id: 'asset-face-other-port',
          assetId: 'asset-face-other',
          name: 'GE1',
          connectionId: 'conn-face',
          state: 'CONNECTED',
        }),
      ],
    });
    const html = renderRack([asset, other], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      connections: [
        physicalConnection({
          id: 'conn-face',
          portAId: last.id,
          portBId: 'asset-face-other-port',
          a: {
            portId: last.id,
            portName: 'QSFP28-36',
            side: 'DEVICE',
            assetId: 'asset-face-h36c',
            assetName: 'S6750-H36C',
            rackId: 'rack-1',
            rackName: 'Rack 01',
            siteId: 'site-1',
            siteName: 'POP Centro',
          },
          b: {
            portId: 'asset-face-other-port',
            portName: 'GE1',
            side: 'DEVICE',
            assetId: 'asset-face-other',
            assetName: 'SW-02',
            rackId: 'rack-1',
            rackName: 'Rack 01',
            siteId: 'site-1',
            siteName: 'POP Centro',
          },
        }),
      ],
    });

    const value = (source: string, name: string) =>
      Number(new RegExp(`${name}:\\s*(-?[\\d.]+)(?:px)?`).exec(source)?.[1] ?? Number.NaN);
    const portButton =
      new RegExp(`<button[^>]*data-port-id="${last.id}"[^>]*style="([^"]+)"`).exec(html)?.[1] ?? '';
    expect(portButton).not.toBe('');
    const articleStyle =
      /<article[^>]*data-asset-id="asset-face-h36c"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const panelStyle =
      /<div class="physical-faceplate__panel"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const cable = /<path[^>]*d="M ([\d.]+) ([\d.]+)[^>]*class="physical-cable /.exec(html);
    expect(cable).not.toBeNull();

    const expectedX =
      value(articleStyle, 'left') + value(panelStyle, 'left') + value(portButton, 'left') +
      value(portButton, 'width') / 2;
    const expectedY =
      value(articleStyle, 'top') + value(panelStyle, 'top') + value(portButton, 'top') +
      value(portButton, 'height') / 2;
    // a baía de uplink empurra a porta para baixo: a âncora continua sendo o
    // centro do retângulo REALMENTE desenhado (tolerância de 1px)
    expect(Math.abs(Number(cable![1]) - expectedX)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(cable![2]) - expectedY)).toBeLessThanOrEqual(1);
  });
});

/**
 * Identidade apresentada da porta: **interface CLI** quando o catálogo declara
 * `interfaceNamePattern` (ou quando existe `mappedInterface`), com o conector e
 * o rótulo físico preservados como detalhe. Nada aqui altera `PhysicalPort.id`,
 * âncora, seleção, LLDP ou breakout.
 */
describe('nome de interface CLI no painel (catálogo → renderer)', () => {
  /** S6730-like: 4×10GE com CLI confirmado + 2×QSFP28 uplink. */
  const CLI_DEVICE: DeviceSpec = {
    catalogKey: 'huawei-s6730-h48x6c',
    model: 'S6730-H48X6C',
    assetId: 'asset-cli',
    startU: 30,
    panelHeight: 10,
    groups: [
      {
        groupKey: 'sfpplus-10g',
        count: 4,
        connector: 'SFP_PLUS',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '10GE-{n}',
        interfacePattern: 'XGigabitEthernet0/0/{n}',
        visual: { row: 1, columns: 4, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 2,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        interfacePattern: '100GE0/0/{n}',
        visual: { row: 3, columns: 2, x: 38, y: 6.4, gapX: 0.6 },
      },
    ],
  };

  it('o texto principal é a interface, e o conector/rótulo físico ficam como detalhe', () => {
    const { entry, asset } = buildFixedDevice(CLI_DEVICE);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    // identidade = interface CLI declarada no catálogo
    expect(html).toContain('data-port-display-name="XGigabitEthernet0/0/1"');
    expect(html).toContain('data-port-display-name="100GE0/0/2"');
    // o cage continua rastreável (nunca é o nome principal)
    expect(html).toContain('data-port-name="10GE-1"');
    // tooltip separa identidade de característica física
    expect(html).toContain('XGigabitEthernet0/0/1 · Conector SFP+ · Painel físico 10GE-1');
    // o conector não some da estrutura técnica
    expect(html.match(/data-connector=/g)).toHaveLength(6);
    expect(html).toContain('data-connector="QSFP28"');
    // e nada regrediu para o rótulo do cage como nome principal
    expect(html).not.toContain('data-port-display-name="10GE-1"');
  });

  it('a baía anuncia a faixa de interfaces do grupo', () => {
    const { entry, asset } = buildFixedDevice(CLI_DEVICE);
    const html = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });

    expect(html).toContain('physical-fixed-bay__interface');
    expect(html).toContain('XGigabitEthernet0/0/1–4');
    expect(html).toContain('100GE0/0/1–2');
    // o rótulo de papel + faixa do painel continua
    expect(html).toContain('SERVICE<b>1–4</b>');
    expect(html).toContain('UPLINK<b>1–2</b>');
  });

  it('a faixa da baía usa o nome real da interface quando a porta está sincronizada', () => {
    const { entry, asset } = buildFixedDevice({
      ...CLI_DEVICE,
      // catálogo sem nome declarado: só o sync traz o nome real
      groups: CLI_DEVICE.groups.map((group) => ({ ...group, interfacePattern: undefined })),
    });
    const withInterface = (port: (typeof asset.ports)[number], ordinal: number) => ({
      ...port,
      mappedInterfaceId: `if-${ordinal}`,
      mappedInterface: {
        id: `if-${ordinal}`,
        deviceId: 'device-1',
        name: `10GE1/0/${ordinal + 4}`,
        ifIndex: ordinal,
        alias: null,
        operStatus: 'UP' as const,
      },
    });
    // grupo de serviço (4 portas) totalmente sincronizado; uplink continua sem nome
    const syncAll = renderRack(
      [{ ...asset, ports: asset.ports.map((port, index) => (index < 4 ? withInterface(port, index + 1) : port)) }],
      { catalog: [entry], visualMode: 'TECHNICAL' },
    );
    expect(syncAll).toContain('physical-fixed-bay__interface');
    expect(syncAll).toContain('10GE1/0/5–8');
    expect(syncAll.match(/physical-fixed-bay__interface/g)).toHaveLength(1);

    // grupo incompleto (2 de 4) não anuncia faixa: dado parcial não vira rótulo
    const partial = renderRack(
      [{ ...asset, ports: asset.ports.map((port, index) => (index < 2 ? withInterface(port, index + 1) : port)) }],
      { catalog: [entry], visualMode: 'TECHNICAL' },
    );
    expect(partial).not.toContain('10GE1/0/5–6');
    expect(partial.match(/physical-fixed-bay__interface/g)).toBeNull();
  });

  it('renomear a apresentação não muda id, âncora nem seleção', () => {
    const { entry, asset } = buildFixedDevice(CLI_DEVICE);
    const plain = buildFixedDevice({
      ...CLI_DEVICE,
      groups: CLI_DEVICE.groups.map((group) => ({ ...group, interfacePattern: undefined })),
    });

    const withCli = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    const withoutCli = renderRack([asset], { catalog: [plain.entry], visualMode: 'TECHNICAL' });

    // mesmos ids persistidos e mesma geometria desenhada
    const ids = (html: string) => [...html.matchAll(/data-port-id="([^"]+)"/g)].map((match) => match[1]);
    const styles = (html: string) =>
      [...html.matchAll(/data-port-id="[^"]+"[^>]*style="([^"]+)"/g)].map((match) => match[1]);
    expect(ids(withCli)).toEqual(ids(withoutCli));
    expect(styles(withCli)).toEqual(styles(withoutCli));

    // a seleção continua sendo por PhysicalPort.id
    const selected = renderRack([asset], {
      catalog: [entry],
      visualMode: 'TECHNICAL',
      selection: { kind: 'port', id: `asset-cli-10GE-2` },
    });
    const button =
      /<button[^>]*data-port-id="asset-cli-10GE-2"[^>]*class="([^"]+)"/.exec(selected)?.[1] ?? '';
    expect(button).toContain('is-selected');
    expect(selected).toContain('data-port-display-name="XGigabitEthernet0/0/2"');
  });

  it('o modo real mantém a foto aprovada e não desenha baías', () => {
    const { entry, asset } = buildFixedDevice(CLI_DEVICE);
    const real = renderRack([asset], { catalog: [entry], visualMode: 'REAL' });

    // o painel por imagem continua sendo o desenho do modo real
    expect(real).toContain('physical-image-panel__hitbox');
    expect(real).toContain('data-port-name="10GE-1"');
    // a camada de baías/faixas de interface é exclusiva da visão técnica
    expect(real).not.toContain('physical-fixed-bay__interface');
    expect(real).not.toContain('physical-fixed-bay');
  });
});
