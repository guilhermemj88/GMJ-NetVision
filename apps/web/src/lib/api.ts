import {
  type AddDeviceResult,
  type AuthUser,
  type ChangePasswordInput,
  type CreateLinkInput,
  type CreateMapInput,
  type CreateHostInput,
  type CreateGenericNodeInput,
  type CreatePublicViewInput,
  type CreateUserInput,
  type AssistedDiscoveryPreview,
  type ConnectionTestResult,
  type DiscoveryApplyResult,
  type DiscoveryApplySelection,
  type DeviceType,
  type DiscoveryReview,
  type HistoryPeriod,
  type HostRecord,
  type LldpApplyResult,
  type LldpApplySelection,
  type LldpTopologyPreview,
  type LoginInput,
  type MapNode,
  type MapPlaylist,
  type MapSummary,
  type MetricPoint,
  type NetworkLink,
  type NetworkMap,
  type Position,
  type PublicView,
  type PublicViewResponse,
  type UpdateMapInput,
  type UpdateHostInput,
  type UpdatePublicViewInput,
  type UpdateUserInput,
  type UserAccount,
  type ZabbixImportPreview,
  type ZabbixImportResult,
} from '@gmj/shared';

function apiUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, '');

  if (typeof window === 'undefined') {
    // Server-side requests need an absolute URL.
    return configured || 'http://127.0.0.1:3333';
  }

  // Client-side: use the same origin and let Next.js rewrite /api/* to the
  // internal API. This keeps NAT/reverse proxy setups working with only the
  // web port exposed. An explicit non-local API URL still takes precedence.
  if (!configured) return '';
  const configuredIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(configured);
  return configuredIsLocal ? '' : configured;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${apiUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `API ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getMaps(): Promise<MapSummary[]> {
  return request<MapSummary[]>('/api/maps');
}

export function login(input: LoginInput) {
  return request<{ user: AuthUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function logout() {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function getMe() {
  return request<{ user: AuthUser }>('/api/auth/me');
}

export function listUsers() {
  return request<UserAccount[]>('/api/users');
}

export function createUser(input: CreateUserInput) {
  return request<UserAccount>('/api/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateUser(id: string, input: UpdateUserInput) {
  return request<UserAccount>(`/api/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function setUserPassword(id: string, password: string) {
  return request<{ ok: boolean }>(`/api/users/${id}/password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function changeOwnPassword(input: ChangePasswordInput) {
  return request<{ ok: boolean }>('/api/users/me/password', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getPublicView(token: string) {
  return request<PublicViewResponse>(`/api/public/view/${encodeURIComponent(token)}`);
}

export function listPublicViews() {
  return request<PublicView[]>('/api/public-views');
}

export function createPublicView(input: CreatePublicViewInput) {
  return request<PublicView>('/api/public-views', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updatePublicView(id: string, input: UpdatePublicViewInput) {
  return request<PublicView>(`/api/public-views/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deletePublicView(id: string) {
  return request<void>(`/api/public-views/${id}`, { method: 'DELETE' });
}

export function getMap(mapId: string): Promise<NetworkMap> {
  return request<NetworkMap>(`/api/maps/${mapId}`);
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

export function createGenericNode(mapId: string, input: CreateGenericNodeInput) {
  return request<MapNode>(`/api/maps/${mapId}/generic-nodes`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteMapNode(mapId: string, nodeId: string) {
  return request<void>(`/api/maps/${mapId}/nodes/${nodeId}`, { method: 'DELETE' });
}

export function getHosts(query = ''): Promise<HostRecord[]> {
  return request<HostRecord[]>(`/api/hosts${query ? `?${query}` : ''}`);
}

export function getHost(hostId: string) {
  return request<HostRecord>(`/api/hosts/${hostId}`);
}

export function createHost(input: CreateHostInput) {
  return request<HostRecord>('/api/hosts', { method: 'POST', body: JSON.stringify(input) });
}

export function updateHost(hostId: string, input: UpdateHostInput) {
  return request<HostRecord>(`/api/hosts/${hostId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteHost(hostId: string) {
  const normalizedHostId = hostId.trim();
  if (!normalizedHostId) return Promise.reject(new Error('Host ID is required'));
  return request<void>(`/api/hosts/${encodeURIComponent(normalizedHostId)}`, { method: 'DELETE' });
}

export function addHostToMap(hostId: string, mapId: string, position: Position) {
  return request<AddDeviceResult>(`/api/hosts/${hostId}/maps`, {
    method: 'POST',
    body: JSON.stringify({ mapId, position }),
  });
}

export function addHostsToMap(mapId: string, deviceIds: string[], seedPosition?: Position) {
  return request<{ created: AddDeviceResult[]; skipped: string[] }>(`/api/maps/${mapId}/nodes`, {
    method: 'POST',
    body: JSON.stringify({ deviceIds, seedPosition }),
  });
}

export function previewZabbixImport() {
  return request<ZabbixImportPreview>('/api/hosts/import/zabbix/preview', { method: 'POST' });
}

export function importZabbixHosts(previewId: string, hostIds: string[]) {
  return request<ZabbixImportResult>('/api/hosts/import/zabbix', {
    method: 'POST',
    body: JSON.stringify({ previewId, hostIds }),
  });
}

export function testHostSource(hostId: string, source: 'zabbix' | 'ssh' | 'snmp') {
  return request<ConnectionTestResult>(`/api/hosts/${hostId}/test/${source}`, {
    method: 'POST',
  });
}

export function previewAssistedDiscovery(hostId: string, mapId: string) {
  return request<AssistedDiscoveryPreview>(`/api/hosts/${hostId}/discovery/preview`, {
    method: 'POST',
    body: JSON.stringify({ mapId }),
  });
}

export function previewHostLldp(hostId: string, mapId: string) {
  return request<LldpTopologyPreview>(`/api/hosts/${hostId}/lldp/discover`, {
    method: 'POST',
    body: JSON.stringify({ mapId }),
  });
}

export function applyLldp(mapId: string, previewId: string, selections: LldpApplySelection[]) {
  return request<LldpApplyResult>(`/api/topology/lldp/apply`, {
    method: 'POST',
    body: JSON.stringify({ previewId, mapId, selections }),
  });
}

export function applyAssistedDiscovery(
  hostId: string,
  previewId: string,
  selections: DiscoveryApplySelection[],
) {
  return request<DiscoveryApplyResult>(`/api/hosts/${hostId}/discovery/apply`, {
    method: 'POST',
    body: JSON.stringify({ previewId, selections }),
  });
}

export function getHistory(interfaceId: string, period: HistoryPeriod): Promise<MetricPoint[]> {
  return request<MetricPoint[]>(`/api/interfaces/${interfaceId}/history?period=${period}`);
}

export function discoverNeighbors(mapId: string, deviceId: string): Promise<DiscoveryReview> {
  return request<DiscoveryReview>(`/api/maps/${mapId}/devices/${deviceId}/discover`, {
    method: 'POST',
  });
}
