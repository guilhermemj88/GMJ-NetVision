'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type Connection,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnNodesChange,
} from '@xyflow/react';
import {
  getMap,
  getMaps,
  getAlarms,
  getRecentResolvedAlarms,
  updateNetworkMap,
} from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { computeParallelLinkLayouts, type Alarm } from '@gmj/shared';
import { DeviceNode, type DeviceFlowNode } from './device-node';
import { GenericNode, type GenericFlowNode } from './generic-node';
import { PppTotalWidget } from './ppp-total-widget';
import { TrafficEdge, type TrafficFlowEdge } from './traffic-edge';
import { MapControls } from './map-controls';
import { EditToolbar } from './edit-toolbar';
import { AlarmPanel, alarmFocusTarget } from './alarm-panel';
import { resolveEdgeHandles } from '@/lib/edge-handles';
import {
  calculateSmartAlignment,
  type AlignmentGuide,
  type AlignmentNode,
} from '@/lib/smart-alignment';

const nodeTypes = { device: DeviceNode, generic: GenericNode };
const edgeTypes = { traffic: TrafficEdge };
type MapFlowNode = DeviceFlowNode | GenericFlowNode;
const DEFAULT_NODE_WIDTH = 64;
const DEFAULT_NODE_HEIGHT = 70;
const MAP_REFRESH_INTERVAL_MS = 30_000;

function alignmentNode(node: MapFlowNode): AlignmentNode {
  return {
    id: node.id,
    position: node.position,
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
  };
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
  const setMap = useMapStore((state) => state.setMap);
  const editMode = useMapStore((state) => state.editMode) && !readOnly;
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

  // Alarms follow the same refresh cycle as the map for now. The panel and the
  // node badges subscribe to this query, so a future WebSocket/SSE transport
  // can replace it without touching the consumers.
  const alarmsQuery = useQuery({
    queryKey: ['alarms'],
    queryFn: getAlarms,
    enabled: !readOnly,
    refetchInterval: MAP_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  const alarms = alarmsQuery.data ?? [];

  // Recently resolved alarms follow the same refresh cycle as the active ones.
  // The backend returns at most the 3 most recent resolutions.
  const resolvedAlarmsQuery = useQuery({
    queryKey: ['alarms', 'resolved'],
    queryFn: () => getRecentResolvedAlarms(3),
    enabled: !readOnly,
    refetchInterval: MAP_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  const recentResolvedAlarms = resolvedAlarmsQuery.data ?? [];

  const alarmCountByDevice = useMemo(() => {
    const counts = new Map<string, number>();
    for (const alarm of alarmsQuery.data ?? []) {
      counts.set(alarm.deviceId, (counts.get(alarm.deviceId) ?? 0) + 1);
    }
    return counts;
  }, [alarmsQuery.data]);

  useEffect(() => {
    if (!readOnly && catalogQuery.data) setCatalog(catalogQuery.data);
  }, [catalogQuery.data, readOnly, setCatalog]);

  useEffect(() => {
    if (readOnly) return;
    if (mapQuery.data) setMap(mapQuery.data);
  }, [mapQuery.data, readOnly, setMap]);

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
  const showInterfaces = preferences.showInterfaces;

  const domainNodes = useMemo<MapFlowNode[]>(() => {
    if (
      !mapNodes ||
      !mapDevices ||
      nodeDisplayMode === undefined ||
      nodeScale === undefined ||
      labelScale === undefined
    )
      return [];
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
          ...(measured ? { measured } : {}),
          data: {
            device,
            mapNode,
            editMode,
            showInterfaces,
            displayMode: nodeDisplayMode,
            nodeScale,
            labelScale,
            alarmCount: alarmCountByDevice.get(device.id) ?? 0,
          },
        }];
      }
      return [{
        id: mapNode.id,
        type: 'generic',
        position: mapNode.position,
        draggable: editMode && !mapNode.locked,
        ...(measured ? { measured } : {}),
        data: {
          mapNode,
          editMode,
          displayMode: nodeDisplayMode,
          nodeScale,
          labelScale,
        },
      }];
    });
  }, [
    alarmCountByDevice,
    editMode,
    labelScale,
    mapDevices,
    mapNodes,
    nodeDisplayMode,
    nodeScale,
    preferences.showOffline,
    showInterfaces,
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

  const focusAlarm = useCallback(
    (alarm: Alarm) => {
      const target = alarmFocusTarget(alarm);
      if (target.kind === 'link') {
        const link = map?.links.find((item) => item.id === target.linkId);
        const nodePosition = (key: string | null | undefined) =>
          map?.nodes.find((node) => (node.deviceId ?? node.id) === key)?.position;
        const sourcePosition = link && nodePosition(link.sourceDeviceId ?? link.sourceNodeId);
        const targetPosition = link && nodePosition(link.targetDeviceId ?? link.targetNodeId);
        if (sourcePosition && targetPosition) {
          void flow.setCenter(
            (sourcePosition.x + targetPosition.x) / 2,
            (sourcePosition.y + targetPosition.y) / 2,
            { duration: 650, zoom: Math.max(1.05, flow.getZoom()) },
          );
        }
        setSelection({ kind: 'link', id: target.linkId });
      } else {
        const node = domainNodes.find((item) => item.id === target.deviceId);
        if (node) {
          const width = node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH;
          const height = node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT;
          void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
            duration: 650,
            zoom: Math.max(1.05, flow.getZoom()),
          });
        }
        setSelection({ kind: 'device', id: target.deviceId });
      }
      if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
    },
    [domainNodes, flow, map, rotation.active, rotation.pauseOnInteraction, setRotationPaused, setSelection],
  );

  const domainEdges = useMemo<TrafficFlowEdge[]>(() => {
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
      return paths.map(({ visualPath, pathIndex }, visibleIndex) => ({
        id: pathIndex === 0 ? link.id : `${link.id}:path:${pathIndex}`,
        source: sourceKey,
        target: targetKey,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        type: 'traffic',
        selectable: true,
        selected: selection?.kind === 'link' && selection.id === link.id,
        data: {
          link,
          editMode,
          readOnly,
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
      }));
    });
  }, [domainNodes, map, preferences.showLabels, preferences.showTraffic, preferences.showUtilization, preferences.showTrafficAnimation, selection, editMode, readOnly]);

  const [nodes, setNodes] = useNodesState<MapFlowNode>([]);
  const [edges, setEdges] = useEdgesState<TrafficFlowEdge>([]);

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

  const onEdgeClick: EdgeMouseHandler<TrafficFlowEdge> = useCallback(
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
      <ReactFlow<MapFlowNode, TrafficFlowEdge>
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
        {!readOnly && (
          <AlarmPanel
            alarms={alarms}
            resolvedAlarms={recentResolvedAlarms}
            onFocus={focusAlarm}
          />
        )}
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
      <div className="map-watermark">
        <span>LIVE TOPOLOGY</span>
        <strong>
          {map?.nodes.filter((node) => map.devices.some((device) => device.id === node.deviceId && device.status === 'UP')).length ?? 0} UP
        </strong>
        <i />
        <strong className="warning">
          {map?.nodes.filter((node) => map.devices.some((device) => device.id === node.deviceId && device.status === 'WARNING')).length ?? 0} WARNING
        </strong>
        <i />
        <strong className="down">
          {map?.nodes.filter((node) => map.devices.some((device) => device.id === node.deviceId && device.status === 'DOWN')).length ?? 0} DOWN
        </strong>
      </div>
    </main>
  );
}
