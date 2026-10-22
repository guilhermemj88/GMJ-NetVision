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

/**
 * Output REAL e COMPLETO do `show bgp summary | no-more` de VIANET-OUROPRETO
 * (Junos 19.2R1.8, captura de 2026-10-22, read-only). Apenas o prompt foi
 * sanitizado (`operator@VIANET-OUROPRETO>`). 24 peers = 12 IPv4 + 12 IPv6.
 */
const SUMMARY_19_2 = `Last login: Wed Oct 22 12:07:41 2026 from 167.250.0.1

--- JUNOS 19.2R1.8 Kernel 64-bit  JNPR-11.0-20190517.f0321c3_buil
operator@VIANET-OUROPRETO> show bgp summary | no-more
Threading mode: BGP I/O
Groups: 17 Peers: 24 Down peers: 0
Table          Tot Paths  Act Paths Suppressed    History Damp State    Pending
inet6.0
                 1199907     261471          0          0          0          0
inet.0
                 4575898    1110734          0          0          0          0
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.141.1.81           23106   25492303      99647       0      27 4w4d 10:27:22 Establ
  inet.0: 493460/1104280/1104280/0
100.127.0.60         269096   41778194     267909       0      11 12w3d 4:58:17 Establ
  inet.0: 329848/1100712/1100712/0
167.250.0.94          11344      20997      22396       0      82 1w0d 6:56:43 Establ
  inet.0: 0/0/0/0
167.250.0.130         40027      80012      74680       0      17 3w3d 7:21:55 Establ
  inet.0: 0/0/0/0
167.250.0.238         52575    7789496   19997162       0      14 4w0d 16:51:26 Establ
  inet.0: 3763/825521/825521/0
167.250.0.242        265185     159727     149027       0       5 6w6d 12:16:33 Establ
  inet.0: 0/18/18/0
187.16.216.252        20121       5801       5430       0      99 1d 18:24:13 Establ
  inet.0: 0/0/0/0
187.16.216.253        26162     649023       5429       0      72 1d 18:24:02 Establ
  inet.0: 163548/213069/213069/0
187.16.216.254        26162     345648       2243       0      67    17:29:23 Establ
  inet.0: 6033/213014/213014/0
187.72.100.246        16735   24534482     237597       0      17 11w0d 8:05:51 Establ
  inet.0: 110172/1071038/1071037/0
200.219.139.253       26162     874602      69807       0       5 3w1d 17:20:30 Establ
  inet.0: 2458/24123/24123/0
200.219.139.254       26162     853897      69806       0      13 3w1d 17:20:26 Establ
  inet.0: 1452/24123/24123/0
2001:1291:1602:1::a       16735  251913865     237577       0      15 11w0d 8:05:55 Establ
  inet6.0: 19874/245255/245255/0
2001:12f8::252        20121       5812       5427       0      23 1d 18:23:46 Establ
  inet6.0: 0/0/0/0
2001:12f8::253        26162     794536       5427       0      13 1d 18:23:32 Establ
  inet6.0: 73405/88917/88917/0
2001:12f8::254        26162     361790       2278       0      15    17:46:11 Establ
  inet6.0: 3335/88931/88931/0
2001:12f8:0:3::253       26162    8382650      69805       0       4 3w1d 17:20:35 Establ
  inet6.0: 1086/6106/6106/0
2001:12f8:0:3::254       26162    8413885      69805       0      12 3w1d 17:20:36 Establ
  inet6.0: 923/6087/6087/0
2804:2bf8:0:2::2       52575   45474387   58474318       0       8 4w4d 10:27:18 Establ
  inet6.0: 0/253951/253951/0
2804:2bf8:2000::1      265185     159671     149028       0       5 6w6d 12:16:33 Establ
  inet6.0: 2/3/3/0
2804:2bf8:dddd:1::fffe       11344      20997      22392       0      81 1w0d 6:56:43 Establ
  inet6.0: 0/0/0/0
2804:2bf8:dddd:2::4       40027      79945      74673       0      17 3w3d 7:21:55 Establ
  inet6.0: 0/0/0/0
2804:5f64:1000::305      269096   53895745     267896       0      14 12w3d 4:58:18 Establ
  inet6.0: 80407/256189/256189/0
fd00:0:1::151         23106   26646387      99665       0      30 4w4d 10:37:13 Establ
  inet6.0: 82439/254468/254468/0
`;

/**
 * Recorte do MESMO comando, informado pelo operador em 2026-10-22, com os
 * valores usados nas assertions de contrato (received × accepted).
 */
const SUMMARY_OPERATOR_SNAPSHOT = `Groups: 17 Peers: 24 Down peers: 0
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.141.1.81           23106   25109521      97966       0      27 4w4d 10:05:55 Establ
  inet.0: 493399/1104194/1104194/0
100.127.0.60         269096   41561403     266227       0      11 12w3d 4:36:50 Establ
  inet.0: 330724/1100593/1100593/0
167.250.0.238         52575    7659943   19658489       0      14 4w0d 3:42:50 Establ
  inet.0: 3829/825595/825595/0
187.16.216.253        26162     612109       3748       0      72 1w0d 6:35:16 Establ
  inet.0: 166187/213023/213023/0
187.72.100.246        16735   24391034     235915       0      17 11w0d 7:44:24 Establ
  inet.0: 110237/1071010/1071009/0
2001:1291:1602:1::a       16735  250209872     235895       0      15 11w0d 7:44:28 Establ
  inet6.0: 18481/245228/245228/0
2001:12f8::253        26162     629995       3746       0      13 1d 18:02:46 Establ
  inet6.0: 74111/88936/88936/0
2804:2bf8:0:2::2       52575   44802887   57570484       0       8 17:07:56 Establ
  inet6.0: 0/253861/253861/0
fd00:0:1::151         23106   26297862      97984       0      30 4w4d 10:06:37 Establ
  inet6.0: 82437/254485/254485/0
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
  it('reads all 24 peers (12 IPv4 + 12 IPv6) from a single 19.2 summary', () => {
    const summary = parseJunosBgpSummary(SUMMARY_19_2);

    expect(summary.groups).toBe(17);
    expect(summary.declaredPeers).toBe(24);
    expect(summary.declaredDownPeers).toBe(0);
    expect(summary.warnings).toEqual([]);
    expect(summary.peers).toHaveLength(24);
    expect(summary.peers.filter((peer) => peer.addressFamily === 'IPV4')).toHaveLength(12);
    expect(summary.peers.filter((peer) => peer.addressFamily === 'IPV6')).toHaveLength(12);
    // A família vem da linha `inet.0:`/`inet6.0:`, não do formato do endereço.
    expect(summary.peers.every((peer) => peer.state === 'ESTABLISHED')).toBe(true);
    expect(
      summary.peers.map((peer) => [peer.peerAddress, peer.addressFamily]).slice(0, 4),
    ).toEqual([
      ['10.141.1.81', 'IPV4'],
      ['100.127.0.60', 'IPV4'],
      ['167.250.0.94', 'IPV4'],
      ['167.250.0.130', 'IPV4'],
    ]);
    expect(
      summary.peers.map((peer) => [peer.peerAddress, peer.addressFamily]).slice(-2),
    ).toEqual([
      ['2804:5f64:1000::305', 'IPV6'],
      ['fd00:0:1::151', 'IPV6'],
    ]);
  });

  it('parses an IPv6 peer line without relying on column offsets', () => {
    // No IPv6 a coluna do AS desloca; o parser ancora no IP e lê por significado.
    const summary = parseJunosBgpSummary(`2001:1291:1602:1::a       16735  251913865     237577       0      15 11w0d 8:05:55 Establ
  inet6.0: 19874/245255/245255/0
`);

    expect(summary.peers).toHaveLength(1);
    expect(summary.peers[0]).toMatchObject({
      peerAddress: '2001:1291:1602:1::a',
      addressFamily: 'IPV6',
      remoteAs: 16_735n,
      state: 'ESTABLISHED',
      receivedPrefixes: 245_255n,
      acceptedPrefixes: 245_255,
    });
    expect(summary.peers[0]?.sessionUptimeSeconds).toBe(
      11 * 604_800 + 0 * 86_400 + 8 * 3_600 + 5 * 60 + 55,
    );
  });

  it('uses the SECOND value of Active/Received/Accepted/Damped as receivedPrefixes', () => {
    const peers = parseJunosBgpSummary(SUMMARY_19_2).peers;
    const byAddress = new Map(peers.map((peer) => [peer.peerAddress, peer]));

    // inet.0: 493460/1104280/1104280/0 → recebidos = 1104280, nunca 493460.
    expect(byAddress.get('10.141.1.81')?.activePrefixes).toBe(493_460);
    expect(byAddress.get('10.141.1.81')?.receivedPrefixes).toBe(1_104_280n);
    expect(byAddress.get('10.141.1.81')?.acceptedPrefixes).toBe(1_104_280);
    // inet6.0: 19874/245255/245255/0 → recebidos = 245255.
    expect(byAddress.get('2001:1291:1602:1::a')?.activePrefixes).toBe(19_874);
    expect(byAddress.get('2001:1291:1602:1::a')?.receivedPrefixes).toBe(245_255n);
    // um peer estabelecido pode legitimamente receber 0 (não é ausência de dado).
    expect(byAddress.get('2804:2bf8:dddd:1::fffe')?.receivedPrefixes).toBe(0n);
    // Received e Accepted são campos DIFERENTES no equipamento real.
    expect(byAddress.get('187.72.100.246')).toMatchObject({
      receivedPrefixes: 1_071_038n,
      acceptedPrefixes: 1_071_037,
      dampedPrefixes: 0,
    });
  });

  it('captures the remote AS from the AS column and never treats it as localAs', () => {
    const peers = parseJunosBgpSummary(SUMMARY_19_2).peers;
    const byAddress = new Map(peers.map((peer) => [peer.peerAddress, peer]));

    expect(byAddress.get('10.141.1.81')?.remoteAs).toBe(23_106n);
    expect(byAddress.get('167.250.0.242')?.remoteAs).toBe(265_185n);
    expect(byAddress.get('2001:1291:1602:1::a')?.remoteAs).toBe(16_735n);
    expect(byAddress.get('fd00:0:1::151')?.remoteAs).toBe(23_106n);
    // localAs não existe no summary: é resolvido pela MIB/config, nunca aqui.
    expect(Object.keys(byAddress.get('10.141.1.81')!)).not.toContain('localAs');
  });

  it('matches the operator snapshot values for the eight asserted peers', () => {
    const summary = parseJunosBgpSummary(SUMMARY_OPERATOR_SNAPSHOT);
    const byAddress = new Map(summary.peers.map((peer) => [peer.peerAddress, peer]));

    expect(summary.declaredPeers).toBe(24);
    expect(summary.declaredDownPeers).toBe(0);
    expect(summary.warnings).toEqual([]);
    expect(byAddress.size).toBe(9);

    expect(byAddress.get('10.141.1.81')).toMatchObject({
      addressFamily: 'IPV4',
      remoteAs: 23_106n,
      state: 'ESTABLISHED',
      receivedPrefixes: 1_104_194n,
    });
    expect(byAddress.get('100.127.0.60')).toMatchObject({
      addressFamily: 'IPV4',
      remoteAs: 269_096n,
      receivedPrefixes: 1_100_593n,
    });
    expect(byAddress.get('167.250.0.238')).toMatchObject({
      addressFamily: 'IPV4',
      remoteAs: 52_575n,
      receivedPrefixes: 825_595n,
    });
    expect(byAddress.get('187.16.216.253')).toMatchObject({
      addressFamily: 'IPV4',
      remoteAs: 26_162n,
      receivedPrefixes: 213_023n,
    });
    expect(byAddress.get('2001:1291:1602:1::a')).toMatchObject({
      addressFamily: 'IPV6',
      remoteAs: 16_735n,
      receivedPrefixes: 245_228n,
    });
    expect(byAddress.get('2001:12f8::253')).toMatchObject({
      addressFamily: 'IPV6',
      remoteAs: 26_162n,
      receivedPrefixes: 88_936n,
    });
    expect(byAddress.get('2804:2bf8:0:2::2')).toMatchObject({
      addressFamily: 'IPV6',
      remoteAs: 52_575n,
      receivedPrefixes: 253_861n,
    });
    expect(byAddress.get('fd00:0:1::151')).toMatchObject({
      addressFamily: 'IPV6',
      remoteAs: 23_106n,
      receivedPrefixes: 254_485n,
    });
    // Received ≠ Accepted: `110237/1071010/1071009/0`.
    expect(byAddress.get('187.72.100.246')).toMatchObject({
      activePrefixes: 110_237,
      receivedPrefixes: 1_071_010n,
      acceptedPrefixes: 1_071_009,
      dampedPrefixes: 0,
    });
  });

  it('converts every uptime shape printed by the two MX', () => {
    const summary = parseJunosBgpSummary(SUMMARY_OPERATOR_SNAPSHOT);
    const byAddress = new Map(summary.peers.map((peer) => [peer.peerAddress, peer]));

    // 12w3d 4:36:50
    expect(byAddress.get('100.127.0.60')?.sessionUptimeSeconds).toBe(
      12 * 604_800 + 3 * 86_400 + 4 * 3_600 + 36 * 60 + 50,
    );
    // 4w4d 10:05:55
    expect(byAddress.get('10.141.1.81')?.sessionUptimeSeconds).toBe(
      4 * 604_800 + 4 * 86_400 + 10 * 3_600 + 5 * 60 + 55,
    );
    // 1w0d 6:35:16
    expect(byAddress.get('187.16.216.253')?.sessionUptimeSeconds).toBe(
      7 * 86_400 + 6 * 3_600 + 35 * 60 + 16,
    );
    // 1d 18:02:46
    expect(byAddress.get('2001:12f8::253')?.sessionUptimeSeconds).toBe(
      86_400 + 18 * 3_600 + 2 * 60 + 46,
    );
    // 17:07:56 (sem dias)
    expect(byAddress.get('2804:2bf8:0:2::2')?.sessionUptimeSeconds).toBe(
      17 * 3_600 + 7 * 60 + 56,
    );
    expect(summary.peers.every((peer) => peer.sessionUptimeSeconds !== null)).toBe(true);
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
    // Sem rota nenhuma e sem seção: mesma distinção preservada.
    expect(parseJunosRouteLookup('', 'IPV4')).toEqual({
      routeFound: false,
      unresolvedRoute: false,
      interfaceNames: [],
    });
  });

  it('keeps routeFound when the route exists without a usable interface', () => {
    const noVia = `inet.0: 1114132 destinations, 4582007 routes (1114132 active, 0 holddown, 1 hidden)
+ = Active Route, - = Last Active, * = Both

10.141.1.81/32     *[Direct/0] 1d 00:00:23
                    >  to 192.168.3.1
`;

    expect(parseJunosRouteLookup(noVia, 'IPV4')).toEqual({
      routeFound: true,
      unresolvedRoute: true,
      interfaceNames: [],
    });

    // Next hop de descarte: a rota existe, mas não há interface de saída.
    const discarded = `inet.0: 10 destinations, 10 routes (10 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

200.150.1.192/30   *[BGP/170] 1d 00:00:23, MED 0, localpref 100
                    >  to 10.0.0.1 via Discard
`;
    expect(parseJunosRouteLookup(discarded, 'IPV4')).toEqual({
      routeFound: true,
      unresolvedRoute: true,
      interfaceNames: [],
    });
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

  it('never turns the RIB table size into the advertised-routes total', () => {
    // Header real de `show route advertising-protocol bgp <PEER>`: milhões de
    // rotas na RIB, apenas 3 prefixos anunciados a este peer.
    const parsed = parseJunosAdvertisedRoutes(
      `inet.0: 1114132 destinations, 4582007 routes (1114132 active, 0 holddown, 1 hidden)
+ = Active Route, - = Last Active, * = Both

Prefix                  Nexthop              MED     Lclpref    AS path
167.250.0.0/22          Self                                    265185 265185 265185 [265185] I
168.196.16.0/22         Self                                    265185 265185 265185 [265185] I
177.86.184.0/21         Self                                    265185 265185 [265185] 52575 I
`,
      { localAs: 265_185n },
    );

    expect(parsed.routes).toHaveLength(3);
    // 4582007 é o tamanho da tabela inet.0, não o total anunciado ao peer.
    expect(parsed.reportedTotal).toBeNull();
    expect(parsed.warnings).toEqual([]);
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
