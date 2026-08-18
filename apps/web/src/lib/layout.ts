import dagre from '@dagrejs/dagre';
import type { NetworkMap, Position } from '@gmj/shared';

const NODE_WIDTH = 190;
const NODE_HEIGHT = 80;

export function createAutoLayout(map: NetworkMap): Map<string, Position> {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 52, marginx: 70, marginy: 70 });
  map.nodes.forEach((node) =>
    graph.setNode(node.deviceId ?? node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }),
  );
  map.links.forEach((link) =>
    graph.setEdge(
      link.sourceDeviceId ?? link.sourceNodeId ?? '',
      link.targetDeviceId ?? link.targetNodeId ?? '',
    ),
  );
  dagre.layout(graph);

  return new Map(
    map.nodes.map((node) => {
      const position = graph.node(node.deviceId ?? node.id) as { x: number; y: number };
      const preserve = node.locked || (map.mode === 'HYBRID' && node.positionSource === 'MANUAL');
      return [
        node.id,
        preserve
          ? node.position
          : { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 },
      ];
    }),
  );
}
