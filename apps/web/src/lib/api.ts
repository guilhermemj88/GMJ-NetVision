import {
  cloneDemoMap,
  createDemoHistory,
  type CreateLinkInput,
  type Device,
  type DeviceType,
  type DiscoveryReview,
  type HistoryPeriod,
  type MetricPoint,
  type NetworkLink,
  type NetworkMap,
  type Position,
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

export async function getMap(): Promise<NetworkMap> {
  try {
    return await request<NetworkMap>('/api/maps/backbone-main');
  } catch {
    return cloneDemoMap();
  }
}

export function savePositions(
  nodes: Array<{ nodeId: string; position: Position; locked?: boolean }>,
) {
  return request<NetworkMap>('/api/maps/backbone-main/nodes/positions', {
    method: 'PUT',
    body: JSON.stringify({ nodes }),
  });
}

export function createLink(input: CreateLinkInput) {
  return request<NetworkLink>('/api/maps/backbone-main/links', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateLink(
  id: string,
  input: Pick<CreateLinkInput, 'capacityBps' | 'label' | 'metricSource'>,
) {
  return request<NetworkLink>(`/api/maps/backbone-main/links/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteLink(id: string) {
  return request<void>(`/api/maps/backbone-main/links/${id}`, { method: 'DELETE' });
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

export function addDevice(input: AddDeviceInput) {
  return request<Device>('/api/maps/backbone-main/devices', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteDevice(id: string) {
  return request<void>(`/api/maps/backbone-main/devices/${id}`, { method: 'DELETE' });
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

export async function discoverNeighbors(deviceId: string): Promise<DiscoveryReview> {
  try {
    return await request<DiscoveryReview>(`/api/maps/backbone-main/devices/${deviceId}/discover`, {
      method: 'POST',
    });
  } catch {
    return {
      deviceId,
      method: 'AUTO',
      warnings: ['API indisponível; exibindo descoberta simulada local.'],
      neighbors: [
        {
          id: 'local-discovery-1',
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
          id: 'local-discovery-2',
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
