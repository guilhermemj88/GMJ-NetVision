export type MplsSource = 'SNMP';

export type MplsStatus = 'UP' | 'DOWN' | 'DEGRADED' | 'ADMIN_DOWN' | 'UNKNOWN';
export type MplsVsiOperationalStatus = 'UP' | 'DOWN' | 'ADMIN_DOWN' | 'UNKNOWN';
export type MplsAdminStatus = 'UP' | 'DOWN' | 'UNKNOWN';
export type MplsPwStatus = 'DOWN' | 'UP' | 'PLUG_OUT' | 'BACKUP' | 'UNKNOWN';
export type MplsPwState = 'DOWN' | 'UP' | 'UNKNOWN';
export type MplsPwWorkingState = 'MASTER' | 'BACKUP' | 'UNKNOWN';
export type MplsEntityType = 'VSI' | 'PW';

export interface MplsRemoteHost {
  id: string;
  name: string;
  hostname: string;
}

export interface MplsPw {
  id: string;
  hostId: string;
  mplsVsiId: string;
  vsiName: string;
  pwId: number;
  remoteIp: string;
  remoteHostId: string | null;
  remoteHost: MplsRemoteHost | null;
  tunnelPolicy: string | null;
  pwType: string;
  inboundLabel: number | null;
  outboundLabel: number | null;
  status: MplsPwStatus;
  state: MplsPwState;
  workingState: MplsPwWorkingState;
  upStartTime: string | null;
  upSumTime: number | null;
  source: MplsSource;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MplsVsi {
  id: string;
  hostId: string;
  name: string;
  signalingType: string;
  rd: string | null;
  vsiId: number | null;
  status: MplsStatus;
  operationalStatus: MplsVsiOperationalStatus;
  adminStatus: MplsAdminStatus;
  mtu: number | null;
  vcType: string;
  tunnelPolicy: string | null;
  description: string | null;
  vlanId: number | null;
  localInterfaceId: string | null;
  source: MplsSource;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  pws: MplsPw[];
}

export interface MplsSummary {
  vsiTotal: number;
  vsiUp: number;
  vsiDown: number;
  vsiDegraded: number;
  vsiAdminDown: number;
  vsiUnknown: number;
  pwTotal: number;
  pwUp: number;
  pwDown: number;
}

export interface MplsStateEvent {
  id: string;
  hostId: string;
  entityType: MplsEntityType;
  entityId: string;
  vsiName: string;
  pwId: number | null;
  remoteIp: string | null;
  previousStatus: string;
  currentStatus: string;
  occurredAt: string;
}

export interface MplsHostOverview {
  supported: boolean;
  source: MplsSource;
  lastPollingAt: string | null;
  lastSuccessAt: string | null;
  lastErrorSafe: string | null;
  summary: MplsSummary;
  vsis: MplsVsi[];
}

export const EMPTY_MPLS_SUMMARY: MplsSummary = {
  vsiTotal: 0,
  vsiUp: 0,
  vsiDown: 0,
  vsiDegraded: 0,
  vsiAdminDown: 0,
  vsiUnknown: 0,
  pwTotal: 0,
  pwUp: 0,
  pwDown: 0,
};
