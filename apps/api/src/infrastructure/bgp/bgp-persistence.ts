import type { BgpPeerState } from './bgp4-peer-parser';
import type { BgpDiscoveryPeerInput } from './bgp-repository';
import type { CollectedBgpPeer } from './huawei-bgp-snmp';

export interface ExistingBgpPeerState {
  id: string;
  stateCode: number;
  state: BgpPeerState;
  established: boolean;
  establishedSince: Date | null;
  lastStateChangedAt: Date | null;
  lastPollingAt: Date | null;
  monitoringEnabled: boolean;
}

export interface BgpPollingDecision {
  stateCode: number;
  state: BgpPeerState;
  established: boolean;
  receivedPrefixes: bigint | null;
  establishedSince?: Date | null;
  lastStateChangedAt?: Date;
  event: {
    previousStateCode: number;
    previousState: BgpPeerState;
    currentStateCode: number;
    currentState: BgpPeerState;
  } | null;
}

export interface BgpDiscoveryStateDecision {
  stateCode?: number;
  state?: BgpPeerState;
  established?: boolean;
  establishedSince?: Date | null;
}

export function receivedPrefixesForPersistence(peer: CollectedBgpPeer): bigint | null {
  return peer.stateCode === 6 && peer.receivedPrefixes !== null
    ? BigInt(peer.receivedPrefixes)
    : null;
}

export function decideBgpPollingUpdate(
  existing: ExistingBgpPeerState | null,
  current: CollectedBgpPeer,
  timestamp: Date,
): BgpPollingDecision {
  const base = {
    stateCode: current.stateCode,
    state: current.state,
    established: current.stateCode === 6,
    receivedPrefixes: receivedPrefixesForPersistence(current),
  };
  if (!existing) {
    return {
      ...base,
      establishedSince: base.established ? timestamp : null,
      event: null,
    };
  }
  if (existing.stateCode === current.stateCode) return { ...base, event: null };
  return {
    ...base,
    establishedSince: base.established ? timestamp : null,
    lastStateChangedAt: timestamp,
    event: {
      previousStateCode: existing.stateCode,
      previousState: existing.state,
      currentStateCode: current.stateCode,
      currentState: current.state,
    },
  };
}

export function establishedSinceFromDiscovery(
  peer: BgpDiscoveryPeerInput,
  discoveredAt: Date,
): Date | null {
  if (peer.stateCode !== 6 || peer.state !== 'ESTABLISHED') return null;
  const seconds = peer.sessionUptimeSeconds;
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const timestamp = discoveredAt.getTime() - Math.trunc(seconds) * 1000;
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function decideBgpDiscoveryState(
  existing: ExistingBgpPeerState | null,
  peer: BgpDiscoveryPeerInput,
  discoveredAt: Date,
): BgpDiscoveryStateDecision {
  const discoveredStateAvailable = peer.stateCode !== null && peer.state !== null;
  const candidate = establishedSinceFromDiscovery(peer, discoveredAt);
  if (!existing) {
    const established = peer.stateCode === 6 && peer.state === 'ESTABLISHED';
    return {
      stateCode: peer.stateCode ?? 0,
      state: peer.state ?? 'UNKNOWN',
      established,
      establishedSince: established ? candidate : null,
    };
  }

  // Once SNMP has polled the peer, discovery can enrich it but must not replace
  // the operational state owned by SNMP.
  if (existing.lastPollingAt !== null || !discoveredStateAvailable) {
    return existing.established && existing.establishedSince === null && candidate
      ? { establishedSince: candidate }
      : {};
  }

  const established = peer.stateCode === 6 && peer.state === 'ESTABLISHED';
  return {
    stateCode: peer.stateCode!,
    state: peer.state!,
    established,
    establishedSince: established ? (existing.establishedSince ?? candidate) : null,
  };
}

export function discoveryInterfaceUpdate(peer: BgpDiscoveryPeerInput): {
  interfaceId?: string | null;
} {
  if (peer.correlationStatus === 'COMMAND_FAILED') return {};
  return { interfaceId: peer.correlationStatus === 'MATCHED' ? peer.interfaceId : null };
}

export function deriveBgpPeerDisplayName(
  peerAddress: string,
  interfaceInfo: { alias: string | null; description: string | null; name: string | null } | null,
  peerDescription: string | null = null,
): string {
  const description = peerDescription?.trim();
  if (description) return description;
  const alias = interfaceInfo?.alias?.trim();
  if (alias) return alias;
  const interfaceDescription = interfaceInfo?.description?.trim();
  if (interfaceDescription) return interfaceDescription;
  const name = interfaceInfo?.name?.trim();
  if (name) return name;
  return peerAddress;
}

export function bigintToJsonNumber(value: bigint | null): number | null {
  if (value === null) return null;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

export function bigintToJsonString(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}
