import { describe, expect, it } from 'vitest';
import {
  JuniperBgpConfigError,
  assertJunosReadOnly,
  buildJunosAdvertisedRoutesCommand,
  buildJunosRouteCommand,
  parseJunosAdvertisedRoutes,
  parseJunosBgpConfig,
  parseJunosBgpSummary,
  parseJunosRouteLookup,
  parseJunosUptime,
} from './juniper-junos-bgp-parser';

/** Trecho REAL do `show bgp summary | no-more` de VIANET-OUROPRETO (19.2R1.8). */
const SUMMARY_19_2 = `Threading mode: BGP I/O
Groups: 17 Peers: 24 Down peers: 0
Table          Tot Paths  Act Paths Suppressed    History Damp State    Pending
inet6.0
                 1200483     261589          0          0          0          0
inet.0
                 4578834    1110477          0          0          0          0
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.141.1.81           23106   25109521      97966       0      27 4w3d 21:18:46 Establ
  inet.0: 491930/1103955/1103955/0
167.250.0.242        265185     157917     147344       0       5 6w5d 23:07:57 Establ
  inet.0: 0/18/18/0
187.16.216.254        26162      99720        561       0      67     4:20:47 Establ
  inet.0: 3465/213788/213788/0
2001:1291:1602:1::a       16735  250209872     235895       0      15 10w6d 18:57:19 Establ
  inet6.0: 18301/245187/245187/0
2804:2bf8:dddd:1::fffe       11344      19419      20709       0      81 6d 17:48:07 Establ
  inet6.0: 0/0/0/0
`;

/** Trecho REAL do `show bgp summary | no-more` de BORDA-VIANET-NOVA-LIMA (19.4R3-S10.3). */
const SUMMARY_19_4 = `Groups: 9 Peers: 9 Down peers: 0
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.147.50.9          265185     104975   25106261       0       3 4w3d 21:21:17 Establ
  inet.0: 0/18/18/0
100.110.155.14        16735   11967944      99812       0       1 4w3d 21:21:19 Establ
  inet.0: 824071/1070584/1070583/0
2804:5f64:1000::e85      269096   30260775      99721       0       1 4w3d 20:41:53 Establ
  inet6.0: 73233/256322/256321/0
fd00:0:1::151         23106   76593124     190055       0       1 8w4d 17:18:49 Establ
  inet6.0: 154408/254561/254560/0
`;

const CONFIG_19_2 = `set protocols bgp group NETFLIX import BGP-IPV4-NETFLIX-IMP
set protocols bgp group NETFLIX description "NETFLIX IX"
set protocols bgp group NETFLIX peer-as 40027
set protocols bgp group NETFLIX neighbor 167.250.0.130
set protocols bgp group NETFLIX neighbor 2804:2bf8:dddd:2::4 family inet6 unicast
set protocols bgp group ROUTER_DC local-as 265185
set protocols bgp group ROUTER_DC peer-as 23106
set protocols bgp group ROUTER_DC neighbor 10.147.50.9 description "ROUTER DC"
set protocols bgp group ATC local-as 265185
set protocols bgp group ATC peer-as 23106
set protocols bgp group ATC neighbor 10.141.1.81 local-as 265185
`;

const ROUTING_OPTIONS = `set routing-options autonomous-system 52575
`;

/** Saída REAL de `show route 167.250.0.94 | no-more` (múltiplas instâncias). */
const ROUTE_IPV4 = `inet.0: 1114132 destinations, 4582007 routes (1114132 active, 0 holddown, 1 hidden)
+ = Active Route, - = Last Active, * = Both

167.250.0.64/27    *[Direct/0] 23w1d 18:44:54
                    >  via ae0.2800

mgmt_junos.inet.0: 3 destinations, 3 routes (3 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

0.0.0.0/0          *[Static/5] 1d 00:00:23
                    >  to 192.168.3.1 via fxp0.0

CGNAT-ISP.inet.0: 69 destinations, 69 routes (69 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

167.250.0.64/27    *[Direct/0] 23w1d 18:44:54
                    >  via ae0.2800
`;

const ROUTE_IPV6 = `inet6.0: 263988 destinations, 1202896 routes (263973 active, 15 holddown, 254724 hidden)
+ = Active Route, - = Last Active, * = Both

2804:2bf8:dddd:2::/64
                   *[Direct/0] 23w1d 18:44:44
                    >  via ae0.2810
`;

/** Saída REAL de `show route advertising-protocol bgp 10.141.1.81 | no-more`. */
const ADVERTISED = `inet.0: 1114132 destinations, 4582007 routes (1114132 active, 0 holddown, 1 hidden)
Prefix                  Nexthop              MED     Lclpref    AS path
167.250.0.0/22          Self                                    265185 265185 265185 [265185] I
168.196.16.0/22         Self                                    265185 265185 265185 [265185] I
168.196.19.0/24         Self                                    265185 265185 265185 [265185] I
177.86.184.0/21         Self                                    265185 265185 [265185] 52575 I
200.219.139.0/24        10.141.1.81    100     200                     65001 6939 E
`;

describe('parseJunosUptime', () => {
  it('converts every Junos uptime shape seen in production', () => {
    expect(parseJunosUptime('4w4d 10:00:31')).toBe(
      4 * 604_800 + 4 * 86_400 + 10 * 3_600 + 31,
    );
    expect(parseJunosUptime('6d 17:48:07')).toBe(6 * 86_400 + 17 * 3_600 + 48 * 60 + 7);
    expect(parseJunosUptime('1d 5:15:37')).toBe(86_400 + 5 * 3_600 + 15 * 60 + 37);
    expect(parseJunosUptime('4:20:47')).toBe(4 * 3_600 + 20 * 60 + 47);
    expect(parseJunosUptime('8w4d 17:18:49')).toBe(
      8 * 604_800 + 4 * 86_400 + 17 * 3_600 + 18 * 60 + 49,
    );
  });

  it('returns null instead of inventing a duration for garbage', () => {
    expect(parseJunosUptime('')).toBeNull();
    expect(parseJunosUptime('never')).toBeNull();
    expect(parseJunosUptime('1d 05:x0:37')).toBeNull();
  });
});

describe('parseJunosBgpSummary', () => {
  it('reads IPv4 and IPv6 peers from a single 19.2 summary', () => {
    const summary = parseJunosBgpSummary(SUMMARY_19_2);

    expect(summary.groups).toBe(17);
    expect(summary.declaredPeers).toBe(24);
    expect(summary.declaredDownPeers).toBe(0);
    expect(summary.warnings).toEqual([]);
    expect(summary.peers.map((peer) => [peer.peerAddress, peer.addressFamily])).toEqual([
      ['10.141.1.81', 'IPV4'],
      ['167.250.0.242', 'IPV4'],
      ['187.16.216.254', 'IPV4'],
      ['2001:1291:1602:1::a', 'IPV6'],
      ['2804:2bf8:dddd:1::fffe', 'IPV6'],
    ]);
  });

  it('uses the SECOND value of Active/Received/Accepted/Damped as receivedPrefixes', () => {
    const peers = parseJunosBgpSummary(SUMMARY_19_2).peers;
    const byAddress = new Map(peers.map((peer) => [peer.peerAddress, peer]));

    // inet.0: 491930/1103955/1103955/0 → recebidos = 1103955, nunca 491930.
    expect(byAddress.get('10.141.1.81')?.activePrefixes).toBe(491_930);
    expect(byAddress.get('10.141.1.81')?.receivedPrefixes).toBe(1_103_955n);
    // inet.6: 18301/245187/245187/0 → recebidos = 245187.
    expect(byAddress.get('2001:1291:1602:1::a')?.activePrefixes).toBe(18_301);
    expect(byAddress.get('2001:1291:1602:1::a')?.receivedPrefixes).toBe(245_187n);
    // um peer estabelecido pode legitimamente receber 0 (não é ausência de dado).
    expect(byAddress.get('2804:2bf8:dddd:1::fffe')?.receivedPrefixes).toBe(0n);
  });

  it('captures the remote AS from the AS column and never treats it as localAs', () => {
    const peers = parseJunosBgpSummary(SUMMARY_19_2).peers;
    const byAddress = new Map(peers.map((peer) => [peer.peerAddress, peer]));

    expect(byAddress.get('10.141.1.81')?.remoteAs).toBe(23_106n);
    expect(byAddress.get('167.250.0.242')?.remoteAs).toBe(265_185n);
    expect(byAddress.get('2001:1291:1602:1::a')?.remoteAs).toBe(16_735n);
    // localAs não existe no summary: é resolvido pela MIB/config, nunca aqui.
    expect(Object.keys(byAddress.get('10.141.1.81')!)).not.toContain('localAs');
  });

  it('parses state and uptime from both Junos releases', () => {
    const summary = parseJunosBgpSummary(SUMMARY_19_4);
    const byAddress = new Map(summary.peers.map((peer) => [peer.peerAddress, peer]));

    expect(summary.declaredPeers).toBe(9);
    expect(byAddress.get('10.147.50.9')).toMatchObject({
      addressFamily: 'IPV4',
      remoteAs: 265_185n,
      stateCode: 6,
      state: 'ESTABLISHED',
      sessionUptimeSeconds: 4 * 604_800 + 3 * 86_400 + 21 * 3_600 + 21 * 60 + 17,
      receivedPrefixes: 18n,
    });
    expect(byAddress.get('fd00:0:1::151')).toMatchObject({
      addressFamily: 'IPV6',
      remoteAs: 23_106n,
      stateCode: 6,
      sessionUptimeSeconds: 8 * 604_800 + 4 * 86_400 + 17 * 3_600 + 18 * 60 + 49,
      receivedPrefixes: 254_561n,
    });
  });

  it('keeps a peer without a family line without inventing a prefix count', () => {
    const summary = parseJunosBgpSummary(`Peer                     AS      InPkt     OutPkt
10.0.0.1              65001         10         10       0      0     1:00:00 Establ
`);

    expect(summary.peers).toHaveLength(1);
    expect(summary.peers[0]?.receivedPrefixes).toBeNull();
    expect(summary.warnings[0]).toMatch(/linha de família ausente/);
  });

  it('does not report prefixes for a peer that is not established', () => {
    const summary = parseJunosBgpSummary(`10.0.0.1              65001         10         10       0      0    1d 1:00:00 Active
  inet.0: 5/900/900/0
`);

    expect(summary.peers[0]).toMatchObject({
      stateCode: 3,
      state: 'ACTIVE',
      receivedPrefixes: null,
      activePrefixes: 5,
    });
  });
});

describe('parseJunosBgpConfig', () => {
  it('resolves per-peer local-as with neighbor > group > autonomous-system precedence', () => {
    const config = parseJunosBgpConfig(CONFIG_19_2, ROUTING_OPTIONS);

    expect(config.autonomousSystem).toBe(52_575n);
    expect(config.groups.get('ROUTER_DC')?.localAs).toBe(265_185n);
    expect(config.groups.get('ROUTER_DC')?.peerAs).toBe(23_106n);
    expect(config.groups.get('ATC')?.localAs).toBe(265_185n);
    expect(config.neighbors.get('10.141.1.81')).toMatchObject({
      group: 'ATC',
      localAs: 265_185n,
    });
    // O mesmo MX usa local-as diferentes por grupo: 265185 nos grupos acima e
    // o AS global 52575 onde não há local-as explícito.
    expect(config.neighbors.get('167.250.0.130')).toMatchObject({
      group: 'NETFLIX',
      localAs: null,
    });
  });

  it('reads group and neighbor descriptions', () => {
    const config = parseJunosBgpConfig(CONFIG_19_2);

    expect(config.groups.get('NETFLIX')?.description).toBe('NETFLIX IX');
    expect(config.neighbors.get('10.147.50.9')?.description).toBe('ROUTER DC');
  });

  it('accepts 32-bit ASNs', () => {
    const config = parseJunosBgpConfig(`set protocols bgp group BIG local-as 4200000000
set protocols bgp group BIG peer-as 4294967294
`);

    expect(config.groups.get('BIG')).toMatchObject({
      localAs: 4_200_000_000n,
      peerAs: 4_294_967_294n,
    });
  });
});

describe('parseJunosRouteLookup', () => {
  it('prefers the global inet.0 table over VRF sections', () => {
    const lookup = parseJunosRouteLookup(ROUTE_IPV4, 'IPV4');

    expect(lookup).toEqual({
      routeFound: true,
      unresolvedRoute: false,
      interfaceNames: ['ae0.2800'],
    });
  });

  it('reads the IPv6 egress from inet6.0', () => {
    expect(parseJunosRouteLookup(ROUTE_IPV6, 'IPV6')).toEqual({
      routeFound: true,
      unresolvedRoute: false,
      interfaceNames: ['ae0.2810'],
    });
  });

  it('reports a missing route instead of a guessed interface', () => {
    expect(
      parseJunosRouteLookup('inet.0: 3 destinations, 3 routes (3 active, 0 holddown, 0 hidden)\n', 'IPV4'),
    ).toEqual({ routeFound: false, unresolvedRoute: false, interfaceNames: [] });
  });

  it('falls back to a non-global table only when the global one has no route', () => {
    const vrfOnly = `inet.0: 3 destinations, 3 routes (3 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

CGNAT-ISP.inet.0: 69 destinations, 69 routes (69 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

167.250.0.64/27    *[Direct/0] 23w1d 18:44:54
                    >  via ae0.2810
`;

    expect(parseJunosRouteLookup(vrfOnly, 'IPV4').interfaceNames).toEqual(['ae0.2810']);
  });
});

describe('parseJunosAdvertisedRoutes', () => {
  it('parses the real advertised-routes output keeping Self, AS-SET and origin', () => {
    const parsed = parseJunosAdvertisedRoutes(ADVERTISED, { localAs: 265_185n });

    expect(parsed.routes.map((route) => route.prefix)).toEqual([
      '167.250.0.0/22',
      '168.196.16.0/22',
      '168.196.19.0/24',
      '177.86.184.0/21',
      '200.219.139.0/24',
    ]);
    expect(parsed.routes[0]).toMatchObject({
      nextHop: 'Self',
      asPath: ['265185', '265185', '265185', '[265185]'],
      origin: 'i',
      // 3 ocorrências do AS local = 2 prepends além do anúncio original.
      prependLocal: 2,
    });
    // O AS entre colchetes é um AS-SET e não pode virar um ASN solto do path.
    expect(parsed.routes[3]?.asPath).toEqual(['265185', '265185', '[265185]', '52575']);
    expect(parsed.routes[3]?.prependLocal).toBe(1);
    expect(parsed.warnings).toEqual([]);
  });

  it('only fills MED/localPref when the device prints them', () => {
    const parsed = parseJunosAdvertisedRoutes(ADVERTISED, { localAs: 265_185n });
    const first = parsed.routes[0];
    const last = parsed.routes[parsed.routes.length - 1];

    expect(first?.med).toBeNull();
    expect(first?.localPreference).toBeNull();
    expect(last).toMatchObject({
      nextHop: '10.141.1.81',
      med: 100,
      localPreference: 200,
      asPath: ['65001', '6939'],
      origin: 'e',
      prependLocal: 0,
    });
  });

  it('returns an empty list when the peer receives no advertisement', () => {
    const parsed = parseJunosAdvertisedRoutes(
      `inet.0: 1114132 destinations, 4582007 routes (1114132 active, 0 holddown, 1 hidden)
Prefix                  Nexthop              MED     Lclpref    AS path
`,
      { localAs: 265_185n },
    );

    expect(parsed.routes).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('Junos command builders and read-only allowlist', () => {
  it('builds the route lookup without exact and keeps IPv6 intact', () => {
    expect(buildJunosRouteCommand('167.250.0.94')).toBe('show route 167.250.0.94 | no-more');
    expect(buildJunosRouteCommand('2804:2bf8:dddd:2::4')).toBe(
      'show route 2804:2bf8:dddd:2::4 | no-more',
    );
    expect(buildJunosRouteCommand('167.250.0.94')).not.toMatch(/exact/);
  });

  it('builds the advertised-routes command for IPv4 and IPv6', () => {
    expect(buildJunosAdvertisedRoutesCommand('10.141.1.81')).toBe(
      'show route advertising-protocol bgp 10.141.1.81 | no-more',
    );
    expect(buildJunosAdvertisedRoutesCommand('2001:1291:1602:1::a')).toBe(
      'show route advertising-protocol bgp 2001:1291:1602:1::a | no-more',
    );
  });

  it('rejects a peer address that is not a canonical IP', () => {
    expect(() => buildJunosRouteCommand('10.0.0.1 | match foo')).toThrow(JuniperBgpConfigError);
    expect(() => buildJunosAdvertisedRoutesCommand('neighbor')).toThrow(JuniperBgpConfigError);
  });

  it('allows only read-only Junos commands', () => {
    for (const command of [
      'show bgp summary | no-more',
      'show configuration protocols bgp | display set | no-more',
      'show configuration routing-options | display set | no-more',
      'show route 10.141.1.81 | no-more',
      'show route advertising-protocol bgp 10.141.1.81 | no-more',
      'show bgp neighbor 10.141.1.81 | no-more',
    ]) {
      expect(() => assertJunosReadOnly(command)).not.toThrow();
    }

    for (const command of [
      'configure',
      'set protocols bgp group X local-as 1',
      'commit',
      'request system reboot',
      'show route advertising-protocol bgp 10.141.1.81 | match up',
      'clear bgp neighbor 10.141.1.81',
      'edit protocols bgp',
      'show configuration | display set | save /tmp/x',
    ]) {
      expect(() => assertJunosReadOnly(command)).toThrow(JuniperBgpConfigError);
    }
  });
});
