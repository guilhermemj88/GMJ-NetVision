import type { BgpPeerState } from './bgp4-peer-parser';
import {
  bigintToJsonNumber,
  bigintToJsonString,
  decideBgpDiscoveryState,
  decideBgpPollingUpdate,
  deriveBgpPeerDisplayName,
  discoveryInterfaceUpdate,
  type ExistingBgpPeerState,
} from './bgp-persistence';
import type { BgpDashboardQuery, BgpDiscoveryPeerInput, BgpRepository } from './bgp-repository';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';
import { computeBgpAlerts } from './bgp-alerts';
import type {
  BgpAlertsResponse,
  BgpDashboardPeer,
  BgpHistoryPeriod,
  BgpPeerHistoryResponse,
  BgpScope,
} from '@gmj/shared';

export interface DemoBgpPeerRecord extends ExistingBgpPeerState {
  deviceId: string;
  peerAddress: string;
  peerDescription: string | null;
  remoteAs: bigint | null;
  interfaceId: string | null;
  role: 'UPSTREAM' | 'PEER' | 'OTHER';
  receivedPrefixes: bigint | null;
  lastDiscoveryAt: Date | null;
}

export interface DemoBgpDeviceMeta {
  id: string;
  hostname: string;
  displayName: string;
  bgpMonitoringEnabled: boolean;
}

export interface DemoBgpInterfaceMeta {
  id: string;
  name: string;
  alias: string | null;
  description: string | null;
  rxBps: number | null;
  txBps: number | null;
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
  private readonly devices = new Map<string, DemoBgpDeviceMeta>();
  private readonly interfaces = new Map<string, DemoBgpInterfaceMeta>();
  readonly samples: DemoBgpSampleRecord[] = [];
  readonly stateEvents: DemoBgpStateEventRecord[] = [];
  private sequence = 0;

  setDevice(device: DemoBgpDeviceMeta): void {
    this.devices.set(device.id, device);
  }

  setInterface(iface: DemoBgpInterfaceMeta): void {
    this.interfaces.set(iface.id, iface);
  }

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
            peerDescription: null,
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
            ...(discovered.bgpPeerDescription === null
              ? {}
              : { peerDescription: discovered.bgpPeerDescription }),
            ...interfaceUpdate,
            ...state,
            lastDiscoveryAt: discoveredAt,
          }
        : {
            id: `demo-bgp-${++this.sequence}`,
            deviceId,
            peerAddress: discovered.peerAddress,
            peerDescription: discovered.bgpPeerDescription,
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
      options: Partial<
      Pick<DemoBgpPeerRecord, 'role' | 'monitoringEnabled' | 'interfaceId' | 'remoteAs'>
    >,
  ): void {
    const key = `${deviceId}|${peerAddress}`;
    const peer = this.peers.get(key);
    if (peer) this.peers.set(key, { ...peer, ...options });
  }

  async listDashboardPeers(query: BgpDashboardQuery): Promise<BgpDashboardPeer[]> {
    const text = query.q?.trim().toLowerCase();
    const peers = [...this.peers.values()]
      .filter((peer) => {
        if (query.deviceId && peer.deviceId !== query.deviceId) return false;
        if (query.state === 'up' && !peer.established) return false;
        if (query.state === 'down' && peer.established) return false;
        const device = this.devices.get(peer.deviceId);
        if (query.scope === 'monitored' && !(device?.bgpMonitoringEnabled ?? false)) return false;
        return true;
      })
      .map((peer) => this.toDashboardPeer(peer))
      .sort(
        (left, right) =>
          left.deviceHostname.localeCompare(right.deviceHostname) ||
          left.peerAddress.localeCompare(right.peerAddress),
      );
    if (!text) return peers;
    return peers.filter((peer) =>
      [
        peer.peerAddress,
        peer.displayName,
        peer.remoteAs ?? '',
        peer.deviceHostname,
        peer.deviceDisplayName,
      ].some((value) => value.toLowerCase().includes(text)),
    );
  }

  async getPeerDetail(peerId: string): Promise<BgpDashboardPeer | null> {
    const peer = [...this.peers.values()].find((item) => item.id === peerId);
    return peer ? this.toDashboardPeer(peer) : null;
  }

  async getPeerHistory(
    peerId: string,
    period: BgpHistoryPeriod,
  ): Promise<BgpPeerHistoryResponse | null> {
    const peer = [...this.peers.values()].find((item) => item.id === peerId);
    if (!peer) return null;
    const since = bgpHistoryStart(period);
    return {
      peerId,
      samples: this.samples
        .filter((sample) => sample.bgpPeerId === peerId && sample.timestamp >= since)
        .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
        .map((sample) => ({
          timestamp: sample.timestamp.toISOString(),
          state: sample.state,
          established: sample.established,
          receivedPrefixes: bigintToJsonNumber(sample.receivedPrefixes),
        })),
      events: this.stateEvents
        .filter((event) => event.bgpPeerId === peerId && event.occurredAt >= since)
        .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
        .map((event) => ({
          previousStateCode: event.previousStateCode,
          previousState: event.previousState,
          currentStateCode: event.currentStateCode,
          currentState: event.currentState,
          occurredAt: event.occurredAt.toISOString(),
        })),
    };
  }

  async listAlerts(scope: BgpScope, hours: number): Promise<BgpAlertsResponse> {
    const rows = [...this.peers.values()].filter((peer) => {
      if (scope !== 'monitored') return true;
      return this.devices.get(peer.deviceId)?.bgpMonitoringEnabled ?? false;
    });
    return computeBgpAlerts(
      rows.map((peer) => {
        const device = this.devices.get(peer.deviceId);
        const iface = peer.interfaceId ? this.interfaces.get(peer.interfaceId) ?? null : null;
        return {
          id: peer.id,
          deviceId: peer.deviceId,
          deviceName: device?.displayName ?? peer.deviceId,
          peerAddress: peer.peerAddress,
          displayName: deriveBgpPeerDisplayName(peer.peerAddress, iface, peer.peerDescription),
          state: peer.state,
          established: peer.established,
          lastStateChangedAt: peer.lastStateChangedAt,
        };
      }),
      this.stateEvents.map((event) => ({
        bgpPeerId: event.bgpPeerId,
        previousState: event.previousState,
        previousStateCode: event.previousStateCode,
        currentState: event.currentState,
        currentStateCode: event.currentStateCode,
        occurredAt: event.occurredAt,
      })),
      new Date(Date.now() - hours * 60 * 60_000),
    );
  }

  private toDashboardPeer(peer: DemoBgpPeerRecord): BgpDashboardPeer {
    const device = this.devices.get(peer.deviceId) ?? {
      id: peer.deviceId,
      hostname: peer.deviceId,
      displayName: peer.deviceId,
      bgpMonitoringEnabled: false,
    };
    const iface = peer.interfaceId ? this.interfaces.get(peer.interfaceId) ?? null : null;
    return {
      id: peer.id,
      deviceId: peer.deviceId,
      deviceHostname: device.hostname,
      deviceDisplayName: device.displayName,
      bgpMonitoringEnabled: device.bgpMonitoringEnabled,
      peerAddress: peer.peerAddress,
      displayName: deriveBgpPeerDisplayName(peer.peerAddress, iface, peer.peerDescription),
      remoteAs: bigintToJsonString(peer.remoteAs),
      role: peer.role,
      monitoringEnabled: peer.monitoringEnabled,
      stateCode: peer.stateCode,
      state: peer.state,
      established: peer.established,
      receivedPrefixes: bigintToJsonNumber(peer.receivedPrefixes),
      establishedSince: peer.establishedSince?.toISOString() ?? null,
      lastPollingAt: peer.lastPollingAt?.toISOString() ?? null,
      lastDiscoveryAt: peer.lastDiscoveryAt?.toISOString() ?? null,
      interface: iface
        ? {
            id: iface.id,
            name: iface.name,
            alias: iface.alias,
            description: iface.description,
            rxBps: iface.rxBps,
            txBps: iface.txBps,
          }
        : null,
    };
  }
}

function bgpHistoryStart(period: BgpHistoryPeriod): Date {
  const milliseconds: Record<BgpHistoryPeriod, number> = {
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
  };
  return new Date(Date.now() - milliseconds[period]);
}
