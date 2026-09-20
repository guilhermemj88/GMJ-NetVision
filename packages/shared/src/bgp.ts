export type BgpPeerRole = 'UPSTREAM' | 'PEER' | 'OTHER';
export type BgpPeerState =
  | 'IDLE'
  | 'CONNECT'
  | 'ACTIVE'
  | 'OPENSENT'
  | 'OPENCONFIRM'
  | 'ESTABLISHED'
  | 'UNKNOWN';
export type BgpScope = 'monitored' | 'all';
export type BgpStateFilter = 'all' | 'up' | 'down';
export type BgpHistoryPeriod = '1h' | '6h' | '24h' | '7d';

export interface BgpPeerInterfaceDto {
  id: string | null;
  name: string | null;
  alias: string | null;
  description: string | null;
  rxBps: number | null;
  txBps: number | null;
}

export interface BgpDashboardPeer {
  id: string;
  deviceId: string;
  deviceHostname: string;
  deviceDisplayName: string;
  bgpMonitoringEnabled: boolean;
  peerAddress: string;
  /** Derived at runtime: alias -> description -> interface.name -> peerAddress. */
  displayName: string;
  remoteAs: string | null;
  role: BgpPeerRole;
  monitoringEnabled: boolean;
  stateCode: number;
  state: BgpPeerState;
  established: boolean;
  receivedPrefixes: number | null;
  establishedSince: string | null;
  lastPollingAt: string | null;
  lastDiscoveryAt: string | null;
  interface: BgpPeerInterfaceDto | null;
}

export type BgpPeerDetail = BgpDashboardPeer;

export interface BgpDashboardSummary {
  peers: number;
  established: number;
  down: number;
  receivedPrefixes: number;
}

export interface BgpDashboardDevice {
  id: string;
  hostname: string;
  displayName: string;
  bgpMonitoringEnabled: boolean;
  peers: BgpDashboardPeer[];
}

export interface BgpDashboardResponse {
  summary: BgpDashboardSummary;
  devices: BgpDashboardDevice[];
}

export interface BgpPeerHistoryPoint {
  timestamp: string;
  state: BgpPeerState;
  established: boolean;
  receivedPrefixes: number | null;
}

export interface BgpPeerStateEventDto {
  previousStateCode: number;
  previousState: BgpPeerState;
  currentStateCode: number;
  currentState: BgpPeerState;
  occurredAt: string;
}

export interface BgpPeerHistoryResponse {
  peerId: string;
  samples: BgpPeerHistoryPoint[];
  events: BgpPeerStateEventDto[];
}

export interface BgpAlertDto {
  peerId: string;
  deviceId: string;
  deviceName: string;
  peerAddress: string;
  displayName: string;
  previousState: BgpPeerState | null;
  currentState: BgpPeerState;
  startedAt: string | null;
  resolvedAt?: string | null;
  durationSeconds?: number | null;
}

export interface BgpAlertsResponse {
  active: BgpAlertDto[];
  resolved: BgpAlertDto[];
}
