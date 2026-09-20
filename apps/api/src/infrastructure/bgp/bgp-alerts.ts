import type { BgpAlertsResponse, BgpAlertDto, BgpPeerState } from '@gmj/shared';

export interface BgpAlertPeerInput {
  id: string;
  deviceId: string;
  deviceName: string;
  peerAddress: string;
  displayName: string;
  state: BgpPeerState;
  established: boolean;
  lastStateChangedAt: Date | null;
}

export interface BgpAlertEventInput {
  bgpPeerId: string;
  previousState: BgpPeerState;
  previousStateCode: number;
  currentState: BgpPeerState;
  currentStateCode: number;
  occurredAt: Date;
}

const ESTABLISHED_CODE = 6;

/**
 * Derives BGP operational alerts from persisted peers + state-change events.
 *
 * Active: every peer currently not ESTABLISHED (regardless of how long ago the
 * incident started). Resolved: state transitions back into ESTABLISHED within
 * the provided window; the incident duration is only reported when the
 * matching down transition can be derived safely.
 */
export function computeBgpAlerts(
  peers: readonly BgpAlertPeerInput[],
  events: readonly BgpAlertEventInput[],
  resolvedWindowStart: Date,
): BgpAlertsResponse {
  const eventsByPeer = new Map<string, BgpAlertEventInput[]>();
  for (const event of events) {
    const list = eventsByPeer.get(event.bgpPeerId);
    if (list) list.push(event);
    else eventsByPeer.set(event.bgpPeerId, [event]);
  }
  for (const list of eventsByPeer.values()) {
    list.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  }

  const peersById = new Map(peers.map((peer) => [peer.id, peer]));

  const active: BgpAlertDto[] = peers
    .filter((peer) => !peer.established)
    .map((peer) => {
      const list = eventsByPeer.get(peer.id) ?? [];
      const latest = list[list.length - 1];
      return {
        peerId: peer.id,
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        peerAddress: peer.peerAddress,
        displayName: peer.displayName,
        previousState: latest?.previousState ?? null,
        currentState: peer.state,
        startedAt:
          peer.lastStateChangedAt?.toISOString() ?? latest?.occurredAt.toISOString() ?? null,
      };
    })
    .sort(mostRecentFirst);

  const resolved: BgpAlertDto[] = [];
  for (const event of events) {
    if (event.currentStateCode !== ESTABLISHED_CODE) continue;
    if (event.previousStateCode === ESTABLISHED_CODE) continue;
    if (event.occurredAt.getTime() < resolvedWindowStart.getTime()) continue;

    const peer = peersById.get(event.bgpPeerId);
    const durationSeconds = incidentDurationSeconds(eventsByPeer.get(event.bgpPeerId) ?? [], event);
    resolved.push({
      peerId: event.bgpPeerId,
      deviceId: peer?.deviceId ?? '',
      deviceName: peer?.deviceName ?? '',
      peerAddress: peer?.peerAddress ?? '',
      displayName: peer?.displayName ?? event.bgpPeerId,
      previousState: event.previousState,
      currentState: event.currentState,
      startedAt: durationSeconds === null ? null : new Date(event.occurredAt.getTime() - durationSeconds * 1000).toISOString(),
      resolvedAt: event.occurredAt.toISOString(),
      durationSeconds,
    });
  }
  resolved.sort((left, right) =>
    (right.resolvedAt ? Date.parse(right.resolvedAt) : 0) -
    (left.resolvedAt ? Date.parse(left.resolvedAt) : 0),
  );

  return { active, resolved };
}

function mostRecentFirst(left: BgpAlertDto, right: BgpAlertDto): number {
  const leftTime = left.startedAt ? Date.parse(left.startedAt) : 0;
  const rightTime = right.startedAt ? Date.parse(right.startedAt) : 0;
  return rightTime - leftTime;
}

function incidentDurationSeconds(
  events: readonly BgpAlertEventInput[],
  resolved: BgpAlertEventInput,
): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (!candidate) continue;
    if (candidate === resolved) continue;
    if (candidate.occurredAt.getTime() >= resolved.occurredAt.getTime()) continue;
    if (candidate.currentStateCode === ESTABLISHED_CODE) break;
    return Math.max(0, Math.floor((resolved.occurredAt.getTime() - candidate.occurredAt.getTime()) / 1000));
  }
  return null;
}
