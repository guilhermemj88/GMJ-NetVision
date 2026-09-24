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

/**
 * Portas declaradas pelo catálogo do F1A-8H20Q: painel frontal real em UMA
 * faixa de 28 colunas × 2 fileiras, numerado de 0 a 55 (28 SFP+ 0-27, 8 SFP28
 * 28-35, 12 SFP28 36-47 e 8 QSFP28 48-55).
 */
function f1aGroups() {
  return [
    // groupKey, count, panelNumberStart, connector, type, prefixo do rótulo, x
    ['sfpplus-10g', 28, 0, 'SFP_PLUS', 'SFP_PLUS', '10GE-', 2],
    ['sfp28-25g-a', 8, 28, 'SFP28', 'SFP_PLUS', '25GE-', 55.4],
    ['sfp28-25g-b', 12, 36, 'SFP28', 'SFP_PLUS', '25GE-', 70.8],
    ['qsfp28-100g', 8, 48, 'QSFP28', 'QSFP', '100GE-', 93.8],
  ] as const satisfies ReadonlyArray<
    readonly [string, number, number, PhysicalConnectorKind, 'SFP_PLUS' | 'QSFP', string, number]
  >;
}

function f1aCatalogPorts(): PhysicalCatalogPort[] {
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (const [groupKey, count, start, connector, type, prefix, x] of f1aGroups()) {
    for (let index = 0; index < count; index += 1) {
      order += 1;
      ports.push({
        name: `${prefix}${start + index}`,
        label: `${prefix}${start + index}`,
        order,
        side: 'DEVICE',
        type,
        connector,
        portFunction: groupKey === 'qsfp28-100g' ? 'UPLINK' : 'SERVICE',
        groupKey,
        panelNumber: start + index,
        visual: { row: 1, x, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
      });
    }
  }
  return ports;
}

/** Painel frontal oficial do F1A (mesma declaração do catálogo). */
const F1A_PANEL = { type: 'FRONT' as const, width: 118, height: 7 };

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
      panelLayout: F1A_PANEL,
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
      ports: f1aAssetPorts(),
      slots: [],
      modules: [],
      entry: { ports: f1aCatalogPorts(), panelLayout: F1A_PANEL },
    });
    const viewport = { scale: 8, offsetX: 100, offsetY: 50 };
    // porta física 0 (par, fileira de cima) e um QSFP28 (48-55)
    const samples = [
      layout.connectors[0]!,
      layout.connectors.find((item) => item.kind === 'QSFP28')!,
    ];
    for (const connector of samples) {
      const anchor = connectorAnchor(connector, viewport);
      expect(anchor.x).toBe(100 + (connector.x + connector.shape.width / 2) * 8);
      expect(anchor.y).toBe(50 + (connector.y + connector.shape.height / 2) * 8);
    }
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

/**
 * Painel frontal oficial do NetEngine 8000 F1A-8H20Q: 56 conectores em UMA
 * faixa contínua de 28 colunas × 2 fileiras, numerados de 0 a 55 com o par em
 * cima e o ímpar embaixo. Regressão do layout errado em três bandas (100GE /
 * 25GE / 10GE um embaixo do outro).
 */
describe('painel físico do F1A-8H20Q (0–55 em 28 colunas × 2 fileiras)', () => {
  function f1aLayout() {
    return buildPanelLayout({
      ports: f1aAssetPorts(),
      slots: [],
      modules: [],
      entry: { ports: f1aCatalogPorts(), panelLayout: F1A_PANEL },
    });
  }

  function panelNumber(connector: { catalogPort: { panelNumber?: number | null } | null }) {
    return connector.catalogPort?.panelNumber ?? null;
  }

  it('numera as 56 portas de 0 a 55, sem buraco e sem repetição', () => {
    const layout = f1aLayout();
    expect(layout.connectors).toHaveLength(56);
    const numbers = layout.connectors.map(panelNumber).sort((left, right) => left! - right!);
    expect(numbers).toEqual(Array.from({ length: 56 }, (_value, index) => index));
    // a identidade persistida continua sendo a do catálogo (nada é renomeado aqui)
    expect(layout.connectors.map((connector) => connector.portName)).toContain('10GE-0');
    expect(layout.connectors.map((connector) => connector.portName)).toContain('100GE-55');
  });

  it('emparelha par em cima e ímpar embaixo (column = N/2, row = N%2)', () => {
    const layout = f1aLayout();
    /** Início da numeração física de cada bloco (declarado no catálogo). */
    const starts = new Map([
      ['sfpplus-10g', 0],
      ['sfp28-25g-a', 28],
      ['sfp28-25g-b', 36],
      ['qsfp28-100g', 48],
    ]);
    for (const connector of layout.connectors) {
      const number = panelNumber(connector)!;
      const start = starts.get(connector.groupKey!)!;
      expect(connector.column).toBe(Math.floor((number - start) / 2));
      expect(connector.row).toBe(number % 2);
    }
    const byNumber = new Map(layout.connectors.map((connector) => [panelNumber(connector), connector]));
    const zero = byNumber.get(0)!;
    const one = byNumber.get(1)!;
    const two = byNumber.get(2)!;
    // mesma coluna para 0 e 1; ímpar abaixo do par; 2 na coluna seguinte
    expect(zero.x).toBe(one.x);
    expect(one.y).toBeGreaterThan(zero.y);
    expect(two.x).toBeGreaterThan(zero.x);
    expect(two.y).toBe(zero.y);
    expect(layout.connectors.filter((connector) => panelNumber(connector)! % 2 === 0)).toHaveLength(28);
    expect(layout.connectors.filter((connector) => panelNumber(connector)! % 2 === 1)).toHaveLength(28);
  });

  it('mantém uma faixa contínua: quatro blocos lado a lado, sem bandas empilhadas', () => {
    const layout = f1aLayout();
    const span = (groupKey: string) => {
      const items = layout.connectors.filter((connector) => connector.groupKey === groupKey);
      return {
        count: items.length,
        start: Math.min(...items.map((item) => item.x)),
        end: Math.max(...items.map((item) => item.x + item.shape.width)),
      };
    };
    const a = span('sfpplus-10g');
    const b = span('sfp28-25g-a');
    const c = span('sfp28-25g-b');
    const d = span('qsfp28-100g');
    expect([a.count, b.count, c.count, d.count]).toEqual([28, 8, 12, 8]);
    // contíguos na ordem física 0-27, 28-35, 36-47, 48-55
    expect(a.end).toBeLessThanOrEqual(b.start);
    expect(b.end).toBeLessThanOrEqual(c.start);
    expect(c.end).toBeLessThanOrEqual(d.start);
    // e sem bandas empilhadas: tudo dentro de uma única faixa (topo alinhado)
    expect(new Set(layout.connectors.map((connector) => connector.row))).toEqual(new Set([0, 1]));
    const topRow = layout.connectors.filter((connector) => connector.row === 0);
    expect(new Set(topRow.map((connector) => connector.y)).size).toBe(1);
    const bottomRow = layout.connectors.filter((connector) => connector.row === 1);
    expect(Math.min(...bottomRow.map((connector) => connector.y))).toBeGreaterThan(
      Math.max(...topRow.map((connector) => connector.y)),
    );
    // tudo dentro do painel declarado (7 unidades de grade do catálogo)
    expect(layout.gridHeight).toBeLessThanOrEqual(7);
  });

  it('não cria, remove nem move portas: ids e âncoras seguem o desenho', () => {
    const layout = f1aLayout();
    const ports = f1aAssetPorts();
    expect(new Set(layout.connectors.map((connector) => connector.portId))).toEqual(
      new Set(ports.map((port) => port.id)),
    );
    // a âncora é sempre o centro do conector desenhado (mesma geometria)
    const viewport = { scale: 6, offsetX: 10, offsetY: 20 };
    for (const connector of [layout.connectors[0]!, layout.connectors.at(-1)!]) {
      const anchor = connectorAnchor(connector, viewport);
      expect(anchor.x).toBe(10 + (connector.x + connector.shape.width / 2) * 6);
      expect(anchor.y).toBe(20 + (connector.y + connector.shape.height / 2) * 6);
    }
  });
});

describe('empilhamento de baías (somente modo técnico)', () => {
  /** H36C: 32x QSFP28 service (16 colunas, 2 linhas) + 4x QSFP28 uplink (linha 3). */
  function h36cEntry() {
    const ports: PhysicalCatalogPort[] = [];
    const groups: Array<[string, number, number, number, number, number]> = [
      // groupKey, count, ordinalBase, columns, x, y
      ['qsfp28-service', 32, 1, 16, 0.6, 0.6],
      ['qsfp28-uplink', 4, 33, 4, 40, 6.4],
    ];
    let order = 0;
    for (const [groupKey, count, ordinalBase, columns, x, y] of groups) {
      for (let index = 0; index < count; index += 1) {
        order += 1;
        ports.push({
          name: `QSFP28-${ordinalBase + index}`,
          label: `QSFP28-${ordinalBase + index}`,
          order,
          side: 'DEVICE',
          type: 'QSFP',
          connector: 'QSFP28',
          portFunction: groupKey === 'qsfp28-uplink' ? 'UPLINK' : 'SERVICE',
          groupKey,
          visual: {
            width: 4.4,
            height: 2.6,
            x: x + (index % columns) * (4.4 + 0.9),
            y: y + Math.floor(index / columns) * (2.6 + 0.4),
            columns,
            row: 0,
          },
        });
      }
    }
    return { ports, panelLayout: { type: 'LOGICAL' as const, width: 100, height: 10 } };
  }

  function h36cPorts() {
    return h36cEntry().ports.map((port, index) =>
      physicalPort({
        id: `h36c-${index + 1}`,
        name: port.name,
        label: port.label,
        order: port.order,
        type: port.type,
      }),
    );
  }

  it('sem opções de baía o layout continua exatamente o declarado', () => {
    const layout = buildPanelLayout({
      ports: h36cPorts(),
      slots: [],
      modules: [],
      entry: h36cEntry(),
    });
    const service = layout.connectors.filter((connector) => connector.groupKey === 'qsfp28-service');
    const uplink = layout.connectors.filter((connector) => connector.groupKey === 'qsfp28-uplink');
    expect(service).toHaveLength(32);
    expect(uplink).toHaveLength(4);
    expect(service[0]!.y).toBeCloseTo(0.6, 5);
    expect(uplink[0]!.y).toBeCloseTo(6.4, 5);
    expect(layout.connectors).toHaveLength(36);
  });

  it('com bandGapY/bandTopY empurra o segundo grupo e preserva o x das portas', () => {
    const entry = h36cEntry();
    const plain = buildPanelLayout({ ports: h36cPorts(), slots: [], modules: [], entry });
    const banded = buildPanelLayout({
      ports: h36cPorts(),
      slots: [],
      modules: [],
      entry,
      bandGapY: 1.6,
      bandTopY: 1.2,
    });

    // nada de porta criada/removida, e o eixo x é o mesmo (numeração/colunas intactas)
    expect(banded.connectors).toHaveLength(plain.connectors.length);
    expect(banded.connectors.map((connector) => connector.x)).toEqual(
      plain.connectors.map((connector) => connector.x),
    );
    // a primeira baía começa em bandTopY (espaço da legenda abaixo das portas)
    const firstService = banded.connectors.find(
      (connector) => connector.groupKey === 'qsfp28-service',
    )!;
    expect(firstService.y).toBeCloseTo(1.2, 5);
    // o grupo seguinte fica depois de TODA a baía anterior + respiro
    const lastServiceY = Math.max(
      ...banded.connectors
        .filter((connector) => connector.groupKey === 'qsfp28-service')
        .map((connector) => connector.y),
    );
    const firstUplink = banded.connectors.find(
      (connector) => connector.groupKey === 'qsfp28-uplink',
    )!;
    expect(firstUplink.y).toBeGreaterThan(lastServiceY + 1.6);
    // as bandas só usam o espaço vertical que já existia no painel (nada é cortado)
    expect(banded.gridHeight).toBeGreaterThan(plain.gridHeight);
    for (const connector of banded.connectors) {
      expect(connector.y + connector.shape.height).toBeLessThanOrEqual(banded.gridHeight);
    }
  });
});
