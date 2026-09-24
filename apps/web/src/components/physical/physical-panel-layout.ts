import type {
  PhysicalCatalogModule,
  PhysicalCatalogPort,
  PhysicalCatalogSlot,
  PhysicalConnectorKind,
  PhysicalModule,
  PhysicalPanelLayout,
  PhysicalPort,
  PhysicalPortFunction,
  PhysicalSlot,
  PhysicalVisualPlacement,
} from '@gmj/shared';

/**
 * Geometria do painel frontal em **unidades de grade** (nunca pixels).
 *
 * O catálogo declara posições relativas; o renderer converte para pixels usando
 * a largura disponível. Aumentar a largura do rack não exige alterar templates.
 * Nenhuma porta é truncada: se um painel tiver muitas fileiras, a escala encolhe
 * até o limite de legibilidade antes de crescer em altura.
 */

/** Escala preferida do desenho (px por unidade de grade) e respiro vertical. */
export const PANEL_PIXEL_SCALE = 7;
export const PANEL_VERTICAL_PADDING = 14;
/** Limite de altura visual de um único equipamento (em px). */
export const PANEL_MAX_HEIGHT = 168;
/**
 * Teto de altura para painéis **por imagem** (front panel e chassi modular).
 *
 * Grades geométricas continuam limitadas por `PANEL_MAX_HEIGHT`; a imagem de um
 * chassis alto (OLT X7/X15, M4) precisa de mais espaço para preencher a largura
 * do painel sem virar uma miniatura — a altura física (`heightU`) não muda.
 */
export const IMAGE_PANEL_MAX_HEIGHT = 560;
/** Abaixo disso o conector deixa de ser reconhecível. */
export const PANEL_MIN_SCALE = 3.4;
/** Largura de grade usada quando o catálogo não declara `panelLayout`. */
export const DEFAULT_PANEL_WIDTH = 100;
export const DEFAULT_GAP_X = 0.6;
export const DEFAULT_GAP_Y = 0.4;

export type PanelConnectorKind = PhysicalConnectorKind | 'PON' | 'CONSOLE' | 'MGMT';

export interface ConnectorShape {
  width: number;
  height: number;
  /** Rótulo curto usado no título/aria do conector. */
  label: string;
}

/**
 * Dimensões relativas por família de conector. QSFP é visivelmente maior que
 * SFP; QSFP-DD é maior que QSFP; RJ45, PON e console têm formas próprias.
 * Não são dimensões milimétricas: o objetivo é reconhecimento e proporção.
 */
export const CONNECTOR_SHAPES: Record<PanelConnectorKind, ConnectorShape> = {
  RJ45: { width: 2.8, height: 2.3, label: 'RJ45' },
  SFP: { width: 3.2, height: 2.2, label: 'SFP' },
  SFP_PLUS: { width: 3.2, height: 2.2, label: 'SFP+' },
  SFP28: { width: 3.2, height: 2.2, label: 'SFP28' },
  XFP: { width: 3.6, height: 2.4, label: 'XFP' },
  QSFP_PLUS: { width: 4.4, height: 2.6, label: 'QSFP+' },
  QSFP28: { width: 4.4, height: 2.6, label: 'QSFP28' },
  QSFP56: { width: 4.8, height: 2.8, label: 'QSFP56' },
  QSFP_DD: { width: 5.2, height: 3.1, label: 'QSFP-DD' },
  COMBO: { width: 3.6, height: 2.4, label: 'COMBO' },
  USB_MINI_B: { width: 2.4, height: 2.0, label: 'USB' },
  OTHER: { width: 3.0, height: 2.2, label: 'PORTA' },
  PON: { width: 2.9, height: 2.9, label: 'PON' },
  CONSOLE: { width: 2.6, height: 2.1, label: 'CONSOLE' },
  MGMT: { width: 3.0, height: 2.3, label: 'MGMT' },
};

/** Converte o tipo persistido (mais grosseiro) num conector visual. */
export function connectorFromPortType(type: PhysicalPort['type']): PanelConnectorKind {
  switch (type) {
    case 'RJ45':
      return 'RJ45';
    case 'SFP':
      return 'SFP';
    case 'SFP_PLUS':
      return 'SFP_PLUS';
    case 'QSFP':
      return 'QSFP28';
    case 'FIBER':
      return 'PON';
    default:
      return 'OTHER';
  }
}

/**
 * Resolve o conector visual de uma porta: catálogo (fonte de verdade) → tipo
 * persistido → rótulo funcional (management/console/PON).
 */
export function resolveConnectorKind(
  port: Pick<PhysicalPort, 'type' | 'role'>,
  catalogPort?: PhysicalCatalogPort | null,
): PanelConnectorKind {
  const portFunction: PhysicalPortFunction | null = catalogPort?.portFunction ?? null;
  if (portFunction === 'CONSOLE') return 'CONSOLE';
  if (portFunction === 'MGMT' || portFunction === 'MGMT_OR_SERVICE') {
    return catalogPort?.connector === 'RJ45' ? 'RJ45' : 'MGMT';
  }
  if (portFunction === 'PON') return 'PON';
  if (catalogPort?.connector) return catalogPort.connector;
  return connectorFromPortType(port.type);
}

export function connectorShape(kind: PanelConnectorKind): ConnectorShape {
  return CONNECTOR_SHAPES[kind] ?? CONNECTOR_SHAPES.OTHER;
}

export interface PlacedConnector {
  portId: string;
  portName: string;
  kind: PanelConnectorKind;
  shape: ConnectorShape;
  /** posição no grid do painel (canto superior esquerdo) */
  x: number;
  y: number;
  row: number;
  column: number;
  groupKey: string | null;
  /** porta do catálogo que descreveu este conector, quando existir */
  catalogPort: PhysicalCatalogPort | null;
}

export interface PlacedSlot {
  slotId: string;
  index: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  occupied: boolean;
}

export interface PanelLayout {
  /** `catalog` quando o template declarou panelLayout/visual; senão `fallback`. */
  source: 'catalog' | 'fallback';
  /** largura da grade */
  width: number;
  /** altura da grade (unidades), já considerando todas as fileiras */
  gridHeight: number;
  /** fileiras efetivamente usadas */
  rows: number;
  connectors: PlacedConnector[];
  slots: PlacedSlot[];
}

/**
 * Subconjunto do catálogo necessário para desenhar um painel. O
 * `PhysicalCatalogEntry` satisfaz esta forma; um módulo usa a mesma estrutura
 * com as suas próprias portas.
 */
export interface PanelCatalogView {
  ports: readonly PhysicalCatalogPort[];
  slots?: readonly Pick<PhysicalCatalogSlot, 'index' | 'visual'>[];
  panelLayout?: PhysicalPanelLayout | null;
}

/** Posição/escala do painel em pixels, usada para ancorar os cabos. */
export interface PanelViewport {
  /** px por unidade de grade */
  scale: number;
  /** canto superior esquerdo do painel (px) */
  offsetX: number;
  offsetY: number;
}

/** Centro do conector em pixels — a MESMA geometria usada para desenhá-lo. */
export function connectorAnchor(
  placed: PlacedConnector,
  viewport: PanelViewport,
): { x: number; y: number } {
  return {
    x: viewport.offsetX + (placed.x + placed.shape.width / 2) * viewport.scale,
    y: viewport.offsetY + (placed.y + placed.shape.height / 2) * viewport.scale,
  };
}

function normalizeKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

/** Chave tolerante: ignora separadores (`sfp-sfpplus1` = `sfp sfpplus 1`). */
function looseKey(value: string | null | undefined): string | null {
  const normalized = normalizeKey(value);
  if (!normalized) return null;
  return normalized.replace(/[\s_.\-/]+/g, '');
}

/**
 * Indexa as portas do catálogo por nome e rótulo (exato e tolerante), para
 * correlacionar a porta persistida com a declaração rica do template.
 */
export function indexCatalogPorts(ports: readonly PhysicalCatalogPort[]): {
  exact: Map<string, PhysicalCatalogPort>;
  loose: Map<string, PhysicalCatalogPort>;
} {
  const exact = new Map<string, PhysicalCatalogPort>();
  const loose = new Map<string, PhysicalCatalogPort>();
  for (const port of ports) {
    for (const key of [normalizeKey(port.name), normalizeKey(port.label)]) {
      if (key && !exact.has(key)) exact.set(key, port);
    }
    for (const key of [looseKey(port.name), looseKey(port.label)]) {
      if (key && !loose.has(key)) loose.set(key, port);
    }
  }
  return { exact, loose };
}

/**
 * Constrói o layout do painel de um equipamento.
 *
 * Quando o catálogo declara `visual` por grupo, as posições são respeitadas.
 * Sem catálogo (template CUSTOM/legado) o fallback organiza os grupos por
 * família de conector mantendo todas as portas visíveis.
 */
export function buildPanelLayout(input: {
  ports: readonly PhysicalPort[];
  slots: readonly PhysicalSlot[];
  modules: readonly PhysicalModule[];
  entry: PanelCatalogView | null;
  moduleTemplates?: ReadonlyMap<string, PhysicalCatalogModule>;
  /** portas de placa instalada ficam fora do painel do chassi (default). */
  skipModulePorts?: boolean;
  /**
   * Respiro extra **entre bandas** (linhas) de grupos, em unidades de grade.
   *
   * Apenas aparência: usado na visão técnica para os grupos ficarem visivelmente
   * separados (rótulo/legenda abaixo de cada grupo). Não muda contagem, conector
   * nem ordem das portas — a âncora continua saindo da porta desenhada.
   */
  bandGapY?: number;
  /** Respiro acima da primeira banda (espaço da legenda do grupo). */
  bandTopY?: number;
}): PanelLayout {
  void input.modules;
  void input.moduleTemplates;
  const catalog = indexCatalogPorts(input.entry?.ports ?? []);
  const groups = collectGroups(
    input.ports,
    catalog,
    input.entry,
    input.skipModulePorts ?? true,
  );
  const width = input.entry?.panelLayout?.width ?? DEFAULT_PANEL_WIDTH;
  const declared = groups.some((group) => group.visual !== null) || Boolean(input.entry?.panelLayout);
  const bandGapY = input.bandGapY ?? null;

  const connectors: PlacedConnector[] = [];
  let cursorY = 0;
  let maxX = 0;
  let rows = 0;
  /** Empilhamento em bandas (visão técnica): cada linha declarada vira uma faixa. */
  let bandTop = bandGapY === null ? 0 : (input.bandTopY ?? 0);
  let bandMinY = 0;
  let bandBottom = bandTop;
  let currentBand: number | null = null;

  const orderedGroups = [...groups].sort((a, b) => {
    const aRow = a.visual?.row ?? Number.MAX_SAFE_INTEGER;
    const bRow = b.visual?.row ?? Number.MAX_SAFE_INTEGER;
    if (aRow !== bRow) return aRow - bRow;
    const aY = a.visual?.y ?? Number.MAX_SAFE_INTEGER;
    const bY = b.visual?.y ?? Number.MAX_SAFE_INTEGER;
    if (aY !== bY) return aY - bY;
    return a.catalogIndex - b.catalogIndex;
  });

  for (const group of orderedGroups) {
    const kinds = group.ports.map((port) => resolveConnectorKind(port, port.catalogPort));
    const shapes = kinds.map(connectorShape);
    const shapeWidth = Math.max(...shapes.map((shape) => shape.width));
    const shapeHeight = Math.max(...shapes.map((shape) => shape.height));
    const gapX = group.visual?.gapX ?? DEFAULT_GAP_X;
    const gapY = group.visual?.gapY ?? DEFAULT_GAP_Y;
    const total = group.ports.length;
    /**
     * Painel com numeração física par/ímpar: duas fileiras por coluna, o índice
     * par em cima e o ímpar embaixo (F1A-8H20Q: `0 2 4 … / 1 3 5 …`).
     */
    const paired = group.visual?.pairing === 'EVEN_ODD';
    const columns =
      paired
        ? Math.max(1, Math.ceil(total / 2))
        : group.visual?.columns && group.visual.columns > 0
          ? Math.min(group.visual.columns, total)
          : Math.max(1, Math.floor((width - 8) / (shapeWidth + gapX)));
    const groupRows = paired ? Math.min(2, total) : Math.max(1, Math.ceil(total / columns));
    const requestedRows = group.visual?.rows && group.visual.rows > 0 ? group.visual.rows : groupRows;
    const groupWidth = columns * shapeWidth + (columns - 1) * gapX;
    const startX = group.visual?.x ?? Math.max(2, (width - Math.max(groupWidth, shapeWidth)) / 2);
    let startY: number;
    if (bandGapY === null) {
      startY = group.visual?.y ?? cursorY;
    } else {
      const band = group.visual?.row ?? null;
      if (band === null || band !== currentBand) {
        if (currentBand !== null) bandTop = bandBottom + bandGapY;
        currentBand = band;
        bandMinY = group.visual?.y ?? 0;
        bandBottom = bandTop;
      }
      startY = bandTop + ((group.visual?.y ?? bandMinY) - bandMinY);
    }

    group.ports.forEach((port, index) => {
      // Emparelhado: coluna = floor(index/2), fileira = index % 2 (par em cima).
      const column = paired ? Math.floor(index / 2) : index % columns;
      const row = paired ? index % 2 : Math.floor(index / columns);
      const kind = kinds[index]!;
      const shape = shapes[index]!;
      connectors.push({
        portId: port.id,
        portName: port.name,
        kind,
        shape,
        x: startX + column * (shapeWidth + gapX) + (shapeWidth - shape.width) / 2,
        y: startY + row * (shapeHeight + gapY) + (shapeHeight - shape.height) / 2,
        row,
        column,
        groupKey: group.groupKey,
        catalogPort: port.catalogPort,
      });
    });

    const groupHeight = requestedRows * shapeHeight + (requestedRows - 1) * gapY;
    if (bandGapY === null) {
      cursorY = Math.max(cursorY, startY + groupHeight + DEFAULT_GAP_Y);
    } else {
      bandBottom = Math.max(bandBottom, startY + groupHeight);
      cursorY = Math.max(cursorY, bandBottom);
    }
    rows += requestedRows;
    maxX = Math.max(maxX, startX + groupWidth);
  }

  const slots = placeSlots(input.slots, input.entry, width);
  if (slots.length) {
    cursorY = Math.max(cursorY, Math.max(...slots.map((slot) => slot.y + slot.height)) + DEFAULT_GAP_Y);
    maxX = Math.max(maxX, ...slots.map((slot) => slot.x + slot.width));
    rows = Math.max(rows, 1);
  }

  return {
    source: declared ? 'catalog' : 'fallback',
    width: Math.max(width, maxX + 2),
    gridHeight: Math.max(cursorY, 2.4),
    rows,
    connectors,
    slots,
  };
}

function placeSlots(
  slots: readonly PhysicalSlot[],
  entry: PanelCatalogView | null,
  width: number,
): PlacedSlot[] {
  if (!slots.length) return [];
  const visuals = (entry?.slots ?? []).map((slot) => slot.visual ?? null);
  const slotWidth = Math.max(2.4, (width - 24) / slots.length - 1.2);
  return slots.map((slot, index) => {
    const visual = visuals[index] ?? null;
    return {
      slotId: slot.id,
      index: slot.index,
      label: slot.label,
      x: visual?.x ?? 12 + index * (slotWidth + 1.2),
      y: visual?.y ?? 0.6,
      width: visual?.width ?? slotWidth,
      height: visual?.height ?? 4.6,
      occupied: slot.module !== null,
    };
  });
}

interface GroupInput {
  groupKey: string;
  ports: Array<{
    id: string;
    name: string;
    type: PhysicalPort['type'];
    role: PhysicalPort['role'];
    order: number;
    catalogPort: PhysicalCatalogPort | null;
  }>;
  visual: PhysicalVisualPlacement | null;
  /** posição de declaração no catálogo (para ordenar os grupos) */
  catalogIndex: number;
}

function collectGroups(
  ports: readonly PhysicalPort[],
  catalog: { exact: Map<string, PhysicalCatalogPort>; loose: Map<string, PhysicalCatalogPort> },
  entry: PanelCatalogView | null,
  skipModulePorts: boolean,
): GroupInput[] {
  const catalogOrder = new Map<string, number>();
  (entry?.ports ?? []).forEach((port, index) => {
    for (const key of [normalizeKey(port.name), looseKey(port.name)]) {
      if (key && !catalogOrder.has(key)) catalogOrder.set(key, index);
    }
  });

  const groups = new Map<string, GroupInput>();
  for (const port of ports) {
    if (port.side !== 'DEVICE') continue;
    if (skipModulePorts && port.moduleId) continue;
    const catalogPort =
      catalog.exact.get(normalizeKey(port.name) ?? '') ??
      catalog.exact.get(normalizeKey(port.label) ?? '') ??
      catalog.loose.get(looseKey(port.name) ?? '') ??
      catalog.loose.get(looseKey(port.label) ?? '') ??
      null;
    const groupKey = catalogPort?.groupKey ?? resolveConnectorKind(port, catalogPort);
    const key = normalizeKey(groupKey) ?? 'outros';
    const bucket = groups.get(key) ?? {
      groupKey: key,
      ports: [],
      visual: null,
      catalogIndex: Number.MAX_SAFE_INTEGER,
    };
    if (!bucket.visual) bucket.visual = catalogPort?.visual ?? null;
    const order =
      catalogOrder.get(normalizeKey(port.name) ?? '') ??
      catalogOrder.get(looseKey(port.name) ?? '') ??
      Number.MAX_SAFE_INTEGER;
    bucket.catalogIndex = Math.min(bucket.catalogIndex, order);
    bucket.ports.push({
      id: port.id,
      name: port.name,
      type: port.type,
      role: port.role,
      order: port.order,
      catalogPort,
    });
    groups.set(key, bucket);
  }
  for (const group of groups.values()) {
    group.ports.sort((a, b) => a.order - b.order);
  }
  return [...groups.values()];
}

/**
 * Painel de uma placa instalada: as portas do módulo usam o layout declarado
 * pelo módulo no catálogo (nenhuma porta é truncada).
 */
export function buildModulePanelLayout(input: {
  module: PhysicalModule;
  catalogModule: PhysicalCatalogModule | null;
}): PanelLayout {
  return buildPanelLayout({
    ports: input.module.ports,
    slots: [],
    modules: [],
    entry: input.catalogModule
      ? { ports: input.catalogModule.ports, panelLayout: input.catalogModule.panelLayout ?? null }
      : null,
    skipModulePorts: false,
  });
}

/**
 * Altura visual de um equipamento em pixels.
 *
 * Nunca é menor que a altura física ocupada no rack, cresce com o número de
 * fileiras do painel e encolhe a escala (até o limite de legibilidade) para
 * caber no teto antes de crescer além dele.
 */
export function calculateAssetDisplayHeight(
  layout: Pick<PanelLayout, 'gridHeight'>,
  heightU: number,
  baseUnitHeight: number,
): number {
  const physical = Math.max(1, heightU) * baseUnitHeight;
  const available = PANEL_MAX_HEIGHT - PANEL_VERTICAL_PADDING;
  const preferred = layout.gridHeight * PANEL_PIXEL_SCALE;
  const scale =
    preferred <= available
      ? PANEL_PIXEL_SCALE
      : Math.max(PANEL_MIN_SCALE, available / layout.gridHeight);
  const visual = Math.round(PANEL_VERTICAL_PADDING + layout.gridHeight * scale);
  return Math.max(physical, Math.min(Math.max(visual, physical), PANEL_MAX_HEIGHT));
}

/** Caixa geométrica de um conector/slot, usada para checar sobreposição. */
export interface PanelGeometryBox {
  id: string;
  kind: 'connector' | 'slot';
  x: number;
  y: number;
  width: number;
  height: number;
}

export function panelGeometryBoxes(layout: PanelLayout): PanelGeometryBox[] {
  return [
    ...layout.connectors.map((connector) => ({
      id: connector.portId,
      kind: 'connector' as const,
      x: connector.x,
      y: connector.y,
      width: connector.shape.width,
      height: connector.shape.height,
    })),
    ...layout.slots.map((slot) => ({
      id: slot.slotId,
      kind: 'slot' as const,
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: slot.height,
    })),
  ];
}

export interface PanelOverlapReport {
  /** ids de conectores que participam de alguma sobreposição */
  ids: Set<string>;
  /** pares sobrepostos */
  pairs: number;
}

/** Tolerância mínima de interseção (unidades de grade) para não marcar bordas. */
const OVERLAP_TOLERANCE = 0.15;

function boxesOverlap(a: PanelGeometryBox, b: PanelGeometryBox): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > OVERLAP_TOLERANCE && height > OVERLAP_TOLERANCE;
}

/**
 * Detecta sobreposição entre conectores de um painel.
 *
 * Slots são moldura (e as portas de uma placa vivem dentro deles), então só
 * conectores são comparados — a ferramenta serve para achar coordenadas
 * `visual:` erradas no catálogo e hotspots mal recortados na preview.
 */
export function findPanelOverlaps(layout: PanelLayout): PanelOverlapReport {
  const boxes = panelGeometryBoxes(layout).filter((box) => box.kind === 'connector');
  const ids = new Set<string>();
  let pairs = 0;
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      if (!boxesOverlap(a, b)) continue;
      pairs += 1;
      ids.add(a.id);
      ids.add(b.id);
    }
  }
  return { ids, pairs };
}
