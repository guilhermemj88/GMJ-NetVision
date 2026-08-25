export type MplsSource = 'SNMP';

export type MplsStatus = 'UP' | 'DOWN' | 'DEGRADED' | 'ADMIN_DOWN' | 'UNKNOWN';
export type MplsVsiOperationalStatus = 'UP' | 'DOWN' | 'ADMIN_DOWN' | 'UNKNOWN';
export type MplsAdminStatus = 'UP' | 'DOWN' | 'UNKNOWN';
export type MplsAcStatus = 'UP' | 'DOWN' | 'UNKNOWN';
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

export interface MplsCapabilities {
  vsi: boolean;
  ac: boolean;
  pw: boolean;
}

export interface MplsAcInterface {
  id: string;
  name: string;
  alias: string;
  ifIndex: number;
}

export interface MplsAc {
  id: string;
  hostId: string;
  mplsVsiId: string;
  vsiName: string;
  ifIndex: number;
  interfaceId: string | null;
  interface: MplsAcInterface | null;
  status: MplsAcStatus;
  upStartTimeRaw: string | null;
  upSumTimeRaw: number | null;
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
  acs: MplsAc[];
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
  capabilities: MplsCapabilities;
  source: MplsSource;
  lastPollingAt: string | null;
  lastSuccessAt: string | null;
  lastErrorSafe: string | null;
  summary: MplsSummary;
  vsis: MplsVsi[];
}

export function summarizeMpls(vsis: MplsVsi[]): MplsSummary {
  const pws = vsis.flatMap((vsi) => vsi.pws);
  return {
    vsiTotal: vsis.length,
    vsiUp: vsis.filter((vsi) => vsi.status === 'UP').length,
    vsiDown: vsis.filter((vsi) => vsi.status === 'DOWN').length,
    vsiDegraded: vsis.filter((vsi) => vsi.status === 'DEGRADED').length,
    vsiAdminDown: vsis.filter((vsi) => vsi.status === 'ADMIN_DOWN').length,
    vsiUnknown: vsis.filter((vsi) => vsi.status === 'UNKNOWN').length,
    pwTotal: pws.length,
    pwUp: pws.filter((pw) => pw.status === 'UP').length,
    pwDown: pws.filter((pw) => pw.status === 'DOWN' || pw.status === 'PLUG_OUT').length,
  };
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
