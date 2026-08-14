'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnNodesChange,
} from '@xyflow/react';
import { getMap, getMaps, updateNetworkMap } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { DeviceNode, type DeviceFlowNode } from './device-node';
import { TrafficEdge, type TrafficFlowEdge } from './traffic-edge';
import { MapControls } from './map-controls';
import { EditToolbar } from './edit-toolbar';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { traffic: TrafficEdge };

export function NetworkCanvas() {
  const flow = useReactFlow();
  const viewportMapId = useRef<string | null>(null);
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
      return [
        {
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
        },
      ];
    });
  }, [editMode, map, preferences.showInterfaces, preferences.showOffline]);

  const domainEdges = useMemo<TrafficFlowEdge[]>(() => {
    if (!map) return [];
    const visible = new Set(domainNodes.map((node) => node.id));
    return map.links.flatMap((link) =>
      visible.has(link.sourceDeviceId) && visible.has(link.targetDeviceId)
        ? [
            {
              id: link.id,
              source: link.sourceDeviceId,
              target: link.targetDeviceId,
              type: 'traffic',
              selectable: true,
              data: {
                link,
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
            },
          ]
        : [],
    );
  }, [
    domainNodes,
    map,
    preferences.showLabels,
    preferences.showTraffic,
    preferences.showUtilization,
    selection,
  ]);

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

  const onConnect = useCallback(
    (connection: Connection) => {
      if (
        !editMode ||
        !connection.source ||
        !connection.target ||
        connection.source === connection.target
      )
        return;
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
        onEdgeClick={onEdgeClick}
        onPaneClick={() => {
          setSelection(null);
          if (rotation.active && rotation.pauseOnInteraction) setRotationPaused(true);
        }}
        onNodeDragStop={(_event, node) => {
          const mapNode = map?.nodes.find((item) => item.deviceId === node.id);
          if (mapNode) moveNode(mapNode.id, node.position);
        }}
        onConnect={onConnect}
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
          if (map) {
            void updateNetworkMap(map.id, { settings: { viewport } }).catch(() => undefined);
          }
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={30} size={1} color="#24313c" />
        {!rotation.hideControls && <MapControls />}
        {editMode && !rotation.active && <EditToolbar />}
      </ReactFlow>
      <div className="map-watermark">
        <span>LIVE TOPOLOGY</span>
        <strong>
          {map?.nodes.filter((node) =>
            map.devices.some((device) => device.id === node.deviceId && device.status === 'UP'),
          ).length ?? 0}{' '}
          UP
        </strong>
        <i />
        <strong className="warning">
          {map?.nodes.filter((node) =>
            map.devices.some(
              (device) => device.id === node.deviceId && device.status === 'WARNING',
            ),
          ).length ?? 0}{' '}
          WARNING
        </strong>
        <i />
        <strong className="down">
          {map?.nodes.filter((node) =>
            map.devices.some((device) => device.id === node.deviceId && device.status === 'DOWN'),
          ).length ?? 0}{' '}
          DOWN
        </strong>
      </div>
    </main>
  );
}
