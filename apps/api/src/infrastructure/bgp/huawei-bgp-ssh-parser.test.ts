import { describe, expect, it } from 'vitest';
import {
  mergeHuaweiBgpPeerDetails,
  parseHuaweiAsNumber,
  parseHuaweiBgpPeerSummary,
  parseHuaweiBgpPeerVerbose,
  parseHuaweiBgpUptime,
  parseHuaweiRouteLookup,
} from './huawei-bgp-ssh-parser';

const SUMMARY_OUTPUT = `
BGP local router ID : 172.16.0.1
Local AS number : 65000
Total number of peers : 3                 Peers in established state : 1

 Peer                 V          AS  MsgRcvd  MsgSent  OutQ  Up/Down       State PrefRcv
 200.150.1.193         4       12345    12992    13005     0  18d04h Established 1099912
 172.16.0.6            4       65006       10       11     0  00:04:21 Active      0
 10.1.255.2            4       65002        0        0     0  Never Idle
 invalid row that must be ignored
`;

describe('Huawei BGP SSH parser', () => {
  it('parses an ESTABLISHED peer with ASN, uptime and PrefRcv', () => {
    expect(parseHuaweiBgpPeerSummary(SUMMARY_OUTPUT)[0]).toEqual({
      peerAddress: '200.150.1.193',
      remoteAs: 12345n,
      stateCode: 6,
      state: 'ESTABLISHED',
      sessionUptimeSeconds: 18 * 86400 + 4 * 3600,
      cliReceivedPrefixes: 1099912n,
      bgpPeerDescription: null,
    });
  });

  it('parses an ACTIVE peer and does not expose its transition timer as session uptime', () => {
    expect(parseHuaweiBgpPeerSummary(SUMMARY_OUTPUT)[1]).toEqual({
      peerAddress: '172.16.0.6',
      remoteAs: 65006n,
      stateCode: 3,
      state: 'ACTIVE',
      sessionUptimeSeconds: null,
      cliReceivedPrefixes: 0n,
      bgpPeerDescription: null,
    });
  });

  it('keeps a peer valid when uptime and PrefRcv are absent', () => {
    expect(parseHuaweiBgpPeerSummary(SUMMARY_OUTPUT)[2]).toEqual({
      peerAddress: '10.1.255.2',
      remoteAs: 65002n,
      stateCode: 1,
      state: 'IDLE',
      sessionUptimeSeconds: null,
      cliReceivedPrefixes: null,
      bgpPeerDescription: null,
    });
  });

  it.each([
    ['00:32:10', 1930],
    ['1d02h', 93600],
    ['18d04h', 1569600],
    ['12w3d', 7516800],
    ['00h32m10s', 1930],
  ])('converts Huawei uptime %s', (value, expected) => {
    expect(parseHuaweiBgpUptime(value)).toBe(expected);
  });

  it.each(['Never', '-', '01:99:00', '1dgarbage', ''])('rejects invalid uptime %s', (value) => {
    expect(parseHuaweiBgpUptime(value)).toBeNull();
  });

  it('parses ASPLAIN and ASDOT remote AS formats', () => {
    expect(parseHuaweiAsNumber('AS12345')).toBe(12345n);
    expect(parseHuaweiAsNumber('1.10')).toBe(65546n);
  });

  it('normalizes a Huawei Idle(Admin) peer to IDLE', () => {
    expect(parseHuaweiBgpPeerSummary(
      '10.1.255.2 4 65002 0 0 0 Never Idle(Admin)',
    )[0]).toMatchObject({ stateCode: 1, state: 'IDLE' });
  });

  it('ignores invalid lines and returns an empty result for empty output', () => {
    expect(parseHuaweiBgpPeerSummary('invalid\n999.1.1.1 4 65000 0 0 0 Never Idle')).toEqual([]);
    expect(parseHuaweiBgpPeerSummary('')).toEqual([]);
  });

  it('parses verbose blocks and complements only missing summary fields', () => {
    const summary = parseHuaweiBgpPeerSummary('200.150.1.193 4 12345 10 10 0 - Established');
    const verbose = parseHuaweiBgpPeerVerbose(`
BGP Peer is 200.150.1.193, remote AS 12345
BGP current state: Established, Up for 18d04h
Prefixes current: 1099912, best: 1099912
`);
    expect(mergeHuaweiBgpPeerDetails(summary, verbose)).toEqual([
      {
        peerAddress: '200.150.1.193',
        remoteAs: 12345n,
        stateCode: 6,
        state: 'ESTABLISHED',
      sessionUptimeSeconds: 1569600,
        cliReceivedPrefixes: 1099912n,
        bgpPeerDescription: null,
      },
    ]);
  });

  it('extracts the peer description from a verbose block (NE8000 VRP format)', () => {
    const verbose = parseHuaweiBgpPeerVerbose(`
BGP Peer is 200.150.1.193, remote AS 12345
Peer Description: TRANSITO LEVEL3
BGP current state: Established, Up for 18d04h
Prefixes current: 1099912, best: 1099912
`);
    expect(verbose[0]).toMatchObject({
      peerAddress: '200.150.1.193',
      remoteAs: 12345n,
      stateCode: 6,
      state: 'ESTABLISHED',
      bgpPeerDescription: 'TRANSITO LEVEL3',
    });
  });

  it('merges the verbose peer description over the summary', () => {
    const summary = parseHuaweiBgpPeerSummary('200.150.1.193 4 12345 10 10 0 - Established');
    const verbose = parseHuaweiBgpPeerVerbose(`
BGP Peer is 200.150.1.193, remote AS 12345
Peer Description: IX SP
BGP current state: Established, Up for 18d04h
Prefixes current: 1099912
`);
    expect(mergeHuaweiBgpPeerDetails(summary, verbose)[0]).toMatchObject({
      bgpPeerDescription: 'IX SP',
    });
  });
});

describe('Huawei route lookup parser', () => {
  it('extracts a final interface even when its long name contains a space', () => {
    expect(
      parseHuaweiRouteLookup(`
Routing Table : _public_
Summary Count : 1
Destination/Mask    Proto   Pre  Cost   Flags NextHop       Interface
200.150.1.192/30    Direct  0    0      D    200.150.1.194 GigabitEthernet 1/0/1
`),
    ).toEqual({
      routeFound: true,
      interfaceNames: ['GigabitEthernet 1/0/1'],
      unresolvedRoute: false,
    });
  });

  it('detects a route whose recursive next hop has no final interface', () => {
    expect(
      parseHuaweiRouteLookup(`
Summary Count : 1
200.150.1.193/32 IBGP 255 0 R 10.0.0.2
`),
    ).toEqual({ routeFound: true, interfaceNames: [], unresolvedRoute: true });
  });

  it('returns no route for an empty successful lookup', () => {
    expect(parseHuaweiRouteLookup('Summary Count : 0')).toEqual({
      routeFound: false,
      interfaceNames: [],
      unresolvedRoute: false,
    });
  });

  it('marks a partially parsed multi-route result as unresolved', () => {
    expect(parseHuaweiRouteLookup(`
Summary Count : 2
200.150.1.192/30 OSPF 10 0 D 10.0.0.1 100GE1/0/1
unrecognized second route format
`)).toEqual({
      routeFound: true,
      interfaceNames: ['100GE1/0/1'],
      unresolvedRoute: true,
    });
  });
});
