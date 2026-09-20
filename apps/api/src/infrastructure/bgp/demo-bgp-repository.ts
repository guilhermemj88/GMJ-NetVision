import type { BgpPeerState } from './bgp4-peer-parser';
import {
  decideBgpDiscoveryState,
  decideBgpPollingUpdate,
  discoveryInterfaceUpdate,
  type ExistingBgpPeerState,
} from './bgp-persistence';
import type { BgpDiscoveryPeerInput, BgpRepository } from './bgp-repository';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';

export interface DemoBgpPeerRecord extends ExistingBgpPeerState {
  deviceId: string;
  peerAddress: string;
  remoteAs: bigint | null;
  interfaceId: string | null;
  role: 'UPSTREAM' | 'PEER' | 'OTHER';
  receivedPrefixes: bigint | null;
  lastDiscoveryAt: Date | null;
}

export interface DemoBgpSampleRecord {
  bgpPeerId: string;
  timestamp: Date;
  stateCode: number;
  state: BgpPeerState;
  established: boolean;
  receivedPrefixes: bigint | null;
}

export interface DemoBgpStateEventRecord {
  bgpPeerId: string;
  previousStateCode: number;
  previousState: BgpPeerState;
  currentStateCode: number;
  currentState: BgpPeerState;
  occurredAt: Date;
}

export class DemoBgpRepository implements BgpRepository {
  private readonly peers = new Map<string, DemoBgpPeerRecord>();
  readonly samples: DemoBgpSampleRecord[] = [];
  readonly stateEvents: DemoBgpStateEventRecord[] = [];
  private sequence = 0;

  getPeer(deviceId: string, peerAddress: string): DemoBgpPeerRecord | null {
    return this.peers.get(`${deviceId}|${peerAddress}`) ?? null;
  }

  listPeers(): DemoBgpPeerRecord[] {
    return [...this.peers.values()];
  }

  async saveCollection(deviceId: string, collection: HuaweiBgpCollection): Promise<void> {
    for (const current of collection.peers) {
      const key = `${deviceId}|${current.peerAddress}`;
      const existing = this.peers.get(key) ?? null;
      const decision = decideBgpPollingUpdate(existing, current, collection.collectedAt);
      const peer: DemoBgpPeerRecord = existing
        ? {
            ...existing,
            stateCode: decision.stateCode,
            state: decision.state,
            established: decision.established,
            receivedPrefixes: decision.receivedPrefixes,
            lastPollingAt: collection.collectedAt,
            ...(decision.establishedSince === undefined
              ? {}
              : { establishedSince: decision.establishedSince }),
            ...(decision.lastStateChangedAt
              ? { lastStateChangedAt: decision.lastStateChangedAt }
              : {}),
          }
        : {
            id: `demo-bgp-${++this.sequence}`,
            deviceId,
            peerAddress: current.peerAddress,
            remoteAs: null,
            interfaceId: null,
            role: 'OTHER',
            monitoringEnabled: true,
            stateCode: decision.stateCode,
            state: decision.state,
            established: decision.established,
            receivedPrefixes: decision.receivedPrefixes,
            establishedSince: decision.establishedSince ?? null,
            lastStateChangedAt: null,
            lastPollingAt: collection.collectedAt,
            lastDiscoveryAt: null,
          };
      this.peers.set(key, peer);
      if (decision.event) {
        this.stateEvents.push({
          bgpPeerId: peer.id,
          ...decision.event,
          occurredAt: collection.collectedAt,
        });
      }
      if (peer.monitoringEnabled) {
        this.samples.push({
          bgpPeerId: peer.id,
          timestamp: collection.collectedAt,
          stateCode: decision.stateCode,
          state: decision.state,
          established: decision.established,
          receivedPrefixes: decision.receivedPrefixes,
        });
      }
    }
  }

  async saveDiscovery(
    deviceId: string,
    peers: readonly BgpDiscoveryPeerInput[],
    discoveredAt: Date,
  ): Promise<void> {
    for (const discovered of peers) {
      const key = `${deviceId}|${discovered.peerAddress}`;
      const existing = this.peers.get(key) ?? null;
      const state = decideBgpDiscoveryState(existing, discovered, discoveredAt);
      const interfaceUpdate = discoveryInterfaceUpdate(discovered);
      const peer: DemoBgpPeerRecord = existing
        ? {
            ...existing,
            ...(discovered.remoteAs === null ? {} : { remoteAs: discovered.remoteAs }),
            ...interfaceUpdate,
            ...state,
            lastDiscoveryAt: discoveredAt,
          }
        : {
            id: `demo-bgp-${++this.sequence}`,
            deviceId,
            peerAddress: discovered.peerAddress,
            remoteAs: discovered.remoteAs,
            interfaceId: interfaceUpdate.interfaceId ?? null,
            role: 'OTHER',
            monitoringEnabled: true,
            stateCode: state.stateCode ?? 0,
            state: state.state ?? 'UNKNOWN',
            established: state.established ?? false,
            receivedPrefixes: null,
            establishedSince: state.establishedSince ?? null,
            lastStateChangedAt: null,
            lastPollingAt: null,
            lastDiscoveryAt: discoveredAt,
          };
      this.peers.set(key, peer);
    }
  }

  setPeerOptions(
    deviceId: string,
    peerAddress: string,
    options: Partial<Pick<DemoBgpPeerRecord, 'role' | 'monitoringEnabled' | 'interfaceId'>>,
  ): void {
    const key = `${deviceId}|${peerAddress}`;
    const peer = this.peers.get(key);
    if (peer) this.peers.set(key, { ...peer, ...options });
  }
}
