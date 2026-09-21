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
/** Address family of a persisted peer. Both families share the same models. */
export type BgpAddressFamily = 'IPV4' | 'IPV6';
export type BgpAddressFamilyFilter = 'all' | BgpAddressFamily;
/**
 * Administrative state confirmed by the last SSH read-back. `UNKNOWN` means the
 * peer was never verified, so a session in ACTIVE/IDLE must not be displayed as
 * administratively ignored.
 */
export type BgpAdminState = 'UNKNOWN' | 'ENABLED' | 'IGNORED';
export type BgpAdminAction = 'DISABLE' | 'ENABLE';

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
  addressFamily: BgpAddressFamily;
  /** Local ASN of the BGP process on the device; learned via SSH discovery. */
  localAs: string | null;
  remoteAs: string | null;
  role: BgpPeerRole;
  monitoringEnabled: boolean;
  stateCode: number;
  state: BgpPeerState;
  established: boolean;
  /** Confirmed by read-back only; never inferred from the session state. */
  adminState: BgpAdminState;
  adminStateCheckedAt: string | null;
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
  /** Small dual-stack breakdown of the peer count. */
  byFamily: Record<BgpAddressFamily, number>;
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
  addressFamily: BgpAddressFamily;
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

/**
 * Administrative action result. The request never carries CLI, addresses, ASNs
 * or the SSH context: the backend resolves everything from the persisted peer.
 */
export interface BgpPeerAdminStateResponse {
  peerId: string;
  deviceId: string;
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  action: BgpAdminAction;
  /** False whenever the CLI failed or the read-back could not confirm the change. */
  success: boolean;
  /** Administrative state confirmed by the SSH read-back after the change. */
  adminState: BgpAdminState;
  verified: boolean;
  message: string;
  executedAt: string;
}
