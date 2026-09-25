import type { Device, MapNode, NetworkLink } from '@gmj/shared';

/**
 * Presets VISUAIS do mapa.
 *
 * Um preset não cria mapa, não altera topologia nem métricas: ele agrupa
 * escolhas de apresentação que já existem em `MapSettings`/`MapPreferences`,
 * mais a camada sugerida de foco. Os três presets mostram os MESMOS dados.
 */
export type VisualPreset = 'OPERACIONAL' | 'TOPOLOGIA' | 'ENGENHARIA';

/**
 * Camada de foco. Elementos fora da camada são **atenuados**, nunca apagados
 * sem possibilidade de revelar — informação crítica continua visível e
 * clicável.
 */
export type MapLayerFilter = 'ALL' | 'PROBLEM' | 'DOWN' | 'ALARMS' | 'HIGH_UTIL';

export type FocusHops = 0 | 1 | 2 | 3;

/** Utilização (pior sentido) a partir da qual um enlace entra em "alto uso". */
export const HIGH_UTILIZATION_THRESHOLD = 70;

export interface MapFocusInput {
  nodes: MapNode[];
  devices: Device[];
  links: NetworkLink[];
  layer: MapLayerFilter;
  site: string | null;
  deviceType: string | null;
  focusHops: FocusHops;
  /** Chave do node selecionado (deviceId quando existe, senão node.id). */
  focusNodeId: string | null;
  alarmCountByDevice: Map<string, number>;
}

export interface MapFocusResult {
  /** Ids do React Flow (deviceId para nós de equipamento, nodeId para genéricos). */
  dimmedNodeIds: Set<string>;
  dimmedLinkIds: Set<string>;
  stats: {
    nodes: number;
    nodesDimmed: number;
    links: number;
    linksDimmed: number;
    devicesUp: number;
    devicesWarning: number;
    devicesDown: number;
    linksDown: number;
    linksHighUtilization: number;
    alarms: number;
    worstUtilization: number;
  };
  /** Quantos nodes cada camada deixaria em foco (badges da rail). */
  layerCounts: Record<MapLayerFilter, number>;
}

export function nodeKey(node: Pick<MapNode, 'id' | 'deviceId'>): string {
  return node.deviceId ?? node.id;
}

export function linkEndKeys(
  link: Pick<NetworkLink, 'sourceDeviceId' | 'sourceNodeId' | 'targetDeviceId' | 'targetNodeId'>,
): { source: string; target: string } {
  return {
    source: link.sourceDeviceId ?? link.sourceNodeId ?? '',
    target: link.targetDeviceId ?? link.targetNodeId ?? '',
  };
}

/** Pior sentido do enlace (full-duplex nunca é somado). */
export function linkWorstUtilization(link: NetworkLink): number {
  return Math.max(link.directions?.A_TO_B?.utilization ?? 0, link.directions?.B_TO_A?.utilization ?? 0);
}

export function isLinkDown(link: NetworkLink): boolean {
  return link.status === 'DOWN';
}

/**
 * Constrói o grafo de adjacência a partir dos enlaces reais do mapa.
 * Genéricos entram como nós de pleno direito (sem inventar hierarquia).
 */
export function buildAdjacency(links: NetworkLink[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const connect = (from: string, to: string) => {
    if (!from || !to) return;
    const list = adjacency.get(from) ?? new Set<string>();
    list.add(to);
    adjacency.set(from, list);
  };
  for (const link of links) {
    const { source, target } = linkEndKeys(link);
    connect(source, target);
    connect(target, source);
  }
  return adjacency;
}

/**
 * Vizinhança de `origin` até `hops` saltos. Sem origem ou com 0 hop devolve
 * `null`, que significa "sem recorte de vizinhança".
 */
export function neighborhood(
  links: NetworkLink[],
  origin: string | null,
  hops: FocusHops,
): Set<string> | null {
  if (!origin || hops <= 0) return null;
  const adjacency = buildAdjacency(links);
  const visited = new Set<string>([origin]);
  let frontier = [origin];
  for (let depth = 0; depth < hops; depth += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const neighbor of adjacency.get(key) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return visited;
}

/**
 * Decide quais nodes/enlaces ficam atenuados e resume o estado operacional do
 * recorte visível. Não altera o grafo: apenas marca o que está fora de foco.
 */
export function computeMapFocus(input: MapFocusInput): MapFocusResult {
  const { nodes, devices, links, layer, site, deviceType, focusHops, focusNodeId } = input;
  const deviceById = new Map(devices.map((device) => [device.id, device]));

  const downLinksByNode = new Map<string, number>();
  const highLinksByNode = new Map<string, number>();
  let linksDown = 0;
  let linksHighUtilization = 0;
  let worstUtilization = 0;

  for (const link of links) {
    const { source, target } = linkEndKeys(link);
    const down = isLinkDown(link);
    const utilization = linkWorstUtilization(link);
    const high = utilization >= HIGH_UTILIZATION_THRESHOLD;
    if (down) {
      linksDown += 1;
      for (const key of [source, target]) {
        downLinksByNode.set(key, (downLinksByNode.get(key) ?? 0) + 1);
      }
    }
    if (high) {
      linksHighUtilization += 1;
      for (const key of [source, target]) {
        highLinksByNode.set(key, (highLinksByNode.get(key) ?? 0) + 1);
      }
    }
    worstUtilization = Math.max(worstUtilization, utilization);
  }

  const alarmsByNode = input.alarmCountByDevice;
  const focusSet = neighborhood(links, focusNodeId, focusHops);

  let devicesUp = 0;
  let devicesWarning = 0;
  let devicesDown = 0;
  let alarms = 0;

  const nodeLayerMatch = (key: string, layer: MapLayerFilter): boolean => {
    const device = deviceById.get(key);
    const status = device?.status;
    const hasAlarm = (alarmsByNode.get(key) ?? 0) > 0;
    const hasDownLink = (downLinksByNode.get(key) ?? 0) > 0;
    const hasHighLink = (highLinksByNode.get(key) ?? 0) > 0;

    switch (layer) {
      case 'PROBLEM':
        return status === 'DOWN' || status === 'WARNING' || hasAlarm || hasDownLink || hasHighLink;
      case 'DOWN':
        return status === 'DOWN' || hasDownLink;
      case 'ALARMS':
        return hasAlarm;
      case 'HIGH_UTIL':
        return hasHighLink;
      default:
        return true;
    }
  };

  const deviceMatchesLayer = (key: string): boolean => nodeLayerMatch(key, layer);

  const dimmedNodeIds = new Set<string>();
  const nodeKeyById = new Map<string, string>();
  const layerCounts: Record<MapLayerFilter, number> = {
    ALL: 0,
    PROBLEM: 0,
    DOWN: 0,
    ALARMS: 0,
    HIGH_UTIL: 0,
  };

  for (const node of nodes) {
    const key = nodeKey(node);
    nodeKeyById.set(key, node.id);
    layerCounts.ALL += 1;
    if (nodeLayerMatch(key, 'PROBLEM')) layerCounts.PROBLEM += 1;
    if (nodeLayerMatch(key, 'DOWN')) layerCounts.DOWN += 1;
    if (nodeLayerMatch(key, 'ALARMS')) layerCounts.ALARMS += 1;
    if (nodeLayerMatch(key, 'HIGH_UTIL')) layerCounts.HIGH_UTIL += 1;
    const device = deviceById.get(key);
    if (device) {
      if (device.status === 'UP') devicesUp += 1;
      else if (device.status === 'WARNING') devicesWarning += 1;
      else if (device.status === 'DOWN') devicesDown += 1;
    }
    alarms += alarmsByNode.get(key) ?? 0;

    const matchesLayer = deviceMatchesLayer(key);
    const matchesSite = site === null || device?.site === site;
    const matchesType = deviceType === null || device?.deviceType === deviceType;
    const matchesFocus = focusSet === null || focusSet.has(key);

    if (!(matchesLayer && matchesSite && matchesType && matchesFocus)) {
      dimmedNodeIds.add(key);
    }
  }

  const dimmedLinkIds = new Set<string>();
  for (const link of links) {
    const { source, target } = linkEndKeys(link);
    const endsDimmed = dimmedNodeIds.has(source) || dimmedNodeIds.has(target);
    if (endsDimmed) dimmedLinkIds.add(link.id);
  }

  return {
    dimmedNodeIds,
    dimmedLinkIds,
    layerCounts,
    stats: {
      nodes: nodes.length,
      nodesDimmed: dimmedNodeIds.size,
      links: links.length,
      linksDimmed: dimmedLinkIds.size,
      devicesUp,
      devicesWarning,
      devicesDown,
      linksDown,
      linksHighUtilization,
      alarms,
      worstUtilization,
    },
  };
}
