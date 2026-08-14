import {
  cloneDemoMaps,
  createLocalId,
  type AddDeviceResult,
  createDemoHistory,
  type CreateLinkInput,
  type CreateMapInput,
  type DeviceType,
  type DiscoveryReview,
  type HistoryPeriod,
  type MapPlaylist,
  type MapSummary,
  type MetricPoint,
  type NetworkLink,
  type NetworkMap,
  type Position,
  type UpdateMapInput,
} from '@gmj/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function mapSummary(map: NetworkMap): MapSummary {
  return {
    id: map.id,
    name: map.name,
    description: map.description,
    mode: map.mode,
    isDefault: map.isDefault,
    nodeCount: map.nodes.length,
    linkCount: map.links.length,
    createdAt: map.createdAt,
    updatedAt: map.updatedAt,
  };
}

export async function getMaps(): Promise<MapSummary[]> {
  try {
    return await request<MapSummary[]>('/api/maps');
  } catch {
    return cloneDemoMaps().map(mapSummary);
  }
}

export async function getMap(mapId: string): Promise<NetworkMap> {
  try {
    return await request<NetworkMap>(`/api/maps/${mapId}`);
  } catch {
    const maps = cloneDemoMaps();
    return maps.find((map) => map.id === mapId) ?? maps[0]!;
  }
}

export function createNetworkMap(input: CreateMapInput) {
  return request<NetworkMap>('/api/maps', { method: 'POST', body: JSON.stringify(input) });
}

export function updateNetworkMap(mapId: string, input: UpdateMapInput) {
  return request<NetworkMap>(`/api/maps/${mapId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function duplicateNetworkMap(mapId: string, name: string, description?: string) {
  return request<NetworkMap>(`/api/maps/${mapId}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
}

export function deleteNetworkMap(mapId: string) {
  return request<void>(`/api/maps/${mapId}`, { method: 'DELETE' });
}

export function getPlaylists() {
  return request<MapPlaylist[]>('/api/playlists');
}

export function savePlaylist(input: {
  id?: string;
  name: string;
  rotationIntervalSeconds: number;
  mapIds: string[];
  isDefault: boolean;
}) {
  return request<MapPlaylist>('/api/playlists', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function savePositions(
  mapId: string,
  nodes: Array<{ nodeId: string; position: Position; locked?: boolean }>,
) {
  return request<NetworkMap>(`/api/maps/${mapId}/nodes/positions`, {
    method: 'PUT',
    body: JSON.stringify({ nodes }),
  });
}

export function createLink(mapId: string, input: CreateLinkInput) {
  return request<NetworkLink>(`/api/maps/${mapId}/links`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLink(
  mapId: string,
  id: string,
  input: Pick<
    CreateLinkInput,
    | 'capacityBps'
    | 'autoCapacityBps'
    | 'capacitySource'
    | 'label'
    | 'metricSource'
    | 'visualStyle'
    | 'metricDisplay'
  >,
) {
  return request<NetworkLink>(`/api/maps/${mapId}/links/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteLink(mapId: string, id: string) {
  return request<void>(`/api/maps/${mapId}/links/${id}`, { method: 'DELETE' });
}

export interface AddDeviceInput {
  name: string;
  hostname: string;
  ip: string;
  vendor: string;
  model: string;
  site: string;
  deviceType: DeviceType;
  position: Position;
}

export function addDevice(mapId: string, input: AddDeviceInput) {
  return request<AddDeviceResult>(`/api/maps/${mapId}/devices`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteDevice(mapId: string, id: string) {
  return request<void>(`/api/maps/${mapId}/devices/${id}`, { method: 'DELETE' });
}

export async function getHistory(
  interfaceId: string,
  period: HistoryPeriod,
): Promise<MetricPoint[]> {
  try {
    return await request<MetricPoint[]>(`/api/interfaces/${interfaceId}/history?period=${period}`);
  } catch {
    return createDemoHistory(interfaceId, period);
  }
}

export async function discoverNeighbors(mapId: string, deviceId: string): Promise<DiscoveryReview> {
  try {
    return await request<DiscoveryReview>(`/api/maps/${mapId}/devices/${deviceId}/discover`, {
      method: 'POST',
    });
  } catch {
    return {
      deviceId,
      method: 'AUTO',
      warnings: ['API indisponível; exibindo descoberta simulada local.'],
      neighbors: [
        {
          id: createLocalId('discovery'),
          localDeviceId: deviceId,
          localPort: '100GE1/0/1',
          remoteSystemName: 'AGG-CENTRO-01',
          remotePort: '100GE1/0/48',
          capabilities: ['bridge', 'router'],
          source: 'LLDP_SNMP',
          matchStatus: 'MATCHED',
          matchedDeviceId: 'agg-centro',
        },
        {
          id: createLocalId('discovery'),
          localDeviceId: deviceId,
          localPort: '10GE1/0/8',
          remoteSystemName: 'SW-UNKNOWN',
          remotePort: 'XGE0/0/1',
          capabilities: ['bridge'],
          source: 'LLDP_SNMP',
          matchStatus: 'UNMATCHED',
        },
      ],
    };
  }
}
