export type MapMode = 'MANUAL' | 'AUTO' | 'HYBRID';
export type PositionSource = 'AUTO' | 'MANUAL';
export type DeviceStatus = 'UP' | 'DOWN' | 'WARNING' | 'UNKNOWN';
export type InterfaceStatus = DeviceStatus | 'DISABLED';
export type DeviceType =
  | 'core'
  | 'router'
  | 'switch'
  | 'aggregation'
  | 'edge'
  | 'olt'
  | 'firewall'
  | 'server'
  | 'internet'
  | 'ix'
  | 'customers'
  | 'generic';
export type DiscoverySource = 'MANUAL' | 'LLDP_SNMP' | 'LLDP_SSH';
export type MetricSource = 'DEMO' | 'ZABBIX';
export type DiscoveryMethod = 'AUTO' | 'SNMP' | 'SSH' | 'MANUAL';
export type MatchStatus = 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS';
export type HistoryPeriod = '15m' | '1h' | '6h' | '24h' | '7d';
export type NodeDisplayMode = 'ICON_2D' | 'ICON_3D' | 'CARD';
export type LinkDisplayStyle = 'FLOW' | 'WEATHERMAP' | 'HYBRID' | 'MINIMAL';
export type LinkMetricDisplay = 'THROUGHPUT' | 'UTILIZATION' | 'BOTH' | 'NONE';
export type LinkDirection = 'A_TO_B' | 'B_TO_A';
export type CapacitySource = 'AUTO' | 'MANUAL';
export type UtilizationLevel = 'NORMAL' | 'ATTENTION' | 'HIGH' | 'CRITICAL' | 'INCONSISTENT';

export interface Position {
  x: number;
  y: number;
}

export interface NetworkInterface {
  id: string;
  deviceId: string;
  name: string;
  alias: string;
  description: string;
  ifIndex: number;
  mac: string;
  mtu: number;
  speedBps: number;
  adminStatus: 'UP' | 'DOWN';
  operStatus: InterfaceStatus;
  rxBps: number;
  txBps: number;
  rxUtilization: number;
  txUtilization: number;
  rxErrors: number;
  txErrors: number;
  rxDiscards: number;
  txDiscards: number;
}

export interface Device {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  vendor: string;
  model: string;
  status: DeviceStatus;
  deviceType: DeviceType;
  site: string;
  source: MetricSource | DiscoverySource;
  discoveryMethod: DiscoveryMethod;
  uptimeSeconds: number;
  cpuPercent?: number;
  memoryPercent?: number;
  updatedAt: string;
  interfaces: NetworkInterface[];
}

export interface MapNode {
  id: string;
  mapId: string;
  deviceId: string;
  position: Position;
  locked: boolean;
  positionSource: PositionSource;
}

export interface AddDeviceResult {
  device: Device;
  node: MapNode;
}

export interface DirectionalLinkMetric {
  bps: number;
  utilization: number;
}

export interface LinkThresholds {
  attention: number;
  high: number;
  critical: number;
  maximum: number;
}

export interface NetworkLink {
  id: string;
  mapId: string;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  capacityBps: number;
  autoCapacityBps: number;
  capacitySource: CapacitySource;
  label: string;
  status: DeviceStatus;
  discoverySource: DiscoverySource;
  metricSource: MetricSource;
  visualStyle: LinkDisplayStyle | null;
  metricDisplay: LinkMetricDisplay | null;
  directions: Record<LinkDirection, DirectionalLinkMetric>;
  rxBps: number;
  txBps: number;
  rxUtilization: number;
  txUtilization: number;
  rxErrors: number;
  txErrors: number;
  rxDiscards: number;
  txDiscards: number;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkMap {
  id: string;
  name: string;
  description: string;
  mode: MapMode;
  isDefault: boolean;
  settings: MapSettings;
  nodes: MapNode[];
  devices: Device[];
  links: NetworkLink[];
  createdAt: string;
  updatedAt: string;
}

export interface MapViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface MapSettings {
  nodeDisplayMode: NodeDisplayMode;
  linkDisplayStyle: LinkDisplayStyle;
  linkMetricDisplay: LinkMetricDisplay;
  filters: MapPreferences;
  viewport: MapViewport;
}

export interface MapSummary {
  id: string;
  name: string;
  description: string;
  mode: MapMode;
  isDefault: boolean;
  nodeCount: number;
  linkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMapInput {
  name: string;
  description: string;
  mode: MapMode;
  sourceMapId: string | null;
}

export interface UpdateMapInput {
  name?: string;
  description?: string;
  mode?: MapMode;
  isDefault?: boolean;
  settings?: MapSettingsUpdate;
}

export interface MapSettingsUpdate {
  nodeDisplayMode?: NodeDisplayMode;
  linkDisplayStyle?: LinkDisplayStyle;
  linkMetricDisplay?: LinkMetricDisplay;
  filters?: Partial<MapPreferences>;
  viewport?: Partial<MapViewport>;
}

export interface MapPlaylistItem {
  mapId: string;
  order: number;
}

export interface MapPlaylist {
  id: string;
  name: string;
  rotationIntervalSeconds: number;
  isDefault: boolean;
  items: MapPlaylistItem[];
  createdAt: string;
  updatedAt: string;
}

export interface MetricPoint {
  timestamp: string;
  rxBps: number;
  txBps: number;
  rxErrors: number;
  txErrors: number;
  rxDiscards: number;
  txDiscards: number;
}

export interface DiscoveredNeighbor {
  id: string;
  localDeviceId: string;
  localPort: string;
  remoteSystemName: string;
  remoteChassisId?: string;
  remoteManagementAddress?: string;
  remotePort: string;
  remotePortDescription?: string;
  systemDescription?: string;
  capabilities: string[];
  source: Exclude<DiscoverySource, 'MANUAL'>;
  matchStatus: MatchStatus;
  matchedDeviceId?: string;
}

export interface DiscoveryReview {
  deviceId: string;
  method: DiscoveryMethod;
  neighbors: DiscoveredNeighbor[];
  warnings: string[];
}

export interface CreateLinkInput {
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  capacityBps: number;
  autoCapacityBps: number;
  capacitySource: CapacitySource;
  label: string;
  metricSource: MetricSource;
  visualStyle: LinkDisplayStyle | null;
  metricDisplay: LinkMetricDisplay | null;
}

export interface MapPreferences {
  showTraffic: boolean;
  showUtilization: boolean;
  showLabels: boolean;
  showOffline: boolean;
  showInterfaces: boolean;
}
