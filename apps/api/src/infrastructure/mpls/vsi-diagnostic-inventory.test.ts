import { describe, expect, it } from 'vitest';
import { EMPTY_MPLS_SUMMARY, type HostRecord, type MplsVsi } from '@gmj/shared';
import {
  precheckVsiInventory,
  VSI_INVENTORY_MAX_AGE_MS,
  type VsiInventoryOverview,
} from './vsi-diagnostic-inventory';

function snapshot() {
  const now = Date.parse('2026-10-23T22:00:00Z'),
    stamp = new Date(now).toISOString();
  const host = { id: 'remote', ip: '192.0.2.2', managementIp: '192.0.2.2' } as HostRecord;
  const peer = { id: 'local', ip: '192.0.2.1', managementIp: '192.0.2.1' } as HostRecord;
  const vsi = {
    id: 'vsi',
    hostId: host.id,
    name: '1041-IX-BH-V4',
    source: 'SNMP',
    lastSeenAt: stamp,
    pws: [],
  } as unknown as MplsVsi;
  const overview: VsiInventoryOverview = {
    supported: true,
    discoveryState: 'FOUND_UP',
    capabilities: { vsi: true, ac: true, pw: false },
    source: 'SNMP',
    sources: ['SNMP'],
    ldpPeers: [],
    l2vcCircuits: [],
    conflicts: [],
    lastPollingAt: stamp,
    lastSuccessAt: stamp,
    lastErrorSafe: null,
    vsis: [vsi],
    summary: { ...EMPTY_MPLS_SUMMARY },
  };
  return { host, peer, vsi, overview, expectedName: vsi.name, now };
}
describe('capability-aware PW pre-execution inventory gate, pure/offline', () => {
  it('false plus a fresh successful VSI snapshot returns an observability limitation without mutation', () => {
    const input = snapshot(),
      before = structuredClone(input);
    expect(precheckVsiInventory(input)).toEqual({
      code: 'PW_EVIDENCE_UNAVAILABLE_VIA_SNMP',
      hostId: 'remote',
      observedAt: input.overview.lastSuccessAt,
      pwSupported: false,
    });
    expect(input).toEqual(before);
  });
  it('true still requires exactly one persisted PW', () => {
    const input = snapshot();
    input.overview.capabilities.pw = true;
    expect(() => precheckVsiInventory(input)).toThrow('PERSISTED_PW_CARDINALITY_MISMATCH');
  });
  it.each([null, undefined])('unknown %s is never coerced to false', (pw) => {
    const input = snapshot();
    input.overview.capabilities.pw = pw;
    expect(() => precheckVsiInventory(input)).toThrow('PW_SNMP_CAPABILITY_UNKNOWN');
  });
  it.each(['WALK_TIMEOUT', 'PARTIAL_COLUMN_FAILURE'])(
    'false plus collection error %s remains blocked',
    (error) => {
      const input = snapshot();
      input.overview.lastErrorSafe = error;
      expect(() => precheckVsiInventory(input)).toThrow('INVENTORY_EVIDENCE_INSUFFICIENT');
    },
  );
  it('false cannot hide retained contradictory PW rows', () => {
    const input = snapshot();
    input.vsi.pws.push({} as never);
    expect(() => precheckVsiInventory(input)).toThrow('PERSISTED_PW_CAPABILITY_CONFLICT');
  });
  it('missing VSI remains blocked', () => {
    expect(() => precheckVsiInventory({ ...snapshot(), vsi: undefined })).toThrow(
      'PERSISTED_VSI_IDENTITY_MISMATCH',
    );
  });
  it.each(['hostId', 'name'] as const)('wrong VSI %s remains blocked', (field) => {
    const input = snapshot();
    input.vsi[field] = 'wrong';
    expect(() => precheckVsiInventory(input)).toThrow('PERSISTED_VSI_IDENTITY_MISMATCH');
  });
  it.each([null, undefined])('missing state %s remains blocked', (overview) => {
    expect(() => precheckVsiInventory({ ...snapshot(), overview })).toThrow(
      'INVENTORY_EVIDENCE_INSUFFICIENT',
    );
  });
  it.each(['lastSuccessAt', 'lastPollingAt'] as const)(
    'stale, invalid, missing and future %s remain blocked',
    (field) => {
      for (const stamp of [null, 'invalid', '2026-10-23T21:54:59Z', '2026-10-23T22:00:01Z']) {
        const input = snapshot();
        input.overview[field] = stamp;
        expect(() => precheckVsiInventory(input)).toThrow('INVENTORY_STALE_OR_INCOMPLETE');
      }
    },
  );
  it('a newer unfinished poll cannot turn a retained false into a usable absence', () => {
    const input = snapshot();
    input.overview.lastSuccessAt = new Date(input.now - 1).toISOString();
    expect(() => precheckVsiInventory(input)).toThrow('INVENTORY_STALE_OR_INCOMPLETE');
  });
  it('stale VSI remains blocked even with a recent device collection', () => {
    const input = snapshot();
    input.vsi.lastSeenAt = new Date(input.now - VSI_INVENTORY_MAX_AGE_MS - 1).toISOString();
    expect(() => precheckVsiInventory(input)).toThrow('INVENTORY_STALE_OR_INCOMPLETE');
  });
  it('true accepts only a fresh internally consistent reciprocal PW and preserves all labels', () => {
    const input = snapshot();
    input.overview.capabilities.pw = true;
    input.vsi.pws = [
      {
        hostId: 'remote',
        mplsVsiId: 'vsi',
        vsiName: input.vsi.name,
        remoteIp: input.peer.ip,
        remoteHostId: input.peer.id,
        lastSeenAt: input.vsi.lastSeenAt,
        inboundLabel: 123,
        outboundLabel: 456,
      } as never,
    ];
    const before = structuredClone(input);
    expect(precheckVsiInventory(input)).toBeNull();
    expect(input).toEqual(before);
    input.vsi.pws[0]!.remoteIp = '192.0.2.99';
    expect(() => precheckVsiInventory(input)).toThrow('PERSISTED_PEER_IP_MISMATCH');
    input.vsi.pws[0]!.remoteIp = input.peer.ip;
    input.vsi.pws[0]!.remoteHostId = 'another-host';
    expect(() => precheckVsiInventory(input)).toThrow('PERSISTED_PEER_IP_MISMATCH');
    input.vsi.pws[0]!.remoteHostId = input.peer.id;
    input.vsi.pws.push({ ...input.vsi.pws[0]! });
    expect(() => precheckVsiInventory(input)).toThrow('PERSISTED_PW_CARDINALITY_MISMATCH');
  });
});
