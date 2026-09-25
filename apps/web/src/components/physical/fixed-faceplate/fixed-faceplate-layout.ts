import type { PanelLayout, PlacedConnector } from '../physical-panel-layout';
import {
  TECHNICAL_GROUP_LABELS,
  portFamilyPrefix,
  technicalGroupBays,
  type TechnicalGroupRole,
} from '../physical-technical';

/**
 * Motor **visual** do faceplate fixo (unidades de grade do chassi).
 *
 * Este módulo é a única matemática de desenho: ele reposiciona conectores já
 * colocados pelo `buildPanelLayout` dentro da caixa do chassi declarada pelo
 * perfil visual do SKU. Nada aqui cria, remove, renomeia ou reindexa porta —
 * `PhysicalPort.id`, `catalogPort`, `panelNumber`, `groupKey`, `connector` e a
 * ordem são preservados, e a âncora do cabo continua saindo do **mesmo**
 * conector desenhado (`connectorAnchor`).
 *
 * A fonte da verdade técnica continua sendo `physical-catalog-v1.yaml`; o
 * perfil visual só diz *como* desenhar (proporção, bandas, respiros, legendas).
 */

/** Zona do desenho, sempre em **unidades de grade** do chassi. */
export interface FixedFaceplateZone {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Grupo dentro de uma banda do desenho (a ordem é a ordem de desenho). */
export interface FixedFaceplateGroupSpec {
  /** `groupKey` (ou conector) já declarado no catálogo — nada é inventado aqui. */
  readonly groupKey: string;
  /**
   * Colunas do bloco no desenho. Quando declarado (H36C: uplinks `2×2`), a
   * fileira é preenchida da esquerda para a direita. Sem ele vale o arranjo do
   * catálogo (F1A: par/ímpar em 14 colunas × 2 fileiras).
   */
  readonly columns?: number;
  /**
   * Fileiras do bloco (`rows: 2` = duas fileiras com `ceil(count/2)` colunas),
   * como no `groupPresentation` da biblioteca visual. Só é usado quando
   * `columns` não é declarado.
   */
  readonly rows?: number;
  /** Passo entre colunas do grupo (unidades). Default: o passo do catálogo. */
  readonly gapX?: number;
}

/** Banda horizontal do desenho: grupos lado a lado, alinhados pela fileira. */
export interface FixedFaceplateBandSpec {
  readonly groups: readonly FixedFaceplateGroupSpec[];
  /** Respiro vertical antes desta banda (unidades). */
  readonly gapBefore?: number;
}

/** Layout visual declarado por um SKU (nunca um segundo catálogo técnico). */
export interface FixedFaceplateLayoutSpec {
  /**
   * Caixa do frontal desenhado. Define a proporção do equipamento e, com a
   * largura útil do rack, a escala px/unidade das portas.
   */
  readonly chassis: { readonly width: number; readonly height: number };
  /** Faixas fixas acima/abaixo das portas (cabeçalho, legendas, rodapé). */
  readonly chrome: { readonly top: number; readonly bottom: number };
  /** Região útil dos blocos de portas (`y` é o topo da primeira banda). */
  readonly ports: FixedFaceplateZone;
  /** Bandas de grupos, na ordem de desenho. */
  readonly bands: readonly FixedFaceplateBandSpec[];
  /** Respiro entre grupos da mesma banda (unidades). */
  readonly groupGap?: number;
  /** Respiro entre fileiras de portas (unidades). */
  readonly rowGap?: number;
  /**
   * Distribuição das sobras na largura útil: `between` mantém o primeiro grupo
   * na margem esquerda; `around` (padrão da biblioteca visual) dá meio respiro
   * em cada ponta e um respiro inteiro entre grupos, como o `space-around`.
   */
  readonly justify?: 'around' | 'between';
  /**
   * Colunas por bloco de jaulas (biblioteca visual: `8`). O respiro entre blocos
   * é maior que o passo entre colunas — é ele que desenha as quebras de 8 em 8
   * do painel real. `0` desliga (arranjo contínuo).
   */
  readonly columnBlock?: number;
  /** Respiro extra entre blocos de colunas (unidades). */
  readonly blockGap?: number;
}

/** Teto da altura visual de um equipamento **fixo** no desenho técnico (px). */
export const TECHNICAL_FIXED_MAX_HEIGHT = 140;

/** Colunas por bloco de jaulas na biblioteca visual. */
export const FIXED_COLUMN_BLOCK = 8;
/** Respiro extra entre blocos de 8 colunas (px). */
export const FIXED_BLOCK_GAP_PX = 6;

/** Respiro default entre grupos da mesma banda. */
export const FIXED_GROUP_GAP = 0.7;
/** Respiro default entre fileiras de portas do mesmo bloco. */
export const FIXED_ROW_GAP = 0.35;
/** Respiro default entre bandas empilhadas. */
export const FIXED_BAND_GAP = 0.8;
/** Distância mínima entre duas jaulas vizinhas quando o bloco precisa encolher. */
export const FIXED_MIN_PORT_GAP = 0.35;
/** Folga somada ao desenho no cálculo da altura visual (px). */
export const FIXED_FACEPLATE_PADDING = 4;
/** Linha extra da faixa de interfaces CLI (`100GE0/1/48–55`), quando existe. */
export const FIXED_INTERFACE_LINE_PX = 9;

/**
 * Chrome do chassi (moldura desenhada em volta das portas) em **pixels** — as
 * medidas de tela da biblioteca visual. `fixedFaceplateChrome()` converte para
 * unidades com a escala do perfil, de modo que o desenho inteiro acompanha a
 * largura do painel sem perder a proporção das jaulas.
 */
export const FIXED_CHASSIS_PX = {
  /** orelha de rack (coluna lateral com os furos) */
  earWidth: 22,
  /** respiro lateral interno do corpo */
  bodyPadX: 7,
  bodyPadTop: 5,
  bodyPadBottom: 5,
  /** cabeçalho interno: marca + modelo + LEDs + chip de U */
  headerHeight: 20,
  /** respiro entre cabeçalho e painel */
  headerGap: 5,
  /** margem interna acima da primeira fileira de jaulas */
  panelTop: 3,
  /** linha de legenda do bloco (borda + texto) */
  captionHeight: 11,
  /** respiro entre a última fileira e a legenda */
  captionGap: 4,
  /** rodapé de resumo (linha fina alinhada à direita) */
  summaryHeight: 12,
  /** respiro inferior interno */
  bodyPadBottomExtra: 5,
  /** LCD decorativo dos CCR (MikroTik) */
  lcdWidth: 60,
  lcdHeight: 29,
  /** respiro entre blocos (px) */
  gapPx: 10,
} as const;

/** Geometria do chrome do chassi já convertida para unidades de grade. */
export interface FixedFaceplateChrome {
  /** px por unidade de grade */
  scale: number;
  /** largura total do chassi (unidades) */
  chassisWidthUnits: number;
  /** largura útil da região das portas (unidades) */
  regionWidthUnits: number;
  /** faixa acima das portas (cabeçalho + respiro) */
  chromeTopUnits: number;
  /** faixa abaixo das portas (legendas + rodapé) */
  chromeBottomUnits: number;
  /** largura das orelhas (0 quando o perfil não desenha) */
  earUnits: number;
  /** respiro lateral do corpo */
  padUnits: number;
  /** largura reservada ao LCD (0 quando não existe) */
  lcdUnits: number;
  /** altura do cabeçalho interno */
  headerUnits: number;
  /** altura da faixa de legenda de cada bloco */
  captionUnits: number;
  /** altura do rodapé de resumo */
  summaryUnits: number;
  /** topo da primeira fileira de jaulas (unidades) */
  panelTopUnits: number;
  /** largura do bloco de LCD (unidades) */
  lcdWidthUnits: number;
  /** altura do bloco de LCD (unidades) */
  lcdHeightUnits: number;
}

/**
 * Converte o chrome (px da biblioteca visual) para as unidades do desenho.
 * A escala sai do perfil (`portScalePx`) e a largura útil do painel define a
 * largura total do chassi — nenhuma conta circular.
 */
export function fixedFaceplateChrome(input: {
  panelWidthPx: number;
  portScalePx: number;
  showRackEars?: boolean | undefined;
  showLcd?: boolean | undefined;
}): FixedFaceplateChrome {
  const scale = input.portScalePx > 0 ? input.portScalePx : 5.6;
  const chassisWidthUnits = input.panelWidthPx / scale;
  const earUnits = input.showRackEars ? FIXED_CHASSIS_PX.earWidth / scale : 0;
  const padUnits = FIXED_CHASSIS_PX.bodyPadX / scale;
  const lcdUnits = input.showLcd
    ? (FIXED_CHASSIS_PX.lcdWidth + FIXED_CHASSIS_PX.gapPx) / scale
    : 0;
  const headerUnits = FIXED_CHASSIS_PX.headerHeight / scale;
  const captionUnits = FIXED_CHASSIS_PX.captionHeight / scale;
  const summaryUnits = FIXED_CHASSIS_PX.summaryHeight / scale;
  const panelTopUnits = FIXED_CHASSIS_PX.panelTop / scale;
  return {
    scale,
    chassisWidthUnits,
    regionWidthUnits: Math.max(
      24,
      chassisWidthUnits - earUnits * 2 - padUnits * 2 - lcdUnits,
    ),
    chromeTopUnits: headerUnits + FIXED_CHASSIS_PX.headerGap / scale + panelTopUnits,
    chromeBottomUnits:
      FIXED_CHASSIS_PX.captionGap / scale +
      captionUnits +
      summaryUnits +
      FIXED_CHASSIS_PX.bodyPadBottomExtra / scale,
    earUnits,
    padUnits,
    lcdUnits,
    headerUnits,
    captionUnits,
    summaryUnits,
    panelTopUnits,
    lcdWidthUnits: FIXED_CHASSIS_PX.lcdWidth / scale,
    lcdHeightUnits: FIXED_CHASSIS_PX.lcdHeight / scale,
  };
}

interface FaceplateGroup {
  key: string;
  connectors: PlacedConnector[];
  /** shape desenhado por porta (já com o override do perfil, em unidades) */
  shapes: Map<string, { width: number; height: number; label: string }>;
  /** maior jaula do grupo (define o passo vertical da banda) */
  cellW: number;
  cellH: number;
  columns: number;
  rows: number;
  /** passo horizontal do grupo no arranjo de origem (unidades) */
  pitch: number;
  /** `true` quando o desenho usa o arranjo do catálogo (par/ímpar, etc.) */
  keepSourceArrangement: boolean;
}

export interface BuildFixedFaceplateOptions {
  /** escala do desenho (px por unidade): converte `portSizes` (px) em unidades. */
  readonly scalePx?: number;
  /**
   * Tamanho de jaula por **conector** (px, na escala do perfil). O motor troca o
   * `shape` do conector colocado — desenho e âncora usam o MESMO valor.
   */
  readonly portSizes?: Partial<
    Record<string, { readonly width: number; readonly height: number } | undefined>
  > | undefined;
}

/** Tamanho do conector em unidades (perfil px → unidades, senão o do catálogo). */
function connectorShapeUnits(
  connector: PlacedConnector,
  options: BuildFixedFaceplateOptions,
): { width: number; height: number; label: string } {
  const override = options.portSizes?.[connector.kind];
  const scalePx = options.scalePx ?? 0;
  if (!override || scalePx <= 0) return connector.shape;
  return {
    width: override.width / scalePx,
    height: override.height / scalePx,
    label: connector.shape.label,
  };
}

/** Agrupa os conectores por `groupKey` preservando a ordem de desenho. */
function collectFaceplateGroups(
  connectors: readonly PlacedConnector[],
  options: BuildFixedFaceplateOptions,
): FaceplateGroup[] {
  const buckets = new Map<string, PlacedConnector[]>();
  const shapes = new Map<string, { width: number; height: number; label: string }>();
  const order: string[] = [];
  for (const connector of connectors) {
    const key = connector.groupKey ?? connector.kind;
    shapes.set(connector.portId, connectorShapeUnits(connector, options));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(connector);
    else {
      buckets.set(key, [connector]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const group = buckets.get(key)!;
    const cellW = Math.max(...group.map((connector) => shapes.get(connector.portId)!.width));
    const cellH = Math.max(...group.map((connector) => shapes.get(connector.portId)!.height));
    const columns = new Set(group.map((connector) => connector.column)).size || 1;
    const rows = new Set(group.map((connector) => connector.row)).size || 1;
    // passo de origem: colunas únicas ordenadas por x (nunca menor que a jaula)
    const columnXs = [...new Set(group.map((connector) => connector.x))].sort(
      (left, right) => left - right,
    );
    const measured =
      columns > 1 && columnXs.length > 1
        ? (columnXs[columnXs.length - 1]! - columnXs[0]!) / (columnXs.length - 1)
        : cellW + FIXED_GROUP_GAP;
    return {
      key,
      connectors: group,
      shapes,
      cellW,
      cellH,
      columns,
      rows,
      pitch: Math.max(measured, cellW + FIXED_MIN_PORT_GAP),
      keepSourceArrangement: true,
    };
  });
}

/**
 * Distribui os grupos nas bandas declaradas pelo desenho. Grupos não citados
 * entram na última banda (nada desaparece do desenho) e uma banda sem nenhum
 * grupo existente é descartada.
 */
function resolveBands(
  groups: FaceplateGroup[],
  spec: FixedFaceplateLayoutSpec,
): Array<{ groups: FaceplateGroup[]; gapBefore: number }> {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const used = new Set<string>();
  const bands: Array<{ groups: FaceplateGroup[]; gapBefore: number }> = [];

  spec.bands.forEach((band, index) => {
    const resolved: FaceplateGroup[] = [];
    for (const groupSpec of band.groups) {
      const group = byKey.get(groupSpec.groupKey);
      if (!group || used.has(group.key)) continue;
      used.add(group.key);
      const declaredColumns = groupSpec.columns && groupSpec.columns > 0 ? groupSpec.columns : 0;
      const declaredRows = groupSpec.rows && groupSpec.rows > 0 ? groupSpec.rows : 0;
      const columns =
        declaredColumns ||
        (declaredRows ? Math.max(1, Math.ceil(group.connectors.length / declaredRows)) : 0) ||
        group.columns;
      const pitch =
        groupSpec.gapX && groupSpec.gapX > 0 ? group.cellW + groupSpec.gapX : group.pitch;
      resolved.push({
        ...group,
        columns,
        rows: Math.max(1, Math.ceil(group.connectors.length / columns)),
        pitch: Math.max(pitch, group.cellW + FIXED_MIN_PORT_GAP),
        keepSourceArrangement: columns === group.columns,
      });
    }
    bands.push({
      groups: resolved,
      gapBefore: band.gapBefore ?? (index === 0 ? 0 : FIXED_BAND_GAP),
    });
  });

  const leftovers = groups.filter((group) => !used.has(group.key));
  if (leftovers.length > 0) {
    if (bands.length === 0) bands.push({ groups: leftovers, gapBefore: 0 });
    else bands[bands.length - 1]!.groups.push(...leftovers);
  }
  return bands.filter((band) => band.groups.length > 0);
}

/**
 * Colunas por bloco de jaulas: a biblioteca visual quebra o bloco grande em
 * grupos de 8 colunas (`cols > 12`), deixando um respiro maior entre eles.
 */
function columnsPerBlock(columns: number, columnBlock: number): number {
  if (columnBlock <= 0 || columns <= 12) return columns;
  return Math.max(1, Math.min(columnBlock, columns));
}

/** Largura de `count` colunas já encostadas (último bloco). */
function runWidth(count: number, pitch: number, cellW: number): number {
  return Math.max(0, count - 1) * pitch + cellW;
}

/**
 * Largura desenhada de um grupo: os blocos de 8 colunas somam o respiro extra
 * entre si (`blockGap`), como no `FixedPortPanel` da biblioteca.
 */
function blockWidth(
  group: FaceplateGroup,
  pitchScale: number,
  columnBlock = 0,
  blockGap = 0,
): number {
  const pitch = group.pitch * pitchScale;
  const perBlock = columnsPerBlock(group.columns, columnBlock);
  const blocks = Math.max(1, Math.ceil(group.columns / perBlock));
  const lastColumns = group.columns - (blocks - 1) * perBlock;
  const gaps = Math.max(0, blocks - 1) * blockGap;
  return runWidth(perBlock, pitch, group.cellW) * (blocks - 1) + runWidth(lastColumns, pitch, group.cellW) + gaps;
}

/**
 * Redistribui as portas já colocadas pelo `buildPanelLayout` dentro do chassi
 * declarado pelo perfil visual. MESMOS conectores, mesmos ids — só o desenho muda.
 */
export function buildFixedFaceplateLayout(
  layout: PanelLayout,
  spec: FixedFaceplateLayoutSpec,
  options: BuildFixedFaceplateOptions = {},
): PanelLayout {
  const groups = collectFaceplateGroups(layout.connectors, options);
  const bands = resolveBands(groups, spec);
  const groupGap = spec.groupGap ?? FIXED_GROUP_GAP;
  const rowGap = spec.rowGap ?? FIXED_ROW_GAP;
  const justify = spec.justify ?? 'between';
  const columnBlock = spec.columnBlock ?? 0;
  const blockGap = Math.max(0, spec.blockGap ?? 0);

  const connectors: PlacedConnector[] = [];
  let top = spec.ports.y;
  let rows = 0;

  bands.forEach((band, bandIndex) => {
    if (bandIndex > 0) top += band.gapBefore;
    const cellH = Math.max(...band.groups.map((group) => group.cellH));
    const bandRows = Math.max(...band.groups.map((group) => group.rows));
    const bandHeight = bandRows * cellH + Math.max(0, bandRows - 1) * rowGap;

    // Passo ajustado: só encolhe (nunca estica) e nunca abaixo da folga mínima.
    const natural =
      band.groups.reduce((sum, group) => sum + blockWidth(group, 1, columnBlock, blockGap), 0) +
      groupGap * Math.max(0, band.groups.length - 1);
    let pitchScale = 1;
    if (natural > spec.ports.width) {
      const shapes = band.groups.reduce((sum, group) => sum + group.cellW, 0);
      const pitches = band.groups.reduce((sum, group) => sum + (group.columns - 1) * group.pitch, 0);
      const gaps =
        groupGap * Math.max(0, band.groups.length - 1) +
        band.groups.reduce(
          (sum, group) =>
            sum +
            Math.max(
              0,
              Math.ceil(group.columns / columnsPerBlock(group.columns, columnBlock)) - 1,
            ) *
              blockGap,
          0,
        );
      const fitted = pitches > 0 ? (spec.ports.width - shapes - gaps) / pitches : 1;
      const floor = Math.max(
        ...band.groups.map((group) =>
          group.columns > 1 ? (group.cellW + FIXED_MIN_PORT_GAP) / group.pitch : 0,
        ),
      );
      pitchScale = Math.max(Math.min(fitted, 1), Math.min(floor, 1));
    }

    const blocks = band.groups.map((group) => blockWidth(group, pitchScale, columnBlock, blockGap));
    const used =
      blocks.reduce((sum, width) => sum + width, 0) + groupGap * Math.max(0, band.groups.length - 1);
    const slack = Math.max(0, spec.ports.width - used);
    /**
     * Sobra da largura útil: `around` (biblioteca visual) dá meio respiro em cada
     * ponta e um respiro inteiro entre grupos, como o `space-around` do CSS;
     * `between` mantém o primeiro grupo na margem e joga tudo entre os grupos.
     */
    const count = band.groups.length;
    const margin = justify === 'around' && count > 0 ? slack / (2 * count) : 0;
    const gap =
      justify === 'around' ? groupGap + 2 * margin : groupGap + (count > 1 ? slack / (count - 1) : 0);
    let cursor = spec.ports.x + margin;

    band.groups.forEach((group, groupIndex) => {
      const groupHeight = group.rows * cellH + Math.max(0, group.rows - 1) * rowGap;
      const groupY = top + Math.max(0, (bandHeight - groupHeight) / 2);
      const pitch = group.pitch * pitchScale;
      const perBlock = columnsPerBlock(group.columns, columnBlock);
      const stride = runWidth(perBlock, pitch, group.cellW) + blockGap;
      group.connectors.forEach((connector, index) => {
        const column = group.keepSourceArrangement
          ? connector.column
          : index % group.columns;
        const row = group.keepSourceArrangement ? connector.row : Math.floor(index / group.columns);
        const shape = group.shapes.get(connector.portId) ?? connector.shape;
        const block = Math.floor(column / perBlock) * stride;
        const within = (column % perBlock) * pitch;
        connectors.push({
          ...connector,
          column,
          row,
          shape,
          x: cursor + block + within + (group.cellW - shape.width) / 2,
          y: groupY + row * (cellH + rowGap) + (cellH - shape.height) / 2,
        });
      });
      cursor += blocks[groupIndex]! + gap;
    });

    top += bandHeight;
    rows += bandRows;
  });

  const drawnHeight = Math.max(spec.chassis.height, top + spec.chrome.bottom);
  return {
    ...layout,
    width: spec.chassis.width,
    gridHeight: drawnHeight,
    rows,
    connectors,
  };
}

/**
 * Altura visual de um equipamento fixo com faceplate: a **proporção do frontal
 * real** (chassi + chrome) manda, com teto próprio (`TECHNICAL_FIXED_MAX_HEIGHT`)
 * para um switch 1U nunca virar um painel de 4–5U. A ocupação no rack
 * (`heightU`) continua exatamente a mesma — isto é só o desenho.
 */
export function fixedFaceplateDisplayHeight(input: {
  /** altura do chassi desenhado (unidades de grade) */
  gridHeight: number;
  /** largura do chassi desenhado (unidades de grade) */
  gridWidth: number;
  /** largura útil do painel no rack (px) */
  panelWidthPx: number;
  heightU: number;
  baseUnitHeight: number;
  /** cabeçalho + respiro já existentes na faceplate (px) */
  chromePx: number;
  /** linha extra pedida pelo conteúdo (ex.: faixa de interfaces CLI do grupo) */
  extraHeightPx?: number | undefined;
  /** teto do desenho (default: `TECHNICAL_FIXED_MAX_HEIGHT`) */
  maxHeightPx?: number | undefined;
}): number {
  const physical = Math.max(1, input.heightU) * input.baseUnitHeight;
  const scale = input.panelWidthPx / Math.max(1, input.gridWidth);
  const drawing =
    Math.round(input.gridHeight * scale) +
    FIXED_FACEPLATE_PADDING +
    Math.max(0, input.extraHeightPx ?? 0);
  const desired = input.chromePx + drawing;
  const ceiling = input.maxHeightPx ?? TECHNICAL_FIXED_MAX_HEIGHT;
  return Math.max(physical, Math.min(ceiling, desired));
}

/** Propriedades de layout legadas (compatível com a primeira passada). */
export interface FixedFaceplateSpecCompat extends FixedFaceplateLayoutSpec {
  readonly brand?: FixedFaceplateZone;
  readonly leds?: FixedFaceplateZone & { readonly labels?: readonly string[] };
  readonly vents?: readonly FixedFaceplateZone[];
}

/** Região de um grupo de portas no desenho (zona + rótulo do faceplate). */
export interface FixedFaceplateRegion {
  key: string;
  role: TechnicalGroupRole;
  /** Rótulo do bloco: família (`10GE`) ou papel (`UPLINK`) quando a família repete. */
  label: string;
  /** Faixa real de numeração do grupo (`0–27`, `33–36`), quando declarada. */
  range: string | null;
  /** Faixa de interfaces CLI do grupo, quando todas as portas têm nome. */
  interfaceRange: string | null;
  count: number;
  /** Zona em unidades de grade do chassi. */
  zone: FixedFaceplateZone;
}

/**
 * Regiões do faceplate: MESMA geometria das baías (`technicalGroupBays`), com o
 * rótulo ajustado ao desenho — família do bloco quando ela distingue os grupos
 * (`10GE · 0–27`, `25GE · 28–35`, `100GE · 48–55`) e papel quando dois grupos
 * compartilham a família (`SERVICE · 1–32`, `UPLINK · 33–36`).
 */
export function fixedFaceplateRegions(
  layout: Pick<PanelLayout, 'connectors'>,
  options: { interfaceNameOf?: (portId: string) => string | null } = {},
): FixedFaceplateRegion[] {
  const families = new Map<string, string | null>();
  const rolesByFamily = new Map<string, Set<TechnicalGroupRole>>();
  /** Ordem de desenho do grupo (primeira porta colocada) — a ordem física real. */
  const drawingOrder = new Map<string, number>();
  layout.connectors.forEach((connector, index) => {
    const key = connector.groupKey ?? connector.kind;
    if (!drawingOrder.has(key)) drawingOrder.set(key, index);
  });
  for (const bay of technicalGroupBays(layout, options)) {
    const group = layout.connectors.filter(
      (connector) => (connector.groupKey ?? connector.kind) === bay.key,
    );
    const prefixes = new Set(group.map((connector) => portFamilyPrefix(connector.portName)));
    const family = prefixes.size === 1 ? [...prefixes][0]! : null;
    families.set(bay.key, family);
    if (family) {
      const roles = rolesByFamily.get(family) ?? new Set<TechnicalGroupRole>();
      roles.add(bay.role);
      rolesByFamily.set(family, roles);
    }
  }

  return technicalGroupBays(layout, options)
    .map((bay) => {
      const family = families.get(bay.key) ?? null;
      const roles = family ? rolesByFamily.get(family) : null;
      const label =
        family && roles && roles.size === 1 ? family : TECHNICAL_GROUP_LABELS[bay.role];
      return {
        key: bay.key,
        role: bay.role,
        label,
        range: bay.range,
        interfaceRange: bay.interfaceRange,
        count: bay.count,
        zone: { x: bay.x, y: bay.y, width: bay.width, height: bay.height },
      };
    })
    .sort(
      (left, right) =>
        (drawingOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
        (drawingOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER),
    );
}
