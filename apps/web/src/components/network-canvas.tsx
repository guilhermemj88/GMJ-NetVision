'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ViewportPortal,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnNodesChange,
} from '@xyflow/react';
import {
  getMap,
  getMaps,
  updateNetworkMap,
} from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { computeParallelLinkLayouts } from '@gmj/shared';
import { countAlarmsByDevice, useActiveAlarms } from '@/lib/use-alarms';
import { useMapFocus } from '@/lib/use-map-focus';
import { DeviceNode, type DeviceFlowNode } from './device-node';
import { GenericNode, type GenericFlowNode } from './generic-node';
import { PppTotalWidget } from './ppp-total-widget';
import { TrafficEdge, type TrafficFlowEdge } from './traffic-edge';
import { TrafficEdgeV2, type LinkV2FlowEdge } from './traffic-edge-v2';
import {
  TrafficEdgeV2Weather,
  type LinkV2WeatherEdgeData,
  type LinkV2WeatherFlowEdge,
} from './traffic-edge-v2-weathermap';
import { MapControls } from './map-controls';
import { MapStatusBar } from './map-status-bar';
import { MapV2Legend } from './map-v2-legend';
import { EditToolbar } from './edit-toolbar';
import { AlarmPanel } from './alarm-panel';
import { resolveEdgeHandles } from '@/lib/edge-handles';
import {
  getTrafficLabelOffsets,
  subscribeTrafficLabelOffsets,
  type TrafficLabelOffsets,
} from '@/lib/traffic-label-offsets';
import { newestCollectionStamp } from '@/lib/map-freshness';
import { useMapVisualMode } from '@/lib/map-visual-v2-preview';
import { useLinkV2AnimationMode } from '@/lib/map-visual-v2-animation';
import { linkV2LabelPriority, resolveRealLinkV2 } from '@/lib/map-visual-v2-link';
import { manualLabelOffset } from '@/lib/map-visual-v2-offsets';
import {
  // Fase G: plaquetas EMBUTIDAS na linha — o candidato preferido fica sobre a
  // própria curva (offset 0) e só sai dela se a anticolisão exigir.
  WEATHER_PILL_EXTRA_OFFSETS,
  WEATHER_PILL_FONT_SIZE,
  WEATHER_PILL_FONT_SIZE_COMPACT,
  WEATHER_PILL_FONT_SIZE_SMALL,
  WEATHER_PILL_HEIGHT,
  WEATHER_PILL_HEIGHT_COMPACT,
  WEATHER_PILL_HEIGHT_SMALL,
  WEATHER_PILL_LANE_OFFSET,
  WEATHER_LABEL_HALF_FRACTION,
  resolveWeatherMap,
} from '@/lib/map-visual-v2-weathermap';
import {
  buildArcTable,
  halfAnchorPoint,
  splitGeometryAtLength,
} from '@/lib/map-visual-v2-arc';
import {
  resolveLinkV2LabelPlacements,
  type LinkV2LabelCandidate,
} from '@/lib/map-visual-v2-labels';
import {
  LINK_V2_EDGE_CURVATURE,
  buildBezierGeometry,
  perpendicularOf,
  pointOnBezier,
  tangentOf,
} from '@/lib/map-visual-v2-geometry';
import { PATH_OFFSET_SCALE } from '@/lib/link-curvature';
import {
  calculateSmartAlignment,
  type AlignmentGuide,
  type AlignmentNode,
} from '@/lib/smart-alignment';

const nodeTypes = { device: DeviceNode, generic: GenericNode };
const edgeTypes = {
  traffic: TrafficEdge,
  trafficV2: TrafficEdgeV2,
  trafficWeather: TrafficEdgeV2Weather,
};
type MapFlowNode = DeviceFlowNode | GenericFlowNode;
type MapFlowEdge = TrafficFlowEdge | LinkV2FlowEdge | LinkV2WeatherFlowEdge;
const DEFAULT_NODE_WIDTH = 64;
const DEFAULT_NODE_HEIGHT = 70;
const MAP_REFRESH_INTERVAL_MS = 30_000;
/** Passo do zoom usado para recalcular a anticolisão (evita refazer a cada frame). */
const LINK_V2_LABEL_ZOOM_STEP = 0.1;

function alignmentNode(node: MapFlowNode): AlignmentNode {
  return {
    id: node.id,
    position: node.position,
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
  };
}

/** Ponto de ancoragem de um lado do nó (mesma convenção dos handles da V1). */
function linkAnchorPoint(
  position: { x: number; y: number },
  size: { width: number; height: number },
  side: 'left' | 'right' | 'top' | 'bottom',
): { x: number; y: number } {
  switch (side) {
    case 'left':
      return { x: position.x, y: position.y + size.height / 2 };
    case 'right':
      return { x: position.x + size.width, y: position.y + size.height / 2 };
    case 'top':
      return { x: position.x + size.width / 2, y: position.y };
    case 'bottom':
      return { x: position.x + size.width / 2, y: position.y + size.height };
  }
}

export function NetworkCanvas({ readOnly: forcedReadOnly = false }: { readOnly?: boolean }) {
  const storeReadOnly = useMapStore((state) => state.readOnly);
  const readOnly = forcedReadOnly || storeReadOnly;
  const flow = useReactFlow();
  const viewportMapId = useRef<string | null>(null);
  const snappedPosition = useRef<{ nodeId: string; position: { x: number; y: number } } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const catalogQuery = useQuery({ queryKey: ['maps'], queryFn: getMaps, enabled: !readOnly });
  const activeMapId = useMapStore((state) => state.activeMapId);
  const map = useMapStore((state) => state.map);
  const setCatalog = useMapStore((state) => state.setCatalog);
  const applyMapRefresh = useMapStore((state) => state.applyMapRefresh);
  const editMode = useMapStore((state) => state.editMode) && !readOnly;
  /**
   * Labels arrastáveis: o modo liga o arrasto e os offsets vêm do localStorage
   * do mapa ativo (camada visual, não é dado do mapa).
   */
  const labelAdjustMode = useMapStore((state) => state.labelAdjustMode) && !readOnly;
  const emptyLabelOffsets = useMemo<TrafficLabelOffsets>(() => ({}), []);
  const labelOffsets = useSyncExternalStore(
    subscribeTrafficLabelOffsets,
    () => getTrafficLabelOffsets(activeMapId),
    () => emptyLabelOffsets,
  );
  const preferences = useMapStore((state) => state.preferences);
  const moveNode = useMapStore((state) => state.moveNode);
  const selection = useMapStore((state) => state.selection);
  const setSelection = useMapStore((state) => state.setSelection);
  const setPendingLink = useMapStore((state) => state.setPendingLink);
  const setPanel = useMapStore((state) => state.setPanel);
  const rotation = useMapStore((state) => state.rotation);
  const setRotationPaused = useMapStore((state) => state.setRotationPaused);
  const setViewport = useMapStore((state) => state.setViewport);
  const focusRequest = useMapStore((state) => state.focusRequest);
  const clearFocusRequest = useMapStore((state) => state.clearFocusRequest);

  const mapQuery = useQuery({
    queryKey: ['map', activeMapId],
    queryFn: () => getMap(activeMapId!),
    enabled: Boolean(activeMapId) && !readOnly,
    refetchInterval: MAP_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  // Alarmes ativos alimentam o badge de cada equipamento no mapa; o painel
  // compacto le a MESMA Central de Alertas (/api/alert-center).
  const alarms = useActiveAlarms(!readOnly);
  const alarmCountByDevice = useMemo(() => countAlarmsByDevice(alarms), [alarms]);

  // Recorte visual (camada + site + tipo + vizinhança). Não altera o grafo:
  // apenas marca o que fica atenuado.
  const focus = useMapFocus();

  useEffect(() => {
    if (!readOnly && catalogQuery.data) setCatalog(catalogQuery.data);
  }, [catalogQuery.data, readOnly, setCatalog]);

  useEffect(() => {
    if (readOnly) return;
    // Refresh automático: com edição pendente ele mescla só telemetria e
    // preserva a estrutura local (posições, geometria, escalas, widgets).
    if (mapQuery.data) applyMapRefresh(mapQuery.data);
  }, [mapQuery.data, readOnly, applyMapRefresh]);

  const hasSavedViewport = Boolean(
    map?.settings.viewport &&
      Number.isFinite(map.settings.viewport.x) &&
      Number.isFinite(map.settings.viewport.y) &&
      Number.isFinite(map.settings.viewport.zoom),
  );

  useEffect(() => {
    if (!map) {
      viewportMapId.current = null;
      return;
    }
    if (viewportMapId.current === map.id) return;
    viewportMapId.current = map.id;
    if (hasSavedViewport) {
      window.setTimeout(() => void flow.setViewport(map.settings.viewport, { duration: 280 }), 30);
    }
  }, [flow, map, hasSavedViewport]);

  // Node identity is React Flow's cache key: `setNodes` keeps a node's measured
  // dimensions and handle bounds only while the very same object is passed back
  // (`adoptUserNodes(..., { checkEquality: true })`). Rebuilding the array for an
  // unrelated change (a link geometry draft, a link PATCH, …) would therefore
  // discard every measurement for one commit, and edges are not rendered while
  // their endpoints are unmeasured. Depending on the actual inputs keeps the
  // node objects stable, and carrying `measured` over keeps the endpoints usable
  // even when the nodes really do change (map refetch, scale change, …).
  const mapNodes = map?.nodes;
  const mapDevices = map?.devices;
  const nodeDisplayMode = map?.settings.nodeDisplayMode;
  const nodeScale = map?.settings.nodeScale;
  const labelScale = map?.settings.labelScale;
  const measuredSizes = useRef(new Map<string, { width: number; height: number }>());

  /**
   * MAP-VISUAL-V2 (Fase D): modo visual do mapa. Padrão do produto = V1
   * (`Map.filters.visualMode` ausente); o preview permite alternar sem tocar no
   * mapa — a escolha fica só na aba do operador.
   */
  const visualMode = useMapVisualMode(map?.settings.filters);
  const glyphEngine = visualMode === 'V2' ? 'v2' : 'v1';
  /** Fase E: microanimação dos enlaces (só no preview; padrão inteligente). */
  const animationMode = useLinkV2AnimationMode();

  /** Relógio para o frescor da telemetria (só o V2 usa; 1 min de granularidade). */
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /** Zoom atual (para a anticolisão do V2), quantizado para não refazer a cada frame. */
  const zoomRaw = useStore((state) => state.transform[2]);
  const zoomForLabels = useMemo(() => {
    const safe = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1;
    const stepped = Math.round(safe / LINK_V2_LABEL_ZOOM_STEP) * LINK_V2_LABEL_ZOOM_STEP;
    return Math.max(0.25, stepped);
  }, [zoomRaw]);

  const domainNodes = useMemo<MapFlowNode[]>(() => {
    if (
      !mapNodes ||
      !mapDevices ||
      nodeDisplayMode === undefined ||
      nodeScale === undefined ||
      labelScale === undefined
    )
      return [];
    /**
     * Fase J: a seleção do nó é CONTROLADA pelo map-store (mesmo contrato dos
     * enlaces). Antes o destaque vinha só da seleção interna do React Flow, que
     * pode ser descartada num re-render (telemetria, mudança de zoom, troca de
     * camada) e deixava o nó "sem destaque" mesmo com o ContextDrawer aberto.
     */
    const selectedNodeId =
      selection?.kind === 'device' || selection?.kind === 'node' ? selection.id : null;
    return mapNodes.flatMap((mapNode): MapFlowNode[] => {
      const measured = measuredSizes.current.get(mapNode.deviceId ?? mapNode.id);
      if (mapNode.deviceId) {
        const device = mapDevices.find((item) => item.id === mapNode.deviceId);
        if (!device || (!preferences.showOffline && device.status === 'DOWN')) return [];
        return [{
          id: device.id,
          type: 'device',
          position: mapNode.position,
          draggable: editMode && !mapNode.locked,
          selected: device.id === selectedNodeId,
          ...(measured ? { measured } : {}),
          data: {
            device,
            mapNode,
            editMode,
            displayMode: nodeDisplayMode,
            nodeScale,
            labelScale,
            alarmCount: alarmCountByDevice.get(device.id) ?? 0,
            dimmed: focus.dimmedNodeIds.has(device.id),
            glyphEngine,
          },
        }];
      }
      return [{
        id: mapNode.id,
        type: 'generic',
        position: mapNode.position,
        draggable: editMode && !mapNode.locked,
        selected: mapNode.id === selectedNodeId,
        ...(measured ? { measured } : {}),
        data: {
          mapNode,
          editMode,
          displayMode: nodeDisplayMode,
          nodeScale,
          labelScale,
          dimmed: focus.dimmedNodeIds.has(mapNode.id),
          glyphEngine,
        },
      }];
    });
  }, [
    alarmCountByDevice,
    editMode,
    focus.dimmedNodeIds,
    glyphEngine,
    labelScale,
    mapDevices,
    mapNodes,
    nodeDisplayMode,
    nodeScale,
    preferences.showOffline,
    selection,
  ]);

  useEffect(() => {
    if (!focusRequest) return;
    const node = domainNodes.find((item) => item.id === focusRequest.deviceId);
    if (!node) return;
    const width = node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH;
    const height = node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT;
    void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      duration: 650,
      zoom: Math.max(1.05, flow.getZoom()),
    });
    clearFocusRequest(focusRequest.requestId);
  }, [clearFocusRequest, domainNodes, flow, focusRequest]);

  /**
   * MAP-VISUAL-V2 (Fase E): modelo do enlace BIDIRECIONAL dos enlaces REAIS +
   * posição dos rótulos (anticolisão global sobre a MESMA geometria desenhada).
   * `null` quando o mapa está em V1 — o caminho da produção fica intacto.
   */
  const linkV2EdgeData = useMemo<Map<string, LinkV2WeatherEdgeData> | null>(() => {
    if (!map || visualMode !== 'V2') return null;
    const collectionStamp = newestCollectionStamp(map.devices);
    const context = { nowMs: nowMs || Date.now(), collectionStamp };
    const handlesByKey = new Map(
      map.nodes.map((node) => [node.deviceId ?? node.id, node.position] as const),
    );
    const parallelLayouts = computeParallelLinkLayouts(
      map.links.map((link) => ({
        id: link.id,
        sourceKey: link.sourceDeviceId ?? link.sourceNodeId ?? '',
        targetKey: link.targetDeviceId ?? link.targetNodeId ?? '',
        layoutMode: link.linkLayoutMode ?? 'AUTO',
      })),
    );
    const rects = map.nodes.map((node) => {
      const measured = measuredSizes.current.get(node.deviceId ?? node.id);
      return {
        x: node.position.x,
        y: node.position.y,
        width: measured?.width ?? DEFAULT_NODE_WIDTH,
        height: measured?.height ?? DEFAULT_NODE_HEIGHT,
      };
    });
    const sizeByKey = new Map(
      map.nodes.map((node, index) => [
        node.deviceId ?? node.id,
        { width: rects[index]?.width ?? DEFAULT_NODE_WIDTH, height: rects[index]?.height ?? DEFAULT_NODE_HEIGHT },
      ] as const),
    );
    const selectedLinkId = selection?.kind === 'link' ? selection.id : null;
    const selectedNodeId =
      selection?.kind === 'device' || selection?.kind === 'node' ? selection.id : null;

    const entries = new Map<string, LinkV2WeatherEdgeData>();
    const candidates: LinkV2LabelCandidate[] = [];

    for (const link of map.links) {
      const sourceKey = link.sourceDeviceId ?? link.sourceNodeId ?? '';
      const targetKey = link.targetDeviceId ?? link.targetNodeId ?? '';
      const sourcePosition = handlesByKey.get(sourceKey);
      const targetPosition = handlesByKey.get(targetKey);
      if (!sourcePosition || !targetPosition) continue;
      const visual = resolveRealLinkV2(link, context);
      const manualOffset = manualLabelOffset(labelOffsets, link.id, visual.direction);
      const selected = selectedLinkId === link.id;
      const alarmCount =
        (link.sourceDeviceId ? (alarmCountByDevice.get(link.sourceDeviceId) ?? 0) : 0) +
        (link.targetDeviceId ? (alarmCountByDevice.get(link.targetDeviceId) ?? 0) : 0);
      const adjacentToSelectedNode =
        selectedNodeId !== null && (sourceKey === selectedNodeId || targetKey === selectedNodeId);
      const autoOffset = parallelLayouts.get(link.id)?.offset ?? 0;

      entries.set(link.id, {
        link,
        visual,
        animation: animationMode,
        manualOffset,
        manualHalf: visual.direction === 'b2a' ? 'b2a' : 'a2b',
        placements: { a2b: null, b2a: null, state: null },
        autoOffset,
        showLabels: preferences.showLabels,
        dimmed: focus.dimmedLinkIds.has(link.id),
        emphasized: adjacentToSelectedNode,
      });

      // Candidatos de rótulo: um por metade (o componente decide a visibilidade
      // por política, mas a anticolisão sempre tem uma posição pronta — inclusive
      // para o hover, que o canvas não conhece).
      const paths = (link.visualPaths?.length
        ? link.visualPaths
        : [{ order: 0, label: null, customColor: null, curvature: 0, enabled: true }]
      ).filter((path) => path.enabled);
      const primaryPath = paths[0];
      if (!primaryPath) continue;

      const handles = resolveEdgeHandles(
        sourcePosition,
        targetPosition,
        link.sourceHandleSide,
        link.targetHandleSide,
      );
      const sourceSize =
        sizeByKey.get(sourceKey) ?? { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
      const targetSize =
        sizeByKey.get(targetKey) ?? { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
      const sourceAnchor = linkAnchorPoint(sourcePosition, sourceSize, handles.sourceHandle);
      const targetAnchor = linkAnchorPoint(targetPosition, targetSize, handles.targetHandle);
      const geometry = buildBezierGeometry({
        sourceX: sourceAnchor.x,
        sourceY: sourceAnchor.y,
        sourcePosition: handles.sourceHandle,
        targetX: targetAnchor.x,
        targetY: targetAnchor.y,
        targetPosition: handles.targetHandle,
        curvature: LINK_V2_EDGE_CURVATURE,
        offset: autoOffset + (primaryPath.curvature ?? 0) * PATH_OFFSET_SCALE,
      });
      const arc = buildArcTable(geometry);
      const split = splitGeometryAtLength(geometry, arc, 0.5);
      const normal = perpendicularOf(geometry);
      const tangent = tangentOf(geometry);
      const weather = resolveWeatherMap(visual, { animation: animationMode, selected });
      const priorities = linkV2LabelPriority({ visual, selected, alarmCount });
      const laneOffset = WEATHER_PILL_LANE_OFFSET;
      // Fase J: deslizar ao longo do traço antes de sair da linha (18% da metade).
      const slideBudget = Math.max(0, Math.min(split.firstLength, split.secondLength)) * 0.18;

      for (const half of [weather.a2b, weather.b2a] as const) {
        if (!manualOffset && !half.label && !half.compactLabel) continue;
        candidates.push({
          id: `${link.id}:${half.key}`,
          anchor: halfAnchorPoint(
            geometry,
            arc,
            split,
            half.key === 'a2b' ? 'first' : 'second',
            WEATHER_LABEL_HALF_FRACTION,
          ),
          normal,
          tangent,
          tangentBudget: slideBudget,
          laneOffset,
          priority: priorities,
          text: half.label ?? half.compactLabel ?? '',
          compactText: half.compactLabel ?? half.label ?? '',
        });
      }
      if (weather.stateLabel && !manualOffset) {
        candidates.push({
          id: `${link.id}:state`,
          anchor: pointOnBezier(geometry, 0.5),
          normal,
          tangent,
          tangentBudget: slideBudget,
          laneOffset,
          priority: priorities,
          text: weather.stateLabel,
          compactText: weather.stateLabel,
        });
      }
    }

    const placements = resolveLinkV2LabelPlacements(candidates, rects, {
      scale: 1 / Math.max(0.25, zoomForLabels),
      fontSize: WEATHER_PILL_FONT_SIZE,
      height: WEATHER_PILL_HEIGHT,
      fontSizeSmall: WEATHER_PILL_FONT_SIZE_SMALL,
      heightSmall: WEATHER_PILL_HEIGHT_SMALL,
      fontSizeCompact: WEATHER_PILL_FONT_SIZE_COMPACT,
      heightCompact: WEATHER_PILL_HEIGHT_COMPACT,
      extraOffsets: WEATHER_PILL_EXTRA_OFFSETS,
    });
    for (const [id, entry] of entries) {
      entries.set(id, {
        ...entry,
        placements: {
          a2b: placements.get(`${id}:a2b`) ?? null,
          b2a: placements.get(`${id}:b2a`) ?? null,
          state: placements.get(`${id}:state`) ?? null,
        },
      });
    }
    return entries;
  }, [
    alarmCountByDevice,
    animationMode,
    focus.dimmedLinkIds,
    labelOffsets,
    map,
    nowMs,
    preferences.showLabels,
    selection,
    visualMode,
    zoomForLabels,
  ]);

  const domainEdges = useMemo<MapFlowEdge[]>(() => {
    if (!map) return [];
    const visible = new Set(domainNodes.map((node) => node.id));
    const positions = new Map(map.nodes.map((node) => [node.deviceId ?? node.id, node.position]));
    const devices = new Map(map.devices.map((device) => [device.id, device]));
    const parallelLayouts = computeParallelLinkLayouts(
      map.links.map((link) => ({
        id: link.id,
        sourceKey: link.sourceDeviceId ?? link.sourceNodeId ?? '',
        targetKey: link.targetDeviceId ?? link.targetNodeId ?? '',
        layoutMode: link.linkLayoutMode ?? 'AUTO',
      })),
    );
    return map.links.flatMap((link) => {
      const sourceKey = link.sourceDeviceId ?? link.sourceNodeId ?? '';
      const targetKey = link.targetDeviceId ?? link.targetNodeId ?? '';
      const sourcePosition = positions.get(sourceKey);
      const targetPosition = positions.get(targetKey);
      if (!visible.has(sourceKey) || !visible.has(targetKey)) return [];
      const handles = sourcePosition && targetPosition
        ? resolveEdgeHandles(
            sourcePosition,
            targetPosition,
            link.sourceHandleSide,
            link.targetHandleSide,
          )
        : { sourceHandle: 'right' as const, targetHandle: 'left' as const };
      const sourceInterface = link.sourceDeviceId
        ? devices.get(link.sourceDeviceId)?.interfaces.find((item) => item.id === link.sourceInterfaceId)
        : undefined;
      const targetInterface = link.targetDeviceId
        ? devices.get(link.targetDeviceId)?.interfaces.find((item) => item.id === link.targetInterfaceId)
        : undefined;
      const selectedId =
        selection?.kind === 'device' || selection?.kind === 'node' ? selection.id : null;
      const paths = (link.visualPaths?.length
        ? link.visualPaths
        : [{ order: 0, label: null, customColor: null, curvature: 0, enabled: true }])
        .map((visualPath, pathIndex) => ({ visualPath, pathIndex }))
        .filter(({ visualPath }) => visualPath.enabled);
      return paths.map(({ visualPath, pathIndex }, visibleIndex): MapFlowEdge => {
        const edgeId = pathIndex === 0 ? link.id : `${link.id}:path:${pathIndex}`;
        const selected = selection?.kind === 'link' && selection.id === link.id;
        const v2 = linkV2EdgeData?.get(link.id);
        if (v2) {
          const weatherData: LinkV2WeatherEdgeData = {
            ...v2,
            visualPath,
            // Um conjunto de rótulos por enlace lógico: só o caminho principal
            // exibe valores; os demais caminhos seguem desenhando as metades.
            showLabels: v2.showLabels && visibleIndex === 0,
            placements: visibleIndex === 0 ? v2.placements : { a2b: null, b2a: null, state: null },
          };
          return {
            id: edgeId,
            source: sourceKey,
            target: targetKey,
            sourceHandle: handles.sourceHandle,
            targetHandle: handles.targetHandle,
            type: 'trafficWeather',
            selectable: true,
            selected,
            ...(focus.dimmedLinkIds.has(link.id) ? { className: 'is-dimmed' } : {}),
            data: weatherData,
          };
        }
        return {
          id: edgeId,
          source: sourceKey,
          target: targetKey,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type: 'traffic',
          selectable: true,
          selected,
          ...(focus.dimmedLinkIds.has(link.id) ? { className: 'is-dimmed' } : {}),
          data: {
            link,
            editMode,
            readOnly,
            labelOffsets,
            labelMapId: activeMapId,
          labelAdjust: labelAdjustMode,
          dimmed: focus.dimmedLinkIds.has(link.id),
          ...(sourceInterface ? { sourceInterface } : {}),
          ...(targetInterface ? { targetInterface } : {}),
          visualPath,
          pathIndex,
          isPrimaryPath: visibleIndex === 0,
          autoOffset: parallelLayouts.get(link.id)?.offset ?? 0,
          showTraffic: preferences.showTraffic,
          showUtilization: preferences.showUtilization,
          showLabels: preferences.showLabels,
          showTrafficAnimation: preferences.showTrafficAnimation,
          displayStyle: map.settings.linkDisplayStyle,
          metricDisplay: map.settings.linkMetricDisplay,
          trafficLabelMode: map.settings.trafficLabelMode,
          linkScale: map.settings.linkScale,
          labelScale: map.settings.labelScale,
          related: !selectedId || sourceKey === selectedId || targetKey === selectedId,
          emphasized: Boolean(selectedId) && (sourceKey === selectedId || targetKey === selectedId),
        },
        };
      });
    });
  }, [activeMapId, domainNodes, focus.dimmedLinkIds, labelAdjustMode, labelOffsets, linkV2EdgeData, map, preferences.showLabels, preferences.showTraffic, preferences.showUtilization, preferences.showTrafficAnimation, selection, editMode, readOnly]);

  const [nodes, setNodes] = useNodesState<MapFlowNode>([]);
  const [edges, setEdges] = useEdgesState<MapFlowEdge>([]);

  useEffect(() => setNodes(domainNodes), [domainNodes, setNodes]);
  useEffect(() => setEdges(domainEdges), [domainEdges, setEdges]);

  const onNodesChange: OnNodesChange<MapFlowNode> = useCallback(
    (changes) => {
      // React Flow reports every measurement as a `dimensions` change. Keeping
      // the last known size lets the node objects below stay initialized across
      // rebuilds, so edges are never dropped while a node is re-measured.
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions) {
          measuredSizes.current.set(change.id, change.dimensions);
        }
      }
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [setNodes],
  );

  const onNodeClick: NodeMouseHandler<MapFlowNode> = useCallback(
    (_event, node) => {
      setSelection(
        node.type === 'generic' ? { kind: 'node', id: node.id } : { kind: 'device', id: node.id },
      );
      if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
    }, [rotation.active, rotation.pauseOnInteraction, setRotationPaused, setSelection],
  );

  const onEdgeClick: EdgeMouseHandler<MapFlowEdge> = useCallback(
    (_event, edge) => {
      setSelection({ kind: 'link', id: edge.data?.link?.id ?? edge.id });
      if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
    }, [rotation.active, rotation.pauseOnInteraction, setRotationPaused, setSelection],
  );

  const onNodeDrag: OnNodeDrag<MapFlowNode> = useCallback(
    (_event, draggedNode) => {
      if (!editMode) return;
      setNodes((current) => {
        const dragged = alignmentNode(draggedNode);
        const others = current.filter((node) => node.id !== draggedNode.id).map(alignmentNode);
        const result = calculateSmartAlignment(dragged, others, 8 / flow.getZoom(), true);
        setAlignmentGuides(result.guides);
        snappedPosition.current = { nodeId: draggedNode.id, position: result.position };
        return current.map((node) => node.id === draggedNode.id
          ? { ...node, position: result.position }
          : node);
      });
    }, [editMode, flow, setNodes],
  );

  const clearAlignment = useCallback(() => {
    setAlignmentGuides([]);
    snappedPosition.current = null;
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editMode || !connection.source || !connection.target || connection.source === connection.target) return;
      setPendingLink({ sourceId: connection.source, targetId: connection.target });
      setPanel('create-link');
    }, [editMode, setPanel, setPendingLink],
  );

  if ((catalogQuery.isPending || mapQuery.isPending) && !map) {
    return (
      <div className="map-loading">
        <span className="map-loading__radar" />
        <strong>Inicializando Map Engine</strong>
        <small>Carregando topologia e métricas…</small>
      </div>
    );
  }

  return (
    <main className="map-shell">
      <ReactFlow<MapFlowNode, MapFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDrag={onNodeDrag}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => {
          setSelection(null);
          if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
        }}
        onNodeDragStop={(_event, node) => {
          const mapNode = map?.nodes.find((item) => (item.deviceId ?? item.id) === node.id);
          const finalPosition = snappedPosition.current?.nodeId === node.id
            ? snappedPosition.current.position
            : node.position;
          if (mapNode) moveNode(mapNode.id, finalPosition);
          clearAlignment();
        }}
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        nodesConnectable={editMode}
        nodesDraggable={editMode}
        fitView={!hasSavedViewport}
        fitViewOptions={{ padding: 0.16 }}
        minZoom={0.25}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        selectionOnDrag={editMode}
        panOnDrag={!editMode || [1, 2]}
        onMoveEnd={(_event, viewport) => {
          if (readOnly) return;
          setViewport(viewport);
          if (map) {
            void updateNetworkMap(map.id, { settings: { viewport } }).catch(() => undefined);
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={editMode ? 28 : 34} size={editMode ? 1.2 : 1} color={editMode ? '#26343f' : '#1b2832'} />
        {map?.widgets
          .filter((widget) => widget.type === 'PPP_TOTAL' && widget.enabled)
          .map((widget) => (
            <ViewportPortal key={widget.id}>
              <PppTotalWidget widget={widget} devices={map.devices} readOnly={readOnly} />
            </ViewportPortal>
          ))}
        {!readOnly && <AlarmPanel />}
        {editMode && alignmentGuides.length > 0 && (
          <ViewportPortal>
            {alignmentGuides.map((guide) => (
              <div key={`${guide.axis}-${guide.targetId}`}>
                <div
                  className={`smart-guide smart-guide--${guide.axis}`}
                  style={guide.axis === 'vertical'
                    ? { left: guide.coordinate, top: guide.start, height: Math.max(1, guide.end - guide.start) }
                    : { left: guide.start, top: guide.coordinate, width: Math.max(1, guide.end - guide.start) }}
                />
                <div
                  className="smart-guide-target"
                  style={{
                    left: guide.target.position.x,
                    top: guide.target.position.y,
                    width: guide.target.width,
                    height: guide.target.height,
                  }}
                />
              </div>
            ))}
          </ViewportPortal>
        )}
        {!rotation.hideControls && !readOnly && <MapControls />}
        {editMode && !rotation.active && !readOnly && <EditToolbar />}
      </ReactFlow>
      <MapStatusBar focus={focus} />
      {visualMode === 'V2' && <MapV2Legend animation={animationMode} />}
    </main>
  );
}
