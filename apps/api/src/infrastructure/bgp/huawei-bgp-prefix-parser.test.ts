import { describe, expect, it } from 'vitest';
import { HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID } from './bgp-oids';
import {
  parseHuaweiBgpPrefixIndex,
  parseHuaweiBgpReceivedPrefixes,
} from './huawei-bgp-prefix-parser';

const REAL_PREFIX_FIXTURES: ReadonlyArray<readonly [string, number]> = [
  ['10.1.255.2', 0],
  ['10.1.255.6', 1],
  ['10.1.255.10', 1],
  ['10.1.255.18', 1],
  ['10.200.200.2', 1],
  ['10.200.200.26', 3],
  ['10.200.201.41', 209797],
  ['45.164.184.97', 0],
  ['172.16.0.2', 5],
  ['172.16.0.6', 0],
  ['172.20.10.40', 0],
  ['179.189.80.17', 0],
  ['186.248.101.253', 32],
  ['187.16.216.252', 0],
  ['187.16.216.253', 211752],
  ['187.16.216.254', 211708],
  ['200.150.1.193', 1099912],
  ['200.194.223.109', 1061949],
  ['204.199.34.189', 1061949],
  ['216.31.3.81', 3052],
  ['216.31.7.81', 3052],
];

function ipv4Oid(peerAddress: string): string {
  return `${HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID}.0.1.1.1.4.${peerAddress}`;
}

describe('Huawei received-prefix index parser', () => {
  it('parses the validated NE8000 examples', () => {
    expect(
      parseHuaweiBgpReceivedPrefixes({
        oid: `.${ipv4Oid('200.150.1.193')}`,
        value: 1099912,
      }),
    ).toEqual({ peerAddress: '200.150.1.193', receivedPrefixes: 1099912 });
    expect(
      parseHuaweiBgpReceivedPrefixes({
        oid: ipv4Oid('187.16.216.253'),
        value: '211752',
      }),
    ).toEqual({ peerAddress: '187.16.216.253', receivedPrefixes: 211752 });
  });

  it.each(REAL_PREFIX_FIXTURES)(
    'parses the real fixture for %s',
    (peerAddress, receivedPrefixes) => {
      expect(
        parseHuaweiBgpReceivedPrefixes({
          oid: ipv4Oid(peerAddress),
          value: receivedPrefixes,
        }),
      ).toEqual({ peerAddress, receivedPrefixes });
    },
  );

  it('uses the full structured index instead of the last four components', () => {
    const oid = `${HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID}.9.9.9.9.4.200.150.1.193`;
    expect(parseHuaweiBgpReceivedPrefixes({ oid, value: 1099912 })).toBeNull();
  });

  it('recognizes IPv6 unicast for future support but ignores it in the MVP reading', () => {
    const suffix = [0, 2, 1, 2, 16, 32, 1, 13, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(parseHuaweiBgpPrefixIndex(suffix)).toEqual({
      addressFamily: 'IPV6_UNICAST',
      addressBytes: suffix.slice(5),
      peerAddress: null,
    });
    expect(
      parseHuaweiBgpReceivedPrefixes({
        oid: `${HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID}.${suffix.join('.')}`,
        value: 42,
      }),
    ).toBeNull();
  });

  it.each([
    `${HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID}.0.1.1.1.4.200.150.1`,
    `${HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID}.0.1.1.1.4.200.150.1.999`,
    `${HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID}.0.1.1.1.5.200.150.1.193`,
  ])('rejects a malformed structured index: %s', (oid) => {
    expect(parseHuaweiBgpReceivedPrefixes({ oid, value: 1 })).toBeNull();
  });

  it('accepts Counter32 zero but rejects values outside Counter32', () => {
    expect(parseHuaweiBgpReceivedPrefixes({ oid: ipv4Oid('10.1.255.2'), value: 0 })).toEqual({
      peerAddress: '10.1.255.2',
      receivedPrefixes: 0,
    });
    expect(
      parseHuaweiBgpReceivedPrefixes({
        oid: ipv4Oid('10.1.255.2'),
        value: 0x1_0000_0000,
      }),
    ).toBeNull();
  });
});
