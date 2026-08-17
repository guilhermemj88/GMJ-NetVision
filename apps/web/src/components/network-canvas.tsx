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
import { getMap, getMaps, updateNetworkMap } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { DeviceNode, type DeviceFlowNode } from './device-node';
import { TrafficEdge, type TrafficFlowEdge } from './traffic-edge';
import { MapControls } from './map-controls';
import { EditToolbar } from './edit-toolbar';
import { selectEdgeHandles } from '@/lib/edge-handles';
import {
  calculateSmartAlignment,
  type AlignmentGuide,
  type AlignmentNode,
} from '@/lib/smart-alignment';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { traffic: TrafficEdge };
const DEFAULT_NODE_WIDTH = 82;
const DEFAULT_NODE_HEIGHT = 80;

function alignmentNode(node: DeviceFlowNode): AlignmentNode {
  return {
    id: node.id,
    position: node.position,
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
  };
}

export function NetworkCanvas() {
  const flow = useReactFlow();
  const viewportMapId = useRef<string | null>(null);
  const snappedPosition = useRef<{ nodeId: string; position: { x: number; y: number } } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const catalogQuery = useQuery({ queryKey: ['maps'], queryFn: getMaps });
  const activeMapId = useMapStore((state) => state.activeMapId);
  const map = useMapStore((state) => state.map);
  const setCatalog = useMapStore((state) => state.setCatalog);
  const setMap = useMapStore((state) => state.setMap);
  const editMode = useMapStore((state) => state.editMode);
  const preferences = useMapStore((state) => state.preferences);
  const moveNode = useMapStore((state) => state.moveNode);
  const selection = useMapStore((state) => state.selection);
  const setSelection = useMapStore((state) => state.setSelection);
  const setPendingLink = useMapStore((state) => state.setPendingLink);
  const setPanel = useMapStore((state) => state.setPanel);
  const rotation = useMapStore((state) => state.rotation);
  const setRotationPaused = useMapStore((state) => state.setRotationPaused);
  const setViewport = useMapStore((state) => state.setViewport);

  const mapQuery = useQuery({
    queryKey: ['map', activeMapId],
    queryFn: () => getMap(activeMapId!),
    enabled: Boolean(activeMapId),
  });

  useEffect(() => {
    if (catalogQuery.data) setCatalog(catalogQuery.data);
  }, [catalogQuery.data, setCatalog]);

  useEffect(() => {
    if (mapQuery.data && (!map || map.id !== mapQuery.data.id)) setMap(mapQuery.data);
  }, [map, mapQuery.data, setMap]);

  useEffect(() => {
    if (!map) {
      viewportMapId.current = null;
      return;
    }
    if (viewportMapId.current === map.id) return;
    viewportMapId.current = map.id;
    window.setTimeout(() => void flow.setViewport(map.settings.viewport, { duration: 280 }), 30);
  }, [flow, map]);

  const domainNodes = useMemo<DeviceFlowNode[]>(() => {
    if (!map) return [];
    return map.nodes.flatMap((mapNode) => {
      const device = map.devices.find((item) => item.id === mapNode.deviceId);
      if (!device || (!preferences.showOffline && device.status === 'DOWN')) return [];
      return [{
        id: device.id,
        type: 'device',
        position: mapNode.position,
        draggable: editMode && !mapNode.locked,
        data: {
          device,
          mapNode,
          editMode,
          showInterfaces: preferences.showInterfaces,
          displayMode: map.settings.nodeDisplayMode,
          nodeScale: map.settings.nodeScale,
          labelScale: map.settings.labelScale,
        },
      }];
    });
  }, [editMode, map, preferences.showInterfaces, preferences.showOffline]);

  const domainEdges = useMemo<TrafficFlowEdge[]>(() => {
    if (!map) return [];
    const visible = new Set(domainNodes.map((node) => node.id));
    const positions = new Map(map.nodes.map((node) => [node.deviceId, node.position]));
    const devices = new Map(map.devices.map((device) => [device.id, device]));
    return map.links.flatMap((link) => {
      const sourcePosition = positions.get(link.sourceDeviceId);
      const targetPosition = positions.get(link.targetDeviceId);
      if (!visible.has(link.sourceDeviceId) || !visible.has(link.targetDeviceId)) return [];
      const handles = sourcePosition && targetPosition
        ? selectEdgeHandles(sourcePosition, targetPosition)
        : { sourceHandle: 'right' as const, targetHandle: 'left' as const };
      const sourceInterface = devices.get(link.sourceDeviceId)?.interfaces.find((item) => item.id === link.sourceInterfaceId);
      const targetInterface = devices.get(link.targetDeviceId)?.interfaces.find((item) => item.id === link.targetInterfaceId);
      return [{
        id: link.id,
        source: link.sourceDeviceId,
        target: link.targetDeviceId,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        type: 'traffic',
        selectable: true,
        data: {
          link,
          ...(sourceInterface ? { sourceInterface } : {}),
          ...(targetInterface ? { targetInterface } : {}),
          showTraffic: preferences.showTraffic,
          showUtilization: preferences.showUtilization,
          showLabels: preferences.showLabels,
          displayStyle: map.settings.linkDisplayStyle,
          metricDisplay: map.settings.linkMetricDisplay,
          linkScale: map.settings.linkScale,
          labelScale: map.settings.labelScale,
          related:
            selection?.kind !== 'device' ||
            link.sourceDeviceId === selection.id ||
            link.targetDeviceId === selection.id,
          emphasized:
            selection?.kind === 'device' &&
            (link.sourceDeviceId === selection.id || link.targetDeviceId === selection.id),
        },
      }];
    });
  }, [domainNodes, map, preferences.showLabels, preferences.showTraffic, preferences.showUtilization, selection]);

  const [nodes, setNodes] = useNodesState<DeviceFlowNode>([]);
  const [edges, setEdges] = useEdgesState<TrafficFlowEdge>([]);

  useEffect(() => setNodes(domainNodes), [domainNodes, setNodes]);
  useEffect(() => setEdges(domainEdges), [domainEdges, setEdges]);

  const onNodesChange: OnNodesChange<DeviceFlowNode> = useCallback(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [setNodes],
  );

  const onNodeClick: NodeMouseHandler<DeviceFlowNode> = useCallback(
    (_event, node) => {
      setSelection({ kind: 'device', id: node.id });
      if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
    },
    [rotation.active, rotation.pauseOnInteraction, setRotationPaused, setSelection],
  );

  const onEdgeClick: EdgeMouseHandler<TrafficFlowEdge> = useCallback(
    (_event, edge) => {
      setSelection({ kind: 'link', id: edge.id });
      if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
    },
    [rotation.active, rotation.pauseOnInteraction, setRotationPaused, setSelection],
  );

  const onNodeDrag: OnNodeDrag<DeviceFlowNode> = useCallback(
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
    },
    [editMode, flow, setNodes],
  );

  const clearAlignment = useCallback(() => {
    setAlignmentGuides([]);
    snappedPosition.current = null;
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editMode || !connection.source || !connection.target || connection.source === connection.target) return;
      setPendingLink({ sourceDeviceId: connection.source, targetDeviceId: connection.target });
      setPanel('create-link');
    },
    [editMode, setPanel, setPendingLink],
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
      <ReactFlow<DeviceFlowNode, TrafficFlowEdge>
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
          const mapNode = map?.nodes.find((item) => item.deviceId === node.id);
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
        fitView
        fitViewOptions={{ padding: 0.16 }}
        minZoom={0.25}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        selectionOnDrag={editMode}
        panOnDrag={!editMode || [1, 2]}
        onMoveEnd={(_event, viewport) => {
          setViewport(viewport);
          if (map) void updateNetworkMap(map.id, { settings: { viewport } }).catch(() => undefined);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={30} size={1} color="#24313c" />
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
        {!rotation.hideControls && <MapControls />}
        {editMode && !rotation.active && <EditToolbar />}
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
