import { describe, expect, it } from 'vitest';
import type { BgpDashboardPeer } from '@gmj/shared';
import { nextSort, sortBgpPeers } from './bgp-sort';

function peer(overrides: Partial<BgpDashboardPeer>): BgpDashboardPeer {
  return {
    id: 'p',
    deviceId: 'd',
    deviceHostname: 'host',
    deviceDisplayName: 'device',
    bgpMonitoringEnabled: true,
    peerAddress: '10.0.0.1',
    displayName: '10.0.0.1',
    addressFamily: 'IPV4',
    localAs: '268568',
    remoteAs: null,
    role: 'OTHER',
    monitoringEnabled: true,
    stateCode: 6,
    state: 'ESTABLISHED',
    established: true,
    adminState: 'UNKNOWN',
    adminStateCheckedAt: null,
    receivedPrefixes: null,
    establishedSince: null,
    lastPollingAt: null,
    lastDiscoveryAt: null,
    interface: null,
    ...overrides,
  };
}

const fixtures: BgpDashboardPeer[] = [
  peer({ id: 'a', displayName: 'TRANSITO XYZ', peerAddress: '200.150.1.193', remoteAs: '12345', receivedPrefixes: 1000, establishedSince: '2026-09-01T00:00:00.000Z', interface: { id: 'i1', name: 'X', alias: null, description: null, rxBps: 100, txBps: 200 } }),
  peer({ id: 'b', displayName: 'IX SP', peerAddress: '187.16.216.253', remoteAs: '26162', receivedPrefixes: null, establishedSince: '2026-09-10T00:00:00.000Z', interface: { id: 'i2', name: 'Y', alias: null, description: null, rxBps: 500, txBps: 500 } }),
  peer({ id: 'c', displayName: '10.0.0.1', peerAddress: '10.0.0.1', remoteAs: null, receivedPrefixes: 500, establishedSince: null, established: false, stateCode: 3, state: 'ACTIVE', interface: null }),
];

describe('sortBgpPeers', () => {
  it('sorts routes ascending with null last', () => {
    const sorted = sortBgpPeers(fixtures, { key: 'routes', direction: 'asc' });
    expect(sorted.map((p) => p.receivedPrefixes)).toEqual([500, 1000, null]);
  });

  it('sorts routes descending with null last', () => {
    const sorted = sortBgpPeers(fixtures, { key: 'routes', direction: 'desc' });
    expect(sorted.map((p) => p.receivedPrefixes)).toEqual([1000, 500, null]);
  });

  it('sorts ASN ascending with null last', () => {
    const sorted = sortBgpPeers(fixtures, { key: 'asn', direction: 'asc' });
    expect(sorted.map((p) => p.remoteAs)).toEqual(['12345', '26162', null]);
  });

  it('sorts peer by displayName', () => {
    const sorted = sortBgpPeers(fixtures, { key: 'peer', direction: 'asc' });
    expect(sorted[0]!.displayName).toBe('10.0.0.1');
  });

  it('sorts traffic by rx+tx with null last', () => {
    const sorted = sortBgpPeers(fixtures, { key: 'traffic', direction: 'asc' });
    expect(sorted.map((p) => p.interface?.id ?? null)).toEqual(['i1', 'i2', null]);
  });

  it('sorts state with DOWN before UP ascending', () => {
    const sorted = sortBgpPeers(fixtures, { key: 'state', direction: 'asc' });
    expect(sorted[0]!.id).toBe('c');
  });

  it('sorts uptime descending with null last', () => {
    const sorted = sortBgpPeers(fixtures, { key: 'uptime', direction: 'desc' });
    expect(sorted.map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const copy = [...fixtures];
    sortBgpPeers(fixtures, { key: 'routes', direction: 'asc' });
    expect(fixtures.map((p) => p.id)).toEqual(copy.map((p) => p.id));
  });

  it('sorts a mixed IPv4/IPv6 list by every column without losing peers', () => {
    const mixed = [
      ...fixtures,
      peer({
        id: 'v6',
        displayName: 'CLIENTE IPV6',
        peerAddress: '2001:db8::10',
        addressFamily: 'IPV6',
        remoteAs: '265424',
        receivedPrefixes: 750,
        establishedSince: '2026-09-05T00:00:00.000Z',
        interface: { id: 'i3', name: 'Z', alias: null, description: null, rxBps: 10, txBps: 10 },
      }),
    ];
    for (const key of ['state', 'peer', 'asn', 'routes', 'traffic', 'uptime'] as const) {
      const sorted = sortBgpPeers(mixed, { key, direction: 'asc' });
      expect(sorted).toHaveLength(mixed.length);
      expect(new Set(sorted.map((item) => item.id)).size).toBe(mixed.length);
    }
    const byRoutes = sortBgpPeers(mixed, { key: 'routes', direction: 'asc' });
    expect(byRoutes.map((item) => item.receivedPrefixes)).toEqual([500, 750, 1000, null]);
  });
});

describe('nextSort', () => {
  it('toggles direction on repeated key', () => {
    expect(nextSort({ key: 'routes', direction: 'asc' }, 'routes')).toEqual({
      key: 'routes',
      direction: 'desc',
    });
  });

  it('starts ascending for a new key', () => {
    expect(nextSort({ key: 'routes', direction: 'desc' }, 'asn')).toEqual({
      key: 'asn',
      direction: 'asc',
    });
  });
});
