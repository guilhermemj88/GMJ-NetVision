/**
 * MAP-VISUAL-V2 — construção do modelo do canvas (Fase B, laboratório).
 *
 * Transforma os cenários mock em descritores prontos para o React Flow:
 *  - resolve o estado visual de cada enlace (cores/estados vêm do lib puro);
 *  - agrupa LAG somente quando o mock declara o grupo (nunca por SUM/endpoints);
 *  - aplica as simulações do operador (DOWN / sem dados / stale);
 *  - calcula âncoras, offsets de irmãos paralelos e a anticolisão dos rótulos;
 *  - monta também o objeto NetworkLink mock para o renderer V1 real.
 *
 * Nada aqui toca API, banco, polling ou o mapa operacional.
 */

import {
  computeParallelLinkLayouts,
  trafficConsistency,
  defaultVisualPath,
  type DeviceStatus,
  type DirectionalLinkMetric,
  type NetworkLink,
} from '@gmj/shared';
import { PATH_OFFSET_SCALE } from '@/lib/link-curvature';
import {
  LINK_V2_STATE_LABELS,
  formatCompactBps,
  linkV2ArrowScale,
  linkV2CapacityTier,
  linkV2ScreenStrokeWidth,
  linkV2StateDescription,
  resolveLinkV2EdgeStroke,
  resolveLinkV2Visual,
  shouldShowLinkV2Label,
  type LinkV2EdgeStroke,
  type LinkV2Input,
  type LinkV2StrokeMode,
  type LinkV2Visual,
} from '@/lib/map-visual-v2';
import { manualLabelOffset, type ManualLabelOffset } from '@/lib/map-visual-v2-offsets';
import { pathEdgeId } from '@/lib/map-visual-v2-selection';
import type { TrafficLabelOffsets } from '@/lib/traffic-label-offsets';
import {
  resolveLinkV2LabelPlacements,
  type LinkV2LabelPlacement,
} from '@/lib/map-visual-v2-labels';
import {
  buildBezierGeometry,
  perpendicularOf,
  pointOnBezier,
  type Point,
  type SidePosition,
} from '@/lib/map-visual-v2-geometry';
import type { MockLink, MockLinkEnd, MockNode, MockScenario } from './v2-scenarios';

/** Mesma constante de curvatura do renderer V1 (EDGE_CURVATURE). */
export const LINK_V2_CURVATURE = 0.24;
export const LAB_NODE_WIDTH = 64;
export const LAB_NODE_HEIGHT = 70;
/** Deslocamento perpendicular inicial da pílula, para não sentar no traço. */
export const LAB_LABEL_LIFT = 14;
export const LAB_SAMPLE_AGE_SECONDS = 25;

export type LinkV2SimulationMode = 'down' | 'no-data' | 'stale';

export interface LinkV2Simulation {
  linkId: string;
  mode: LinkV2SimulationMode;
}

export interface LinkV2TooltipModel {
  aName: string;
  bName: string;
  capacityText: string;
  metricsSource: string;
  aToBText: string;
  bToAText: string;
  consistencyText: string;
  sampleText: string;
  stateLabel: string;
  description: string;
  alarmsText: string | null;
  simulationTag: string | null;
}

export interface LinkV2EdgeModel {
  id: string;
  linkId: string;
  /** Id de seleção no contrato do mapa (`{ kind: 'link', id }`). */
  selectionId: string;
  /** Índice do caminho visual (0 = primário) — encoding `${linkId}:path:n`. */
  pathIndex: number;
  label: string;
  a: string;
  b: string;
  aName: string;
  bName: string;
  sourceHandle: string;
  targetHandle: string;
  sourceSide: SidePosition;
  targetSide: SidePosition;
  curvature: number;
  /** Offset dos irmãos paralelos (repassado ao renderer V1 em modo V1). */
  autoOffset: number;
  offset: number;
  visual: LinkV2Visual;
  /** Espessura/padrão já resolvidos para o modo de compensação escolhido. */
  stroke: LinkV2EdgeStroke;
  /** Espessura do halo de seleção (mantém 5 px de tela a mais). */
  haloStrokeWidth: number;
  arrowScale: number;
  /** Deslocamento manual lido do contrato da V1 (unidades de fluxo). */
  manualLabelOffset: ManualLabelOffset | null;
  labelText: string;
  compactLabelText: string;
  priority: number;
  simTag: string | null;
  logicalLinkId: string | null;
  lagGroupId: string | null;
  tooltip: LinkV2TooltipModel;
  /** Objeto do renderer V1 (mock), usado quando o visual é V1. */
  networkLink: NetworkLink;
}

export interface LinkV2GroupModel {
  groupId: string;
  label: string;
  a: string;
  b: string;
  memberIds: string[];
  memberCount: number;
  downMembers: number;
  noDataMembers: number;
  declaredCapacityBps: number | null;
}

export interface LinkV2Model {
  edges: LinkV2EdgeModel[];
  groups: LinkV2GroupModel[];
  placements: Map<string, LinkV2LabelPlacement>;
  /** Tempo total de reconstrução (nós + estados + geometria + rótulos). */
  buildMs: number;
  /** Tempo só da anticolisão de rótulos. */
  labelsMs: number;
  /** Quantos rótulos vieram de offset manual da V1. */
  manualLabelCount: number;
}

export interface LinkV2ModelOptions {
  nowMs: number;
  showAllLabels: boolean;
  selectedEdgeId: string | null;
  selectedNodeId: string | null;
  simulation: LinkV2Simulation | null;
  expandedLagIds: readonly string[];
  /** Posições atuais dos nós (arrasto do operador); ausente usa o cenário. */
  positions?: Record<string, { x: number; y: number }>;
  /** Zoom atual do React Flow — mantém a anticolisão fiel ao que se vê. */
  zoom?: number;
  /** Compensação de espessura (Fase C). Padrão: 'zoom' (clamp em px de tela). */
  strokeMode?: LinkV2StrokeMode;
  /** Offsets manuais de rótulo da V1 (leitura; nunca reescritos). */
  labelOffsets?: TrafficLabelOffsets | null;
}

const NO_DATA_END: MockLinkEnd = { bps: null, sampleAgeSeconds: null, observedRxPercent: null };

function applySimulation(
  link: MockLink,
  simulation: LinkV2Simulation | null,
  groupId: string | null,
): { link: MockLink; simTag: string | null } {
  if (!simulation) return { link, simTag: null };
  const targetsGroup = groupId !== null && simulation.linkId === `lag:${groupId}`;
  if (simulation.linkId !== link.id && !targetsGroup) return { link, simTag: null };
  switch (simulation.mode) {
    case 'down':
      return { link: { ...link, status: 'down', aToB: NO_DATA_END, bToA: NO_DATA_END }, simTag: 'DOWN simulado' };
    case 'no-data':
      return { link: { ...link, aToB: NO_DATA_END, bToA: NO_DATA_END }, simTag: 'sem dados simulado' };
    case 'stale':
      return {
        link: {
          ...link,
          aToB: link.aToB.sampleAgeSeconds === null ? link.aToB : { ...link.aToB, sampleAgeSeconds: 600 },
          bToA: link.bToA.sampleAgeSeconds === null ? link.bToA : { ...link.bToA, sampleAgeSeconds: 600 },
        },
        simTag: 'stale simulado',
      };
  }
}

function directionInput(end: MockLinkEnd, nowMs: number): LinkV2Input['aToB'] {
  const sampledAtMs =
    end.bps !== null && end.sampleAgeSeconds !== null ? nowMs - end.sampleAgeSeconds * 1000 : null;
  return { bps: end.bps, sampledAtMs };
}

function linkInput(link: MockLink, nowMs: number): LinkV2Input {
  return {
    operational: link.status,
    capacityBps: link.capacityBps,
    aToB: directionInput(link.aToB, nowMs),
    bToA: directionInput(link.bToA, nowMs),
    ...(link.inconsistent ? { inconsistent: true } : {}),
    ...(link.alarms ? { alarms: link.alarms } : {}),
  };
}

/** LAG: soma por sentido SÓ entre membros do grupo declarado; nunca inventa capacidade. */
function lagGroupInput(members: readonly MockLink[], nowMs: number): LinkV2Input {
  const declared = members[0]?.lag?.declaredCapacityBps ?? null;
  const downMembers = members.filter((member) => member.status === 'down').length;
  const aggregate = (field: 'aToB' | 'bToA'): LinkV2Input['aToB'] => {
    const usable = members.filter((member) => member.status !== 'down' && member[field].bps !== null);
    if (usable.length === 0) return { bps: null, sampledAtMs: null };
    const bps = usable.reduce((total, member) => total + (member[field].bps ?? 0), 0);
    const ages = usable
      .map((member) => member[field].sampleAgeSeconds)
      .filter((age): age is number => age !== null);
    const sampledAtMs = ages.length ? nowMs - Math.min(...ages) * 1000 : null;
    return { bps, sampledAtMs };
  };
  return {
    // Membro DOWN em grupo misto: estado parcialmente conhecido, sem fingir UP.
    operational: downMembers > 0 ? 'unknown' : 'up',
    capacityBps: declared,
    aToB: aggregate('aToB'),
    bToA: aggregate('bToA'),
  };
}

function sideFor(a: MockNode, b: MockNode): { source: SidePosition; target: SidePosition } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  }
  return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}

export function nodeAnchor(node: MockNode, side: SidePosition): Point {
  switch (side) {
    case 'left':
      return { x: node.x, y: node.y + LAB_NODE_HEIGHT / 2 };
    case 'right':
      return { x: node.x + LAB_NODE_WIDTH, y: node.y + LAB_NODE_HEIGHT / 2 };
    case 'top':
      return { x: node.x + LAB_NODE_WIDTH / 2, y: node.y };
    case 'bottom':
      return { x: node.x + LAB_NODE_WIDTH / 2, y: node.y + LAB_NODE_HEIGHT };
  }
}

function statusToDevice(status: MockLink['status']): DeviceStatus {
  if (status === 'down') return 'DOWN';
  if (status === 'unknown') return 'UNKNOWN';
  return 'UP';
}

function directionMetric(
  end: MockLinkEnd,
  capacityBps: number | null,
  utilization: number | null,
): DirectionalLinkMetric {
  const txBps = end.bps;
  const observedRxBps =
    capacityBps !== null && end.observedRxPercent !== null
      ? (capacityBps * end.observedRxPercent) / 100
      : null;
  const { deltaPercent, consistency } = trafficConsistency(txBps, observedRxBps);
  return {
    bps: txBps ?? 0,
    utilization: utilization ?? 0,
    txBps,
    observedRxBps,
    deltaPercent,
    consistency,
  };
}

/** Objeto NetworkLink mock completo para reaproveitar o renderer V1 real. */
export function toNetworkLinkMock(link: MockLink, visual: LinkV2Visual): NetworkLink {
  return {
    id: link.id,
    mapId: 'LAB-DEMO',
    sourceDeviceId: link.a,
    sourceInterfaceId: null,
    targetDeviceId: link.b,
    targetInterfaceId: null,
    sourceNodeId: link.a,
    targetNodeId: link.b,
    capacityBps: link.capacityBps ?? 0,
    autoCapacityBps: link.capacityBps ?? 0,
    capacitySource: 'MANUAL',
    trafficMode: 'BIDIRECTIONAL',
    customColor: null,
    trafficColorAToB: null,
    trafficColorBToA: null,
    inlineLabelPositionAToB: null,
    inlineLabelPositionBToA: null,
    animationEnabled: false,
    label: link.label,
    status: statusToDevice(link.status),
    discoverySource: 'MANUAL',
    metricSource: 'DEMO',
    visualStyle: null,
    metricDisplay: null,
    aggregationMode: 'NONE',
    metricSources: [],
    visualPaths: [{ ...defaultVisualPath(0), curvature: link.curvature ?? 0 }],
    linkLayoutMode: 'AUTO',
    sourceHandleSide: 'AUTO',
    targetHandleSide: 'AUTO',
    directions: {
      A_TO_B: directionMetric(link.aToB, link.capacityBps, visual.aToB.utilizationPercent),
      B_TO_A: directionMetric(link.bToA, link.capacityBps, visual.bToA.utilizationPercent),
    },
    rxBps: link.bToA.bps ?? 0,
    txBps: link.aToB.bps ?? 0,
    rxUtilization: visual.bToA.utilizationPercent ?? 0,
    txUtilization: visual.aToB.utilizationPercent ?? 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    createdAt: '',
    updatedAt: '',
  };
}

function directionText(end: MockLinkEnd, utilization: number | null, capacityBps: number | null): string {
  const observedRxBps =
    capacityBps !== null && end.observedRxPercent !== null
      ? (capacityBps * end.observedRxPercent) / 100
      : null;
  if (end.bps === null) return 'sem amostra';
  const parts = [`${formatCompactBps(end.bps)} tx`];
  if (observedRxBps !== null) parts.push(`${formatCompactBps(observedRxBps)} rx`);
  if (utilization !== null) parts.push(`${Math.round(utilization)}%`);
  if (end.sampleAgeSeconds !== null) parts.push(`${Math.round(end.sampleAgeSeconds)}s`);
  return parts.join(' · ');
}

function buildTooltip(
  link: MockLink,
  visual: LinkV2Visual,
  aName: string,
  bName: string,
  simTag: string | null,
): LinkV2TooltipModel {
  const { deltaPercent, consistency } = trafficConsistency(
    link.aToB.bps,
    link.capacityBps !== null && link.aToB.observedRxPercent !== null
      ? (link.capacityBps * link.aToB.observedRxPercent) / 100
      : null,
  );
  const ages = [link.aToB.sampleAgeSeconds, link.bToA.sampleAgeSeconds].filter(
    (age): age is number => age !== null,
  );
  return {
    aName,
    bName,
    capacityText: link.capacityBps
      ? `${formatCompactBps(link.capacityBps)} · ${linkV2CapacityTier(link.capacityBps)?.label ?? ''}`.trim()
      : 'capacidade não declarada',
    metricsSource: 'DEMO (mock do laboratório)',
    aToBText: directionText(link.aToB, visual.aToB.utilizationPercent, link.capacityBps),
    bToAText: directionText(link.bToA, visual.bToA.utilizationPercent, link.capacityBps),
    consistencyText:
      consistency === 'UNKNOWN'
        ? 'sem validação de consistência'
        : `${consistency === 'CONSISTENT' ? 'consistente' : 'divergente'}${
            deltaPercent !== null ? ` (${Math.round(deltaPercent)}%)` : ''
          }`,
    sampleText: ages.length ? `amostra há ${Math.min(...ages)}s` : 'sem carimbo de coleta',
    stateLabel: LINK_V2_STATE_LABELS[visual.state],
    description: linkV2StateDescription(visual),
    alarmsText: link.alarms ? `${link.alarms} alarme(s) relacionado(s)` : null,
    simulationTag: simTag,
  };
}

/** Histórico demonstrativo determinístico (mesmo enlace → mesma série). */
export function mockLinkHistory(seed: string, currentPercent: number, points = 48): number[] {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const random = () => {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return ((hash ^= hash >>> 16) >>> 0) / 4294967296;
  };
  const series: number[] = [];
  let value = Math.max(2, currentPercent * 0.55);
  for (let index = 0; index < points; index += 1) {
    value +=
      (currentPercent - value) * 0.12 +
      (random() - 0.5) * Math.max(3, currentPercent * 0.12);
    series.push(Math.max(0, Math.min(120, value)));
  }
  return series;
}

interface EffectiveEdge {
  id: string;
  link: MockLink;
  group: LinkV2GroupModel | null;
  input: LinkV2Input;
  simTag: string | null;
  /** Chave lógica usada no fan-out dos irmãos paralelos. */
  logicalKey: string;
}

export function buildLinkV2Model(
  scenario: MockScenario,
  options: LinkV2ModelOptions,
): LinkV2Model {
  const startedAt = performance.now();
  const nowMs = options.nowMs;
  const zoom = options.zoom ?? 1;
  const strokeMode = options.strokeMode ?? 'zoom';
  const resolvedNodes = scenario.nodes.map((node) => ({
    ...node,
    ...(options.positions?.[node.id] ?? {}),
  }));
  const nodeById = new Map(resolvedNodes.map((node) => [node.id, node]));
  const expanded = new Set(options.expandedLagIds);

  // 1) Simulações por enlace.
  const simulated = scenario.links.map((link) => {
    const { link: applied, simTag } = applySimulation(link, options.simulation, link.lag?.groupId ?? null);
    return { link: applied, simTag };
  });

  // 2) LAG declarado no mock: agrupa ou expande. Nenhum agrupamento por SUM.
  const lagGroups = new Map<string, typeof simulated>();
  for (const entry of simulated) {
    const groupId = entry.link.lag?.groupId;
    if (!groupId) continue;
    const bucket = lagGroups.get(groupId) ?? [];
    bucket.push(entry);
    lagGroups.set(groupId, bucket);
  }

  const effective: EffectiveEdge[] = [];
  const groups: LinkV2GroupModel[] = [];

  for (const [groupId, members] of lagGroups) {
    const first = members[0];
    if (!first) continue;
    const downMembers = members.filter((member) => member.link.status === 'down').length;
    const noDataMembers = members.filter(
      (member) => member.link.aToB.bps === null && member.link.bToA.bps === null,
    ).length;
    const groupModel: LinkV2GroupModel = {
      groupId,
      label: first.link.lag?.label ?? groupId,
      a: first.link.a,
      b: first.link.b,
      memberIds: members.map((member) => member.link.id),
      memberCount: members.length,
      downMembers,
      noDataMembers,
      declaredCapacityBps: first.link.lag?.declaredCapacityBps ?? null,
    };
    groups.push(groupModel);

    if (expanded.has(groupId)) {
      for (const member of members) {
        effective.push({
          id: member.link.id,
          link: member.link,
          group: groupModel,
          input: linkInput(member.link, nowMs),
          simTag: member.simTag,
          logicalKey: member.link.id,
        });
      }
    } else {
      const representative = members[0];
      if (!representative) continue;
      effective.push({
        id: `lag:${groupId}`,
        link: representative.link,
        group: groupModel,
        input: lagGroupInput(members.map((member) => member.link), nowMs),
        simTag: members.find((member) => member.simTag)?.simTag ?? null,
        logicalKey: `lag:${groupId}`,
      });
    }
  }

  const grouped = new Set([...lagGroups.values()].flat().map((entry) => entry.link.id));
  for (const entry of simulated) {
    if (grouped.has(entry.link.id)) continue;
    effective.push({
      id: entry.link.id,
      link: entry.link,
      group: null,
      input: linkInput(entry.link, nowMs),
      simTag: entry.simTag,
      logicalKey: entry.link.logicalLinkId ?? entry.link.id,
    });
  }

  // 3) Fan-out dos irmãos paralelos por par de nós (chave lógica única).
  const siblingInputs = new Map<string, { sourceKey: string; targetKey: string }>();
  for (const edge of effective) {
    if (!siblingInputs.has(edge.logicalKey)) {
      siblingInputs.set(edge.logicalKey, { sourceKey: edge.link.a, targetKey: edge.link.b });
    }
  }
  const siblingLayouts = computeParallelLinkLayouts(
    [...siblingInputs.entries()].map(([id, pair]) => ({
      id,
      sourceKey: pair.sourceKey,
      targetKey: pair.targetKey,
      layoutMode: 'AUTO' as const,
    })),
  );

  // 4) Estado visual + geometria + rótulos.
  const edges: LinkV2EdgeModel[] = [];
  const candidates = [];
  /** Rótulos são constantes na tela; em zoom < 1 ocupam mais unidades de fluxo. */
  const labelScale = 1 / Math.max(0.25, zoom);
  /**
   * Caminhos visuais do MESMO enlace recebem o encoding do mapa operacional
   * (`linkId` no primário, `linkId:path:n` nos extras) — ver mapa-visual-v2-selection.
   */
  const nextPathIndex = new Map<string, number>();

  for (const edge of effective) {
    const visual = resolveLinkV2Visual(edge.input, { nowMs });
    const a = nodeById.get(edge.link.a);
    const b = nodeById.get(edge.link.b);
    if (!a || !b) continue;
    const sides = sideFor(a, b);
    const curvature = edge.link.curvature ?? 0;
    const autoOffset = siblingLayouts.get(edge.logicalKey)?.offset ?? 0;
    const offset = autoOffset + curvature * PATH_OFFSET_SCALE;
    const geometry = buildBezierGeometry({
      sourceX: nodeAnchor(a, sides.source).x,
      sourceY: nodeAnchor(a, sides.source).y,
      sourcePosition: sides.source,
      targetX: nodeAnchor(b, sides.target).x,
      targetY: nodeAnchor(b, sides.target).y,
      targetPosition: sides.target,
      curvature: LINK_V2_CURVATURE,
      offset,
    });
    const midpoint = pointOnBezier(geometry, 0.5);
    const normal = perpendicularOf(geometry);

    const selectionId = edge.link.logicalLinkId ?? edge.link.id;
    const pathIndex = nextPathIndex.get(selectionId) ?? 0;
    nextPathIndex.set(selectionId, pathIndex + 1);
    /**
     * LAG recolhido mantém o id próprio do grupo (`lag:<groupId>`) — é o alvo
     * das simulações e do botão de expansão; a seleção continua sendo o link
     * representante (`selectionId`). Nos demais enlaces o id segue o encoding
     * do mapa operacional (`linkId` no primário, `linkId:path:n` nos extras).
     */
    const edgeId = edge.id.startsWith('lag:') ? edge.id : pathEdgeId(selectionId, pathIndex);
    const selected = edgeId === options.selectedEdgeId;
    const manualOffset = manualLabelOffset(options.labelOffsets ?? null, selectionId, visual.direction);
    const adjacentToSelectedNode =
      options.selectedNodeId !== null &&
      (edge.group
        ? edge.group.memberIds.some((memberId) => {
            const member = scenario.links.find((item) => item.id === memberId);
            return member?.a === options.selectedNodeId || member?.b === options.selectedNodeId;
          })
        : edge.link.a === options.selectedNodeId || edge.link.b === options.selectedNodeId);

    const showByPolicy = shouldShowLinkV2Label(visual, {
      showAll: options.showAllLabels,
      selected,
      hovered: false,
      adjacentToSelectedNode,
    });

    const priority = selected
      ? 3
      : visual.state === 'down' || (edge.link.alarms ?? 0) > 0 || (edge.group?.downMembers ?? 0) > 0
        ? 2
        : visual.state !== 'normal'
          ? 1
          : 0;

    const groupTag = edge.group
      ? `${edge.group.memberCount} membros${
          edge.group.downMembers ? ` · ${edge.group.downMembers} DOWN` : ''
        }`
      : null;
    const labelText = groupTag
      ? visual.utilizationPercent !== null
        ? `${formatCompactBps(visual.dominantBps)} · ${Math.round(visual.utilizationPercent)}% · ${groupTag}`
        : groupTag
      : visual.labelText;
    const compactLabelText = groupTag
      ? `${edge.group?.memberCount ?? 0}x${
          visual.utilizationPercent !== null ? ` · ${Math.round(visual.utilizationPercent)}%` : ''
        }`
      : visual.utilizationPercent !== null
        ? `${Math.round(visual.utilizationPercent)}%`
        : '—';

    const edgeStroke = resolveLinkV2EdgeStroke({
      mode: strokeMode,
      capacityBps: edge.link.capacityBps,
      dash: visual.strokeDasharray,
      zoom,
    });

    const model: LinkV2EdgeModel = {
      id: edgeId,
      linkId: edge.link.id,
      selectionId,
      pathIndex,
      label: edge.group ? `${edge.group.label} (${edge.link.label})` : edge.link.label,
      a: edge.link.a,
      b: edge.link.b,
      aName: a.name,
      bName: b.name,
      sourceHandle: `s-${sides.source}`,
      targetHandle: `t-${sides.target}`,
      sourceSide: sides.source,
      targetSide: sides.target,
      curvature,
      autoOffset,
      offset,
      visual,
      stroke: edgeStroke,
      haloStrokeWidth: edgeStroke.strokeWidth + (strokeMode === 'zoom' ? 5 / Math.max(0.25, zoom) : 5),
      arrowScale: linkV2ArrowScale(
        strokeMode,
        linkV2ScreenStrokeWidth(edge.link.capacityBps),
        zoom,
      ),
      manualLabelOffset: manualOffset,
      labelText,
      compactLabelText,
      priority,
      simTag: edge.simTag,
      logicalLinkId: edge.link.logicalLinkId ?? null,
      lagGroupId: edge.group?.groupId ?? null,
      tooltip: buildTooltip(edge.link, visual, a.name, b.name, edge.simTag),
      networkLink: toNetworkLinkMock(edge.link, visual),
    };
    edges.push(model);

    if (showByPolicy && !manualOffset) {
      candidates.push({
        id: edgeId,
        anchor: midpoint,
        normal,
        laneOffset: LAB_LABEL_LIFT * labelScale,
        priority,
        text: labelText,
        compactText: compactLabelText,
      });
    }
  }

  const labelsStarted = performance.now();
  const nodeRects = resolvedNodes.map((node) => ({
    x: node.x,
    y: node.y,
    width: LAB_NODE_WIDTH,
    height: LAB_NODE_HEIGHT,
  }));
  const placements = resolveLinkV2LabelPlacements(candidates, nodeRects, { scale: labelScale });
  const labelsMs = performance.now() - labelsStarted;

  /**
   * Offsets manuais da V1 vencem a anticolisão: posição do operador é
   * preservada como está (mesmas unidades de fluxo, nada é reescrito).
   */
  let manualLabelCount = 0;
  for (const edge of edges) {
    if (edge.manualLabelOffset) {
      manualLabelCount += 1;
      placements.set(edge.id, {
        mode: 'full',
        dx: edge.manualLabelOffset.dx,
        dy: edge.manualLabelOffset.dy,
      });
    }
  }

  return {
    edges,
    groups,
    placements,
    buildMs: performance.now() - startedAt,
    labelsMs,
    manualLabelCount,
  };
}
