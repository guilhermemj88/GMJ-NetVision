import type { BgpPeerState } from './bgp4-peer-parser';
import type { BgpInterfaceCorrelationStatus } from './bgp-interface-correlation';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';
import type {
  BgpAddressFamily,
  BgpAddressFamilyFilter,
  BgpAdminState,
  BgpAlertsResponse,
  BgpDashboardPeer,
  BgpHistoryPeriod,
  BgpPeerHistoryResponse,
  BgpScope,
  BgpStateFilter,
} from '@gmj/shared';

export interface BgpDiscoveryPeerInput {
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  remoteAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  cliReceivedPrefixes: bigint | null;
  bgpPeerDescription: string | null;
  interfaceId: string | null;
  correlationStatus: BgpInterfaceCorrelationStatus;
}

export interface BgpDashboardQuery {
  scope: BgpScope;
  state: BgpStateFilter;
  family?: BgpAddressFamilyFilter;
  q?: string;
  deviceId?: string;
}

export interface BgpRepository {
  saveCollection(deviceId: string, collection: HuaweiBgpCollection): Promise<void>;
  saveDiscovery(
    deviceId: string,
    peers: readonly BgpDiscoveryPeerInput[],
    discoveredAt: Date,
  ): Promise<void>;
  /**
   * Persists the local ASN learned in the device SSH context. Callers must skip
   * this call when discovery could not determine an unambiguous value, so an
   * already persisted ASN is never erased.
   */
  saveDeviceLocalAs(deviceId: string, localAs: bigint, discoveredAt: Date): Promise<void>;
  getDeviceLocalAs(deviceId: string): Promise<bigint | null>;
  /** Persists the administrative state confirmed by an SSH read-back. */
  setPeerAdminState(peerId: string, adminState: BgpAdminState, checkedAt: Date): Promise<void>;
  listDashboardPeers(query: BgpDashboardQuery): Promise<BgpDashboardPeer[]>;
  getPeerDetail(peerId: string): Promise<BgpDashboardPeer | null>;
  getPeerHistory(peerId: string, period: BgpHistoryPeriod): Promise<BgpPeerHistoryResponse | null>;
  listAlerts(scope: BgpScope, hours: number): Promise<BgpAlertsResponse>;
  disconnect?(): Promise<void>;
}
