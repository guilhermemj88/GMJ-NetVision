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

export interface NetworkLink {
  id: string;
  mapId: string;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  capacityBps: number;
  label: string;
  status: DeviceStatus;
  discoverySource: DiscoverySource;
  metricSource: MetricSource;
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
  mode: MapMode;
  nodes: MapNode[];
  devices: Device[];
  links: NetworkLink[];
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
  label: string;
  metricSource: MetricSource;
}

export interface MapPreferences {
  showTraffic: boolean;
  showUtilization: boolean;
  showLabels: boolean;
  showOffline: boolean;
  showInterfaces: boolean;
}
