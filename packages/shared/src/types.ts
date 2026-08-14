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
export type HostOrigin = 'MANUAL' | 'ZABBIX' | 'DISCOVERY' | 'IMPORTED';
export type SourceKind = 'ZABBIX' | 'SSH' | 'SNMP';
export type SourceConnectionState =
  'DISABLED' | 'CONFIGURED' | 'CONNECTED' | 'FAILED' | 'TIMEOUT' | 'AUTH_INVALID' | 'UNREACHABLE';
export type SnmpVersion = 'SNMP_V2C' | 'SNMP_V3';
export type SnmpSecurityLevel = 'NO_AUTH_NO_PRIV' | 'AUTH_NO_PRIV' | 'AUTH_PRIV';
export type SnmpAuthProtocol = 'MD5' | 'SHA' | 'SHA256';
export type SnmpPrivacyProtocol = 'DES' | 'AES' | 'AES256';

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
  rxItemId?: string | null;
  txItemId?: string | null;
  statusItemId?: string | null;
  inErrorsItemId?: string | null;
  outErrorsItemId?: string | null;
  inDiscardsItemId?: string | null;
  outDiscardsItemId?: string | null;
  dataSources?: Array<'ZABBIX' | 'SNMP' | 'SSH' | 'DEMO'>;
}

export interface SourceHealth {
  state: SourceConnectionState;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastErrorSafe: string | null;
}

export interface ZabbixHostBinding {
  hostId: string;
  hostName: string;
  primaryInterfaceId: string;
  ip: string;
}

export interface SshAccessSummary {
  host: string;
  port: number;
  username: string;
  credentialConfigured: boolean;
  authenticationType: 'PASSWORD' | 'PRIVATE_KEY';
}

export interface SnmpAccessSummary {
  version: SnmpVersion;
  host: string;
  port: number;
  username: string;
  securityLevel: SnmpSecurityLevel;
  authProtocol: SnmpAuthProtocol | null;
  privacyProtocol: SnmpPrivacyProtocol | null;
  credentialConfigured: boolean;
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

export interface HostRecord extends Device {
  displayName: string;
  managementIp: string;
  description: string;
  notes: string;
  origin: HostOrigin;
  useZabbix: boolean;
  zabbix: ZabbixHostBinding | null;
  sshEnabled: boolean;
  ssh: SshAccessSummary | null;
  snmpEnabled: boolean;
  snmp: SnmpAccessSummary | null;
  sourceHealth: Record<SourceKind, SourceHealth>;
  lastPollingAt: string | null;
  lastDiscoveryAt: string | null;
  mapIds: string[];
  mapCount: number;
  createdAt: string;
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
  device: HostRecord;
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
  devices: HostRecord[];
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
  nodeScale: number;
  linkScale: number;
  labelScale: number;
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
  nodeScale?: number;
  linkScale?: number;
  labelScale?: number;
}

export interface HostBasicInput {
  hostname: string;
  displayName: string;
  managementIp: string;
  vendor: string;
  model: string;
  deviceType: DeviceType;
  site: string;
  description: string;
  notes: string;
  origin: HostOrigin;
}

export interface ZabbixHostInput {
  enabled: boolean;
  hostId: string;
  hostName: string;
  primaryInterfaceId: string;
  ip: string;
}

export interface SshHostInput {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password?: string;
  clearCredential?: boolean;
}

export interface SnmpHostInput {
  enabled: boolean;
  version: SnmpVersion;
  host: string;
  port: number;
  community?: string;
  username: string;
  securityLevel: SnmpSecurityLevel;
  authProtocol: SnmpAuthProtocol | null;
  authPassword?: string;
  privacyProtocol: SnmpPrivacyProtocol | null;
  privacyPassword?: string;
  clearCredential?: boolean;
}

export interface CreateHostInput extends HostBasicInput {
  zabbix: ZabbixHostInput;
  ssh: SshHostInput;
  snmp: SnmpHostInput;
}

export type UpdateHostInput = Partial<HostBasicInput> & {
  zabbix?: ZabbixHostInput;
  ssh?: SshHostInput;
  snmp?: SnmpHostInput;
};

export interface ConnectionTestResult {
  source: SourceKind;
  state: Exclude<SourceConnectionState, 'CONFIGURED'>;
  message: string;
  checkedAt: string;
  version?: string;
}

export interface ZabbixHostCandidate {
  hostId: string;
  hostname: string;
  displayName: string;
  managementIp: string;
  primaryInterfaceId: string;
  vendor: string;
  model: string;
  status: DeviceStatus;
  alreadyRegistered: boolean;
  matchedHostId: string | null;
  interfaceCount: number;
}

export interface ZabbixImportPreview {
  id: string;
  version: string;
  demoMode: boolean;
  hosts: ZabbixHostCandidate[];
  createdAt: string;
}

export interface ZabbixImportResult {
  imported: HostRecord[];
  skippedHostIds: string[];
}

export type NeighborInventoryState =
  'PRESENT_IN_MAP' | 'REGISTERED' | 'NOT_REGISTERED' | 'AMBIGUOUS';
export type NeighborZabbixState = 'FOUND' | 'NOT_FOUND' | 'AMBIGUOUS';

export interface AssistedDiscoveredNeighbor extends DiscoveredNeighbor {
  inventoryState: NeighborInventoryState;
  zabbixState: NeighborZabbixState;
  mapPresent: boolean;
  linkExists: boolean;
  candidateDeviceIds: string[];
  zabbixCandidate: ZabbixHostCandidate | null;
}

export interface AssistedDiscoveryPreview {
  id: string;
  hostId: string;
  mapId: string;
  method: DiscoveryMethod;
  neighbors: AssistedDiscoveredNeighbor[];
  warnings: string[];
  createdAt: string;
}

export type DiscoveryApplyAction = 'ADD' | 'ADD_UNMONITORED' | 'LINK_ONLY' | 'IGNORE';

export interface DiscoveryApplySelection {
  neighborId: string;
  action: DiscoveryApplyAction;
  selectedDeviceId?: string;
}

export interface DiscoveryApplyResult {
  map: NetworkMap;
  createdHosts: string[];
  addedNodes: string[];
  createdLinks: string[];
  skipped: string[];
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
