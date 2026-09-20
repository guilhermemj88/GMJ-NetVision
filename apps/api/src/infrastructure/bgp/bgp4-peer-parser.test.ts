import { describe, expect, it } from 'vitest';
import { BGP4_PEER_STATE_OID } from './bgp-oids';
import { bgpStateFromCode, parseBgp4PeerState } from './bgp4-peer-parser';

describe('BGP4-MIB peer state parser', () => {
  it('extracts the real IPv4 index and ESTABLISHED state', () => {
    expect(
      parseBgp4PeerState({
        oid: `${BGP4_PEER_STATE_OID}.200.150.1.193`,
        value: 6,
      }),
    ).toEqual({
      peerAddress: '200.150.1.193',
      stateCode: 6,
      state: 'ESTABLISHED',
      established: true,
    });
  });

  it.each([
    [1, 'IDLE'],
    [2, 'CONNECT'],
    [3, 'ACTIVE'],
    [4, 'OPENSENT'],
    [5, 'OPENCONFIRM'],
    [6, 'ESTABLISHED'],
  ] as const)('maps state code %s to %s', (stateCode, state) => {
    expect(bgpStateFromCode(stateCode)).toBe(state);
  });

  it('retains an unknown real state code without treating it as established', () => {
    expect(
      parseBgp4PeerState({
        oid: `${BGP4_PEER_STATE_OID}.172.16.0.6`,
        value: '9',
      }),
    ).toEqual({
      peerAddress: '172.16.0.6',
      stateCode: 9,
      state: 'UNKNOWN',
      established: false,
    });
  });

  it.each([
    `${BGP4_PEER_STATE_OID}.200.150.1`,
    `${BGP4_PEER_STATE_OID}.4.200.150.1.193`,
    `${BGP4_PEER_STATE_OID}.200.150.1.999`,
    '1.3.6.1.2.1.15.3.1.9.200.150.1.193',
  ])('rejects an invalid peer-state OID: %s', (oid) => {
    expect(parseBgp4PeerState({ oid, value: 6 })).toBeNull();
  });
});
