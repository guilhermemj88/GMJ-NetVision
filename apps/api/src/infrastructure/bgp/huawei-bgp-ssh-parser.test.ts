import { describe, expect, it } from 'vitest';
import {
  isAdminIgnoredCliState,
  mergeHuaweiBgpPeerDetails,
  parseHuaweiAsNumber,
  parseHuaweiBgpLocalAs,
  parseHuaweiBgpPeerSummary,
  parseHuaweiBgpPeerVerbose,
  parseHuaweiBgpUptime,
  parseHuaweiPeerAdminConfig,
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
      addressFamily: 'IPV4',
      remoteAs: 12345n,
      stateCode: 6,
      state: 'ESTABLISHED',
      sessionUptimeSeconds: 18 * 86400 + 4 * 3600,
      cliReceivedPrefixes: 1099912n,
      bgpPeerDescription: null,
      cliStateToken: 'Established',
    });
  });

  it('parses an ACTIVE peer and does not expose its transition timer as session uptime', () => {
    expect(parseHuaweiBgpPeerSummary(SUMMARY_OUTPUT)[1]).toEqual({
      peerAddress: '172.16.0.6',
      addressFamily: 'IPV4',
      remoteAs: 65006n,
      stateCode: 3,
      state: 'ACTIVE',
      sessionUptimeSeconds: null,
      cliReceivedPrefixes: 0n,
      bgpPeerDescription: null,
      cliStateToken: 'Active',
    });
  });

  it('keeps a peer valid when uptime and PrefRcv are absent', () => {
    expect(parseHuaweiBgpPeerSummary(SUMMARY_OUTPUT)[2]).toEqual({
      peerAddress: '10.1.255.2',
      addressFamily: 'IPV4',
      remoteAs: 65002n,
      stateCode: 1,
      state: 'IDLE',
      sessionUptimeSeconds: null,
      cliReceivedPrefixes: null,
      bgpPeerDescription: null,
      cliStateToken: 'Idle',
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
        addressFamily: 'IPV4',
        remoteAs: 12345n,
        stateCode: 6,
        state: 'ESTABLISHED',
        sessionUptimeSeconds: 1569600,
        cliReceivedPrefixes: 1099912n,
        bgpPeerDescription: null,
        cliStateToken: 'Established',
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

describe('Huawei BGP IPv6 parser', () => {
  const IPV6_SUMMARY = `
 BGP local router ID : 45.163.144.1
 Local AS number : 268568
 Total number of peers : 2                 Peers in established state : 1

  Peer            V          AS  MsgRcvd  MsgSent  OutQ  Up/Down       State PrefRcv
  2001:DB8::10    4       265424    12992    13005     0  18d04h Established 1099912
  2001:0DB8:0:1::1  4      265424        5        6     0  00:02:10 Active       0
`;

  it('parses IPv6 peers and canonicalizes their addresses', () => {
    const peers = parseHuaweiBgpPeerSummary(IPV6_SUMMARY, 'IPV6');
    expect(peers).toEqual([
      {
        peerAddress: '2001:db8::10',
        addressFamily: 'IPV6',
        remoteAs: 265424n,
        stateCode: 6,
        state: 'ESTABLISHED',
        sessionUptimeSeconds: 18 * 86400 + 4 * 3600,
        cliReceivedPrefixes: 1099912n,
        bgpPeerDescription: null,
        cliStateToken: 'Established',
      },
      {
        peerAddress: '2001:db8:0:1::1',
        addressFamily: 'IPV6',
        remoteAs: 265424n,
        stateCode: 3,
        state: 'ACTIVE',
        sessionUptimeSeconds: null,
        cliReceivedPrefixes: 0n,
        bgpPeerDescription: null,
        cliStateToken: 'Active',
      },
    ]);
  });

  it('never mixes families: an IPv4 row is not returned by the IPv6 parser', () => {
    expect(parseHuaweiBgpPeerSummary(SUMMARY_OUTPUT, 'IPV6')).toEqual([]);
    expect(parseHuaweiBgpPeerSummary(IPV6_SUMMARY, 'IPV4')).toEqual([]);
  });

  it('deduplicates equivalent IPv6 representations of the same peer', () => {
    expect(
      parseHuaweiBgpPeerSummary(
        '2001:0db8::1 4 65001 1 1 0 1d02h Established 5\n2001:DB8:0:0:0:0:0:1 4 65001 1 1 0 1d02h Established 5',
        'IPV6',
      ),
    ).toHaveLength(1);
  });

  it('parses an IPv6 verbose block with description, uptime and prefixes', () => {
    const verbose = parseHuaweiBgpPeerVerbose(
      `
BGP Peer is 2001:DB8::10,  remote AS 265424
Peer Description: CLIENTE IPV6 IX
BGP current state: Established, Up for 18d04h
Prefixes current: 1099912, best: 1099912
`,
      'IPV6',
    );
    expect(verbose).toEqual([
      {
        peerAddress: '2001:db8::10',
        addressFamily: 'IPV6',
        remoteAs: 265424n,
        stateCode: 6,
        state: 'ESTABLISHED',
        sessionUptimeSeconds: 1569600,
        cliReceivedPrefixes: 1099912n,
        bgpPeerDescription: 'CLIENTE IPV6 IX',
        cliStateToken: 'Established',
      },
    ]);
  });
});

describe('Huawei BGP local AS parser', () => {
  it('learns the local ASN from the BGP configuration section', () => {
    expect(
      parseHuaweiBgpLocalAs(`
#
bgp 268568
 router-id 45.163.144.1
 peer 10.200.200.10 as-number 265424
#
return
`),
    ).toEqual({ localAs: 268568n, ambiguous: false });
  });

  it('learns a different ASN for a different device/context', () => {
    expect(parseHuaweiBgpLocalAs('bgp 273003\n router-id 10.10.10.10')).toEqual({
      localAs: 273003n,
      ambiguous: false,
    });
  });

  it('converts an ASDOT local ASN', () => {
    expect(parseHuaweiBgpLocalAs('bgp 1.10')).toEqual({ localAs: 65546n, ambiguous: false });
  });

  it('never uses a peer remote AS as the local AS', () => {
    expect(parseHuaweiBgpLocalAs('bgp 268568\n peer 10.200.200.10 as-number 265424')).toEqual({
      localAs: 268568n,
      ambiguous: false,
    });
  });

  it('returns no value when the configuration exposes no BGP process', () => {
    expect(parseHuaweiBgpLocalAs('Error: Unrecognized command')).toEqual({
      localAs: null,
      ambiguous: false,
    });
  });

  it('marks a context with two BGP processes as ambiguous', () => {
    expect(parseHuaweiBgpLocalAs('bgp 268568\nbgp 273003')).toEqual({
      localAs: null,
      ambiguous: true,
    });
    expect(parseHuaweiBgpLocalAs('bgp 268568\nbgp 268568')).toEqual({
      localAs: 268568n,
      ambiguous: false,
    });
  });
});

describe('Huawei BGP admin-state read-back parser', () => {
  it('confirms an ignored IPv4 peer from the filtered configuration', () => {
    expect(parseHuaweiPeerAdminConfig(' peer 10.200.200.10 ignore', '10.200.200.10')).toBe(
      'IGNORED',
    );
  });

  it('confirms an enabled peer when the peer exists without the ignore keyword', () => {
    expect(
      parseHuaweiPeerAdminConfig(' peer 10.200.200.10 as-number 265424', '10.200.200.10'),
    ).toBe('ENABLED');
  });

  it('does not confuse a longer address that shares the prefix', () => {
    expect(parseHuaweiPeerAdminConfig(' peer 10.200.200.100 ignore', '10.200.200.10')).toBeNull();
  });

  it('confirms an ignored IPv6 peer regardless of case and compression', () => {
    expect(parseHuaweiPeerAdminConfig(' peer 2001:DB8:0:0::10 ignore', '2001:db8::10')).toBe(
      'IGNORED',
    );
  });

  it('returns null when the peer is absent from the read-back output', () => {
    expect(parseHuaweiPeerAdminConfig(' peer 10.200.200.11 ignore', '10.200.200.10')).toBeNull();
  });

  it('detects the Idle(Admin) CLI state used as secondary read-back', () => {
    expect(isAdminIgnoredCliState('Idle(Admin)')).toBe(true);
    expect(isAdminIgnoredCliState('Idle')).toBe(false);
    expect(isAdminIgnoredCliState(null)).toBe(false);
  });

  it('exposes the raw CLI state token from the summary parser', () => {
    expect(
      parseHuaweiBgpPeerSummary('10.1.255.2 4 65002 0 0 0 Never Idle(Admin)', 'IPV4')[0],
    ).toMatchObject({ stateCode: 1, state: 'IDLE', cliStateToken: 'Idle(Admin)' });
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

describe('Huawei IPv6 route lookup parser', () => {
  it('extracts the interface from the IPv6 block layout', () => {
    expect(
      parseHuaweiRouteLookup(
        `
Route Flags: R - relay, D - download to fib
------------------------------------------------------------------------------
Routing Table : Public
Summary Count : 1

Destination  : 2001:DB8::10                              PrefixLength : 128
NextHop      : 2001:DB8::1                               Preference   : 60
Interface    : 100GE1/0/3                                Flags        : RD
`,
        'IPV6',
      ),
    ).toEqual({
      routeFound: true,
      interfaceNames: ['100GE1/0/3'],
      unresolvedRoute: false,
    });
  });

  it('extracts the interface from the IPv6 single-line layout', () => {
    expect(
      parseHuaweiRouteLookup(
        `Summary Count : 1
2001:DB8::/64  Direct  0    0    D    2001:DB8::1    100GE1/0/4
`,
        'IPV6',
      ),
    ).toEqual({ routeFound: true, interfaceNames: ['100GE1/0/4'], unresolvedRoute: false });
  });

  it('keeps an IPv6 route without a safe interface unresolved', () => {
    expect(
      parseHuaweiRouteLookup(
        `Summary Count : 1
2001:DB8::10/128  IBGP  255  0  R  2001:DB8::1
`,
        'IPV6',
      ),
    ).toEqual({ routeFound: true, interfaceNames: [], unresolvedRoute: true });
  });

  it('reports no route when the IPv6 lookup is empty', () => {
    expect(parseHuaweiRouteLookup('Summary Count : 0', 'IPV6')).toEqual({
      routeFound: false,
      interfaceNames: [],
      unresolvedRoute: false,
    });
  });
});
