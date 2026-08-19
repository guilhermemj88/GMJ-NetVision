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
import { GenericNode, type GenericFlowNode } from './generic-node';
import { TrafficEdge, type TrafficFlowEdge } from './traffic-edge';
import { MapControls } from './map-controls';
import { EditToolbar } from './edit-toolbar';
import { selectEdgeHandles } from '@/lib/edge-handles';
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

function alignmentNode(node: MapFlowNode): AlignmentNode {
  return {
    id: node.id,
    position: node.position,
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
  };
}

export function NetworkCanvas({ readOnly = false }: { readOnly?: boolean }) {
  const flow = useReactFlow();
  const viewportMapId = useRef<string | null>(null);
  const snappedPosition = useRef<{ nodeId: string; position: { x: number; y: number } } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
  const catalogQuery = useQuery({ queryKey: ['maps'], queryFn: getMaps, enabled: !readOnly });
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
    enabled: Boolean(activeMapId) && !readOnly,
  });

  useEffect(() => {
    if (!readOnly && catalogQuery.data) setCatalog(catalogQuery.data);
  }, [catalogQuery.data, readOnly, setCatalog]);

  useEffect(() => {
    if (readOnly) return;
    if (mapQuery.data && (!map || map.id !== mapQuery.data.id)) setMap(mapQuery.data);
  }, [map, mapQuery.data, readOnly, setMap]);

  useEffect(() => {
    if (!map) {
      viewportMapId.current = null;
      return;
    }
    if (viewportMapId.current === map.id) return;
    viewportMapId.current = map.id;
    window.setTimeout(() => void flow.setViewport(map.settings.viewport, { duration: 280 }), 30);
  }, [flow, map]);

  const domainNodes = useMemo<MapFlowNode[]>(() => {
    if (!map) return [];
    return map.nodes.flatMap((mapNode): MapFlowNode[] => {
      if (mapNode.deviceId) {
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
      }
      return [{
        id: mapNode.id,
        type: 'generic',
        position: mapNode.position,
        draggable: editMode && !mapNode.locked,
        data: {
          mapNode,
          editMode,
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
    const positions = new Map(map.nodes.map((node) => [node.deviceId ?? node.id, node.position]));
    const devices = new Map(map.devices.map((device) => [device.id, device]));
    return map.links.flatMap((link) => {
      const sourceKey = link.sourceDeviceId ?? link.sourceNodeId ?? '';
      const targetKey = link.targetDeviceId ?? link.targetNodeId ?? '';
      const sourcePosition = positions.get(sourceKey);
      const targetPosition = positions.get(targetKey);
      if (!visible.has(sourceKey) || !visible.has(targetKey)) return [];
      const handles = sourcePosition && targetPosition
        ? selectEdgeHandles(sourcePosition, targetPosition)
        : { sourceHandle: 'right' as const, targetHandle: 'left' as const };
      const sourceInterface = link.sourceDeviceId
        ? devices.get(link.sourceDeviceId)?.interfaces.find((item) => item.id === link.sourceInterfaceId)
        : undefined;
      const targetInterface = link.targetDeviceId
        ? devices.get(link.targetDeviceId)?.interfaces.find((item) => item.id === link.targetInterfaceId)
        : undefined;
      const selectedId =
        selection?.kind === 'device' || selection?.kind === 'node' ? selection.id : null;
      return [{
        id: link.id,
        source: sourceKey,
        target: targetKey,
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
          showTrafficAnimation: preferences.showTrafficAnimation,
          displayStyle: map.settings.linkDisplayStyle,
          metricDisplay: map.settings.linkMetricDisplay,
          linkScale: map.settings.linkScale,
          labelScale: map.settings.labelScale,
          related: !selectedId || sourceKey === selectedId || targetKey === selectedId,
          emphasized: Boolean(selectedId) && (sourceKey === selectedId || targetKey === selectedId),
        },
      }];
    });
  }, [domainNodes, map, preferences.showLabels, preferences.showTraffic, preferences.showUtilization, preferences.showTrafficAnimation, selection]);

  const [nodes, setNodes] = useNodesState<MapFlowNode>([]);
  const [edges, setEdges] = useEdgesState<TrafficFlowEdge>([]);

  useEffect(() => setNodes(domainNodes), [domainNodes, setNodes]);
  useEffect(() => setEdges(domainEdges), [domainEdges, setEdges]);

  const onNodesChange: OnNodesChange<MapFlowNode> = useCallback(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [setNodes],
  );

  const onNodeClick: NodeMouseHandler<MapFlowNode> = useCallback(
    (_event, node) => {
      if (readOnly) return;
      setSelection(
        node.type === 'generic' ? { kind: 'node', id: node.id } : { kind: 'device', id: node.id },
      );
      if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
    },
    [readOnly, rotation.active, rotation.pauseOnInteraction, setRotationPaused, setSelection],
  );

  const onEdgeClick: EdgeMouseHandler<TrafficFlowEdge> = useCallback(
    (_event, edge) => {
      if (readOnly) return;
      setSelection({ kind: 'link', id: edge.id });
      if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
    },
    [readOnly, rotation.active, rotation.pauseOnInteraction, setRotationPaused, setSelection],
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
      setPendingLink({ sourceId: connection.source, targetId: connection.target });
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
          if (map && !readOnly) {
            void updateNetworkMap(map.id, { settings: { viewport } }).catch(() => undefined);
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={editMode ? 28 : 34} size={editMode ? 1.2 : 1} color={editMode ? '#26343f' : '#1b2832'} />
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
