import type { BgpPeerState } from './bgp4-peer-parser';
import type { BgpInterfaceCorrelationStatus } from './bgp-interface-correlation';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';
import type {
  BgpDashboardPeer,
  BgpHistoryPeriod,
  BgpPeerHistoryResponse,
  BgpScope,
  BgpStateFilter,
} from '@gmj/shared';

export interface BgpDiscoveryPeerInput {
  peerAddress: string;
  remoteAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  interfaceId: string | null;
  correlationStatus: BgpInterfaceCorrelationStatus;
}

export interface BgpDashboardQuery {
  scope: BgpScope;
  state: BgpStateFilter;
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
  listDashboardPeers(query: BgpDashboardQuery): Promise<BgpDashboardPeer[]>;
  getPeerDetail(peerId: string): Promise<BgpDashboardPeer | null>;
  getPeerHistory(peerId: string, period: BgpHistoryPeriod): Promise<BgpPeerHistoryResponse | null>;
  disconnect?(): Promise<void>;
}
