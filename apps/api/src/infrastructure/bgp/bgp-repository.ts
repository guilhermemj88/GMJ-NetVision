import type { BgpPeerState } from './bgp4-peer-parser';
import type { BgpInterfaceCorrelationStatus } from './bgp-interface-correlation';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';

export interface BgpDiscoveryPeerInput {
  peerAddress: string;
  remoteAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  interfaceId: string | null;
  correlationStatus: BgpInterfaceCorrelationStatus;
}

export interface BgpRepository {
  saveCollection(deviceId: string, collection: HuaweiBgpCollection): Promise<void>;
  saveDiscovery(
    deviceId: string,
    peers: readonly BgpDiscoveryPeerInput[],
    discoveredAt: Date,
  ): Promise<void>;
  disconnect?(): Promise<void>;
}
