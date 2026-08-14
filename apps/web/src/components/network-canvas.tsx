'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type OnNodesChange,
} from '@xyflow/react';
import { getMap } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { DeviceNode, type DeviceFlowNode } from './device-node';
import { TrafficEdge, type TrafficFlowEdge } from './traffic-edge';
import { MapControls } from './map-controls';
import { EditToolbar } from './edit-toolbar';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { traffic: TrafficEdge };

export function NetworkCanvas() {
  const query = useQuery({ queryKey: ['map', 'backbone-main'], queryFn: getMap });
  const map = useMapStore((state) => state.map);
  const setMap = useMapStore((state) => state.setMap);
  const editMode = useMapStore((state) => state.editMode);
  const preferences = useMapStore((state) => state.preferences);
  const moveNode = useMapStore((state) => state.moveNode);
  const setSelection = useMapStore((state) => state.setSelection);
  const setPendingLink = useMapStore((state) => state.setPendingLink);
  const setPanel = useMapStore((state) => state.setPanel);

  useEffect(() => {
    if (query.data && !map) setMap(query.data);
  }, [map, query.data, setMap]);

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
          data: { device, mapNode, editMode, showInterfaces: preferences.showInterfaces },
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
    (_event, node) => setSelection({ kind: 'device', id: node.id }),
    [setSelection],
  );

  const onEdgeClick: EdgeMouseHandler<TrafficFlowEdge> = useCallback(
    (_event, edge) => setSelection({ kind: 'link', id: edge.id }),
    [setSelection],
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

  if (query.isPending && !map) {
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
        onPaneClick={() => setSelection(null)}
        onNodeDragStop={(_event, node) => moveNode(`node-${node.id}`, node.position)}
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
      >
        <Background variant={BackgroundVariant.Dots} gap={30} size={1} color="#24313c" />
        <MapControls />
        {editMode && <EditToolbar />}
      </ReactFlow>
      <div className="map-watermark">
        <span>LIVE TOPOLOGY</span>
        <strong>{map?.devices.filter((device) => device.status === 'UP').length ?? 0} UP</strong>
        <i />
        <strong className="warning">
          {map?.devices.filter((device) => device.status === 'WARNING').length ?? 0} WARNING
        </strong>
        <i />
        <strong className="down">
          {map?.devices.filter((device) => device.status === 'DOWN').length ?? 0} DOWN
        </strong>
      </div>
    </main>
  );
}
