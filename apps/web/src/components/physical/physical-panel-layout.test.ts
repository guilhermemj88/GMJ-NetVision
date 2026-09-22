import { describe, expect, it } from 'vitest';
import type { PhysicalCatalogPort, PhysicalConnectorKind } from '@gmj/shared';
import { physicalAsset, physicalPort, physicalRack, physicalSlot } from './physical-fixtures';
import {
  CONNECTOR_SHAPES,
  buildModulePanelLayout,
  buildPanelLayout,
  calculateAssetDisplayHeight,
  connectorAnchor,
  connectorShape,
} from './physical-panel-layout';
import { buildRackGeometry, distributeAssetHeight } from './physical-rack-geometry';
import { physicalModule } from './physical-fixtures';

/** Portas declaradas pelo catálogo do F1A-8H20Q (8x100GE + 20x25GE + 28x10GE). */
function f1aCatalogPorts(): PhysicalCatalogPort[] {
  const groups: Array<[string, number, PhysicalConnectorKind, string]> = [
    ['100ge-cages', 8, 'QSFP28', '100GE-'],
    ['25ge-cages', 20, 'SFP28', '25GE-'],
    ['10ge-cages', 28, 'SFP_PLUS', '10GE-'],
  ];
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (const [groupKey, count, connector, prefix] of groups) {
    for (let index = 1; index <= count; index += 1) {
      order += 1;
      ports.push({
        name: `${prefix}${index}`,
        label: `${prefix}${index}`,
        order,
        side: 'DEVICE',
        type: connector === 'QSFP28' ? 'QSFP' : 'SFP',
        connector,
        portFunction: 'SERVICE',
        groupKey,
      });
    }
  }
  return ports;
}

function f1aAssetPorts() {
  return f1aCatalogPorts().map((port, index) =>
    physicalPort({
      id: `f1a-port-${index + 1}`,
      name: port.name,
      label: port.label,
      order: port.order,
      type: port.type,
    }),
  );
}

describe('geometria visual do rack', () => {
  it('mantém o F1A em U42 (1U) mesmo com altura visual expandida', () => {
    const f1a = physicalAsset({ id: 'f1a', name: 'BHE-VTA-F1A-BGP', startU: 42, heightU: 1 });
    const geometry = buildRackGeometry(physicalRack({ units: 42, assets: [f1a] }), new Map([['f1a', 120]]));
    const asset = geometry.assets.get('f1a')!;
    // ocupação física intacta
    expect(asset.startU).toBe(42);
    expect(asset.heightU).toBe(1);
    // desenho expandido
    expect(asset.height).toBe(120);
    expect(geometry.unitByNumber.get(42)!.height).toBe(120);
  });

  it('faz U41 começar somente depois da geometria expandida de U42', () => {
    const f1a = physicalAsset({ id: 'f1a', startU: 42, heightU: 1 });
    const rack = physicalRack({ units: 42, assets: [f1a] });
    const geometry = buildRackGeometry(rack, new Map([['f1a', 120]]));
    const u42 = geometry.unitByNumber.get(42)!;
    const u41 = geometry.unitByNumber.get(41)!;
    expect(u41.top).toBe(u42.top + u42.height);
    expect(u41.height).toBe(30);
  });

  it('nunca sobrepõe unidades: top + height fecha a unidade seguinte', () => {
    const rack = physicalRack({
      units: 6,
      assets: [
        physicalAsset({ id: 'a', startU: 6, heightU: 1 }),
        physicalAsset({ id: 'b', startU: 5, heightU: 2 }),
        physicalAsset({ id: 'c', startU: 2, heightU: 1 }),
      ],
    });
    const geometry = buildRackGeometry(
      rack,
      new Map([
        ['a', 96],
        ['b', 44],
        ['c', 30],
      ]),
    );
    const ordered = [...geometry.units].sort((left, right) => left.unit - right.unit);
    for (let index = 1; index < ordered.length; index += 1) {
      const lower = ordered[index - 1]!;
      const upper = ordered[index]!;
      expect(upper.top + upper.height).toBe(lower.top);
    }
    // o equipamento de 2U recebe a expansão distribuída entre as suas U
    const shared = distributeAssetHeight(2, 96, 30);
    expect(shared.reduce((sum, value) => sum + value, 0)).toBe(96);
    expect(shared.every((value) => value >= 30)).toBe(true);
  });

  it('preserva as U corretas com RB750 + F1A + S6750 + modular no mesmo rack', () => {
    const rb750 = physicalAsset({ id: 'rb', name: 'RB750', startU: 8, heightU: 1 });
    const f1a = physicalAsset({ id: 'f1a', name: 'F1A', startU: 7, heightU: 1 });
    const s6750 = physicalAsset({ id: 's6750', name: 'S6750', startU: 6, heightU: 1 });
    const modular = physicalAsset({ id: 'mod', name: 'MX80', startU: 4, heightU: 2 });
    const geometry = buildRackGeometry(
      physicalRack({ units: 10, assets: [rb750, f1a, s6750, modular] }),
      new Map([
        ['f1a', 110],
        ['s6750', 96],
      ]),
    );
    expect(geometry.assets.get('rb')!.startU).toBe(8);
    expect(geometry.assets.get('f1a')!.startU).toBe(7);
    expect(geometry.assets.get('s6750')!.startU).toBe(6);
    expect(geometry.assets.get('mod')!.heightU).toBe(2);
    // U9 e U10 (acima do RB750) continuam na altura base
    expect(geometry.unitByNumber.get(10)!.height).toBe(30);
    expect(geometry.unitByNumber.get(9)!.height).toBe(30);
    // as U livres entre os equipamentos continuam na altura base
    expect(geometry.unitByNumber.get(5)!.height).toBe(30);
    expect(geometry.unitByNumber.get(3)!.height).toBe(30);
  });
});

describe('layout do painel', () => {
  it('renderiza as 56 portas do F1A (sem "+32" e sem truncamento)', () => {
    const entry = {
      ports: f1aCatalogPorts(),
      panelLayout: { type: 'LOGICAL' as const, width: 100, height: 14 },
    };
    const layout = buildPanelLayout({
      ports: f1aAssetPorts(),
      slots: [],
      modules: [],
      entry,
    });
    expect(layout.connectors).toHaveLength(56);
    expect(layout.source).toBe('catalog');
    expect(layout.connectors.filter((connector) => connector.kind === 'QSFP28')).toHaveLength(8);
    expect(layout.connectors.filter((connector) => connector.kind === 'SFP28')).toHaveLength(20);
    expect(layout.connectors.filter((connector) => connector.kind === 'SFP_PLUS')).toHaveLength(28);
    // nenhum conector fora do painel declarado
    for (const connector of layout.connectors) {
      expect(connector.x).toBeGreaterThanOrEqual(0);
      expect(connector.y).toBeGreaterThanOrEqual(0);
      expect(connector.x + connector.shape.width).toBeLessThanOrEqual(layout.width);
    }
  });

  it('diferencia visualmente as famílias de conector', () => {
    expect(CONNECTOR_SHAPES.QSFP28.width).toBeGreaterThan(CONNECTOR_SHAPES.SFP28.width);
    expect(CONNECTOR_SHAPES.QSFP28.height).toBeGreaterThan(CONNECTOR_SHAPES.SFP28.height);
    expect(CONNECTOR_SHAPES.QSFP_DD.width).toBeGreaterThan(CONNECTOR_SHAPES.QSFP28.width);
    // SFP28 e SFP+ são equivalentes em dimensão (mesma geração de cage)
    expect(CONNECTOR_SHAPES.SFP28.width).toBe(CONNECTOR_SHAPES.SFP_PLUS.width);
    expect(CONNECTOR_SHAPES.SFP28.height).toBe(CONNECTOR_SHAPES.SFP_PLUS.height);
    expect(connectorShape('RJ45').width).toBeLessThan(connectorShape('QSFP28').width);
    expect(connectorShape('PON')).not.toEqual(connectorShape('SFP'));
  });

  it('usa fallback organizado quando o template não declara layout', () => {
    const ports = Array.from({ length: 30 }, (_value, index) =>
      physicalPort({
        id: `port-${index + 1}`,
        name: `ether${index + 1}`,
        order: index + 1,
        type: 'RJ45',
      }),
    );
    const layout = buildPanelLayout({ ports, slots: [], modules: [], entry: null });
    expect(layout.source).toBe('fallback');
    expect(layout.connectors).toHaveLength(30);
    const rows = new Set(layout.connectors.map((connector) => connector.row));
    expect(rows.size).toBeGreaterThan(1);
  });

  it('mantém todas as portas de uma placa instalada (sem limite de 6)', () => {
    const module = physicalModule({
      id: 'module-1',
      ports: Array.from({ length: 20 }, (_value, index) =>
        physicalPort({
          id: `mic-port-${index + 1}`,
          name: `SFP-${index + 1}`,
          order: index + 1,
          moduleId: 'module-1',
          type: 'SFP',
        }),
      ),
    });
    const layout = buildModulePanelLayout({
      module,
      catalogModule: {
        key: 'juniper-mic-3d-20ge-sfp',
        name: 'MIC',
        model: 'MIC-3D-20GE-SFP',
        description: '',
        slotsRequired: 1,
        ports: Array.from({ length: 20 }, (_value, index) => ({
          name: `SFP-${index + 1}`,
          label: `SFP-${index + 1}`,
          order: index + 1,
          side: 'DEVICE' as const,
          type: 'SFP' as const,
          connector: 'SFP' as const,
          groupKey: 'ge-sfp',
        })),
      },
    });
    expect(layout.connectors).toHaveLength(20);
  });

  it('mantém um único cage físico para breakout', () => {
    const cage = physicalPort({ id: 'cage-1', name: 'qsfp28-1', type: 'QSFP', role: 'DISCOVERED' });
    const layout = buildPanelLayout({ ports: [cage], slots: [], modules: [], entry: null });
    expect(layout.connectors).toHaveLength(1);
    expect(layout.connectors[0]!.kind).toBe('QSFP28');
  });

  it('ancora o cabo no centro do conector desenhado', () => {
    const layout = buildPanelLayout({
      ports: f1aAssetPorts().slice(0, 8),
      slots: [],
      modules: [],
      entry: { ports: f1aCatalogPorts().slice(0, 8) },
    });
    const connector = layout.connectors.find((item) => item.kind === 'QSFP28')!;
    const viewport = { scale: 8, offsetX: 100, offsetY: 50 };
    const anchor = connectorAnchor(connector, viewport);
    expect(anchor.x).toBe(100 + (connector.x + connector.shape.width / 2) * 8);
    expect(anchor.y).toBe(50 + (connector.y + connector.shape.height / 2) * 8);
  });

  it('encolhe a escala de painéis densos mantendo todas as portas e altura limitada', () => {
    const ports = Array.from({ length: 64 }, (_value, index) =>
      physicalPort({ id: `p-${index + 1}`, name: `SFP-${index + 1}`, order: index + 1, type: 'SFP' }),
    );
    const layout = buildPanelLayout({ ports, slots: [], modules: [], entry: null });
    const height = calculateAssetDisplayHeight(layout, 1, 30);
    expect(layout.connectors).toHaveLength(64);
    expect(height).toBeLessThanOrEqual(168);
    expect(height).toBeGreaterThan(30);
  });

  it('respeita o painel declarado nos slots (modular)', () => {
    const slots = [
      physicalSlot({ id: 'slot-1', index: 1, label: 'LPU 1' }),
      physicalSlot({ id: 'slot-2', index: 2, label: 'LPU 2' }),
    ];
    const layout = buildPanelLayout({
      ports: [],
      slots,
      modules: [],
      entry: {
        ports: [],
        slots: [
          { index: 1, visual: { x: 10, y: 1, width: 20, height: 6 } },
          { index: 2, visual: { x: 32, y: 1, width: 20, height: 6 } },
        ],
      },
    });
    expect(layout.slots).toHaveLength(2);
    expect(layout.slots[0]).toMatchObject({ x: 10, width: 20, height: 6 });
    expect(layout.slots[1]).toMatchObject({ x: 32, width: 20, height: 6 });
    expect(layout.gridHeight).toBeGreaterThanOrEqual(7);
  });
});
