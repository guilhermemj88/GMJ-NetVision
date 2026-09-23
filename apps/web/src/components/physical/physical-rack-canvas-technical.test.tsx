import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PhysicalCatalogPort,
  PhysicalConnectorKind,
  PhysicalPort,
  PhysicalPortFunction,
  PhysicalVisualPlacement,
} from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import { modularChassisMap } from './modular-chassis-map';
import type { PhysicalVisualMode } from './physical-types';
import {
  catalogEntry,
  physicalAsset,
  physicalConnection,
  physicalModule,
  physicalPort,
  physicalRack,
  physicalSlot,
} from './physical-fixtures';

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
      // padrão do catálogo: `10GE-{n}` ou ordinal contínuo `{n+32}`
      const offset = /^(.+)\{n\+(\d+)\}$/.exec(group.pattern);
      const name = offset
        ? `${offset[1]}${index + Number(offset[2])}`
        : group.pattern.replace('{n}', String(index));
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
        interfaceName: null,
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
const F1A: DeviceSpec = {
  catalogKey: 'huawei-ne8000-f1a-8h20q',
  model: 'F1A-8H20Q',
  assetId: 'asset-f1a',
  startU: 40,
  panelHeight: 14,
  groups: [
    {
      groupKey: '100ge-cages',
      count: 8,
      connector: 'QSFP28',
      type: 'QSFP',
      portFunction: 'UPLINK',
      pattern: '100GE-{n}',
      visual: { row: 1, columns: 8, x: 25, y: 0.6, gapX: 0.8 },
    },
    {
      groupKey: '25ge-cages',
      count: 20,
      connector: 'SFP28',
      type: 'SFP_PLUS',
      portFunction: 'SERVICE',
      pattern: '25GE-{n}',
      visual: { row: 2, columns: 10, x: 14, y: 4.4, gapX: 0.6 },
    },
    {
      groupKey: '10ge-cages',
      count: 28,
      connector: 'SFP_PLUS',
      type: 'SFP_PLUS',
      portFunction: 'SERVICE',
      pattern: '10GE-{n}',
      visual: { row: 4, columns: 14, x: 7, y: 8.2, gapX: 0.6 },
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
  } = {},
) {
  return renderToStaticMarkup(
    <PhysicalRackCanvas
      rack={physicalRack({ units: 42, assets })}
      connections={options.connections ?? []}
      mode="all"
      selection={null}
      path={null}
      visualMode={options.visualMode ?? 'REAL'}
      catalog={options.catalog ?? []}
      onSelectAsset={noop}
      onSelectPort={noop}
      onSelectConnection={noop}
      onClear={noop}
    />,
  );
}

describe('visão técnica no rack canvas', () => {
  it('F1A: resolve o desenho técnico com os grupos 10GE/25GE/100GE legíveis', () => {
    const { entry, asset } = buildFixedDevice(F1A);

    const real = renderRack([asset], { catalog: [entry], visualMode: 'REAL' });
    expect(real).toContain('data-visual="REAL"');
    expect(real).toContain('ne8000-f1a-8h20q-front.png');

    const technical = renderRack([asset], { catalog: [entry], visualMode: 'TECHNICAL' });
    expect(technical).toContain('data-visual="TECHNICAL"');
    // sem fotografia: o desenho é o painel geométrico
    expect(technical).not.toContain('ne8000-f1a-8h20q-front.png');
    expect(technical.match(/data-port-id=/g)).toHaveLength(56);
    expect(technical).toContain('100GE × 8');
    expect(technical).toContain('25GE × 20');
    expect(technical).toContain('10GE × 28');
    // rótulos curtos das portas no desenho
    expect(technical).toContain('class="physical-port__label"');
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
