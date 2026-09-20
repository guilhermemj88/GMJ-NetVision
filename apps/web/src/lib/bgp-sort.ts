import type { BgpDashboardPeer } from '@gmj/shared';

export type BgpSortKey = 'state' | 'peer' | 'asn' | 'routes' | 'traffic' | 'uptime';
export type BgpSortDirection = 'asc' | 'desc';

export interface BgpSort {
  key: BgpSortKey;
  direction: BgpSortDirection;
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function numericValue(peer: BgpDashboardPeer, key: Exclude<BgpSortKey, 'peer'>): number | null {
  switch (key) {
    case 'state':
      return peer.established ? 1 : 0;
    case 'routes':
      return peer.receivedPrefixes;
    case 'uptime':
      return peer.establishedSince ? Date.parse(peer.establishedSince) || null : null;
    case 'asn': {
      if (peer.remoteAs === null) return null;
      const value = Number(peer.remoteAs);
      return Number.isFinite(value) ? value : null;
    }
    case 'traffic': {
      const iface = peer.interface;
      if (!iface || (iface.rxBps === null && iface.txBps === null)) return null;
      return (iface.rxBps ?? 0) + (iface.txBps ?? 0);
    }
  }
}

/** Sorts peers within a single device group; nulls are always pushed to the end. */
export function sortBgpPeers(peers: BgpDashboardPeer[], sort: BgpSort): BgpDashboardPeer[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...peers].sort((left, right) => {
    if (sort.key === 'peer') {
      const value =
        collator.compare(left.displayName || left.peerAddress, right.displayName || right.peerAddress) *
        direction;
      return value !== 0 ? value : collator.compare(left.peerAddress, right.peerAddress);
    }

    const leftValue = numericValue(left, sort.key);
    const rightValue = numericValue(right, sort.key);
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const value = (leftValue - rightValue) * direction;
    return value !== 0 ? value : collator.compare(left.peerAddress, right.peerAddress);
  });
}

export function nextSort(current: BgpSort, key: BgpSortKey): BgpSort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: 'asc' };
}
