import { describe, expect, it } from 'vitest';
import { parseHuaweiAdvertisedRoutes } from './huawei-bgp-advertised-routes-parser';

const LOCAL_AS = '268568';

/**
 * Anonymized capture of `display bgp routing-table peer <PEER>
 * advertised-routes` on the NE8-IXBR context, in the canonical VRP block
 * layout. Prefixes/ASNs come from the Magic prototype material; the layout is
 * the real CLI layout (headers, attributes, `---- More ----` paging marker).
 */
const ADVERTISED_IPV4 = `
<NE8IXBR>
display bgp routing-table peer 200.194.223.86 advertised-routes
BGP Local router ID : 45.163.144.1
Local AS number : 268568
 Total routes of Route Distinguisher 0:0 : 9

 BGP routing table entry information of 45.5.248.0/23:
 From: 200.194.223.86 (10.200.201.18)
 Route Duration: 0000h02m21s
 Direct Out-interface: 100GE1/0/3
 Original nexthop: 200.194.223.86
 Qos information : 0x0
 AS-path 268568 271034, origin igp, MED 1, pref-val 0, valid, external, pre 255

 BGP routing table entry information of 45.5.248.0/24:
 From: 200.194.223.86 (10.200.201.18)
 Direct Out-interface: 100GE1/0/3
 Original nexthop: 200.194.223.86
 AS-path 268568 271034 271034 271034 271034, origin igp, pref-val 0, valid, external

 BGP routing table entry information of 45.163.144.0/22:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 268568 268568, origin igp, pref-val 0, valid, external

 BGP routing table entry information of 45.163.145.0/24:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 268568, origin igp, MED 100, localpref 100, pref-val 0, valid, external

 BGP routing table entry information of 45.163.146.0/24:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 271034, origin egp, pref-val 0, valid, external

 ---- More ----
 BGP routing table entry information of 45.163.147.0/24:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 268633 268725 268884, origin incomplete, pref-val 0, valid, external

 BGP routing table entry information of 45.164.184.0/23:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 268633 268633, origin igp, MED 1, pref-val 0, valid, external

 BGP routing table entry information of 45.171.176.0/22:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 268633 268725 268725 268725, origin igp, pref-val 0, valid, external

 BGP routing table entry information of 45.175.51.0/24:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 268568 268568 268568 268568 268568 268884, origin igp, MED 1, pref-val 0
`;

describe('parseHuaweiAdvertisedRoutes (IPv4)', () => {
  const parsed = parseHuaweiAdvertisedRoutes(ADVERTISED_IPV4, {
    localAs: LOCAL_AS,
    addressFamily: 'IPV4',
  });

  it('parses every announced prefix of the capture', () => {
    expect(parsed.routes.map((route) => route.prefix)).toEqual([
      '45.5.248.0/23',
      '45.5.248.0/24',
      '45.163.144.0/22',
      '45.163.145.0/24',
      '45.163.146.0/24',
      '45.163.147.0/24',
      '45.164.184.0/23',
      '45.171.176.0/22',
      '45.175.51.0/24',
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it('computes prepend local exactly like the rule requires', () => {
    expect(parsed.routes.map((route) => route.prependLocal)).toEqual([0, 0, 2, 1, 0, 0, 0, 0, 5]);
  });

  it('keeps the AS-PATH in the printed order', () => {
    expect(parsed.routes[8]?.asPath).toEqual([
      '268568',
      '268568',
      '268568',
      '268568',
      '268568',
      '268568',
      '268884',
    ]);
  });

  it('maps origin igp/egp/incomplete to i/e/?', () => {
    expect(parsed.routes.map((route) => route.origin)).toEqual([
      'i',
      'i',
      'i',
      'i',
      'e',
      '?',
      'i',
      'i',
      'i',
    ]);
  });

  it('reads next-hop, MED and pref-val from the attributes line', () => {
    expect(parsed.routes[0]).toMatchObject({
      nextHop: '200.194.223.86',
      med: 1,
      preferredValue: 0,
    });
    expect(parsed.routes[3]).toMatchObject({ med: 100, localPreference: 100, preferredValue: 0 });
  });

  it('leaves MED/LocPref/PrefVal null when the device does not print them', () => {
    expect(parsed.routes[1]).toMatchObject({
      med: null,
      localPreference: null,
      preferredValue: 0,
    });
    expect(parsed.routes[0]?.localPreference).toBeNull();
  });

  it('reports the total printed by the CLI', () => {
    expect(parsed.reportedTotal).toBe(9);
  });
});

describe('parseHuaweiAdvertisedRoutes (tolerance)', () => {
  it('parses an IPv6 block', () => {
    const output = ` BGP routing table entry information of 2001:DB8::/32:
 From: 2001:db8:1::1 (10.200.201.18)
 Original nexthop: 2001:db8:1::1
 AS-path 268568 268568 271034, origin igp, MED 10, pref-val 0, valid, external`;
    const parsed = parseHuaweiAdvertisedRoutes(output, {
      localAs: LOCAL_AS,
      addressFamily: 'IPV6',
    });
    expect(parsed.routes).toEqual([
      {
        prefix: '2001:db8::/32',
        nextHop: '2001:db8:1::1',
        med: 10,
        localPreference: null,
        preferredValue: 0,
        asPath: ['268568', '268568', '271034'],
        origin: 'i',
        prependLocal: 1,
      },
    ]);
  });

  it('joins an attributes line wrapped by the terminal', () => {
    const output = ` BGP routing table entry information of 45.163.145.0/24:
 Original nexthop: 200.194.223.86
 AS-path 268568 268568,
  origin igp, MED 100,
  pref-val 0, valid, external`;
    const parsed = parseHuaweiAdvertisedRoutes(output, {
      localAs: LOCAL_AS,
      addressFamily: 'IPV4',
    });
    expect(parsed.routes[0]).toMatchObject({
      asPath: ['268568', '268568'],
      origin: 'i',
      med: 100,
      preferredValue: 0,
      prependLocal: 1,
    });
  });

  it('accepts different compatible header wording and missing columns', () => {
    const output = `BGP routing-table entry information of 45.163.146.0/24
 AS-path 268568 271034, origin i, pref-val 0`;
    const parsed = parseHuaweiAdvertisedRoutes(output, { localAs: LOCAL_AS });
    expect(parsed.routes[0]).toMatchObject({
      prefix: '45.163.146.0/24',
      nextHop: null,
      med: null,
      origin: 'i',
      asPath: ['268568', '271034'],
    });
  });

  it('keeps an AS_SET member as a single AS-PATH entry', () => {
    const output = ` BGP routing table entry information of 45.5.248.0/23:
 Original nexthop: 200.194.223.86
 AS-path {268568,271034} 268633, origin igp, pref-val 0`;
    const parsed = parseHuaweiAdvertisedRoutes(output, { localAs: LOCAL_AS });
    expect(parsed.routes[0]?.asPath).toEqual(['{268568,271034}', '268633']);
    expect(parsed.routes[0]?.prependLocal).toBe(0);
  });

  it('warns and returns no routes for an empty output', () => {
    const parsed = parseHuaweiAdvertisedRoutes('   \n\n', { localAs: LOCAL_AS });
    expect(parsed.routes).toEqual([]);
    expect(parsed.reportedTotal).toBeNull();
    expect(parsed.warnings).toEqual(['A consulta não retornou saída do equipamento.']);
  });

  it('warns instead of inventing rows for an unrecognized output', () => {
    const parsed = parseHuaweiAdvertisedRoutes('Error: Unrecognized command found at ^ position.', {
      localAs: LOCAL_AS,
    });
    expect(parsed.routes).toEqual([]);
    expect(parsed.warnings[0]).toMatch(/Formato da saída não reconhecido/);
  });

  it('drops a route header from another family and warns', () => {
    const output = ` BGP routing table entry information of 2001:db8::/32:
 AS-path 268568 271034, origin igp`;
    const parsed = parseHuaweiAdvertisedRoutes(output, {
      localAs: LOCAL_AS,
      addressFamily: 'IPV4',
    });
    expect(parsed.routes).toEqual([]);
    expect(parsed.warnings[0]).toMatch(/prefixo inválido ou de outra família/);
  });

  it('warns when a route has no AS-PATH line but keeps the real prefix', () => {
    const output = ` BGP routing table entry information of 45.163.147.0/24:
 Original nexthop: 200.194.223.86
 Local AS number : 268568`;
    const parsed = parseHuaweiAdvertisedRoutes(output, { localAs: LOCAL_AS });
    expect(parsed.routes).toEqual([
      {
        prefix: '45.163.147.0/24',
        nextHop: '200.194.223.86',
        med: null,
        localPreference: null,
        preferredValue: null,
        asPath: [],
        origin: null,
        prependLocal: 0,
      },
    ]);
    expect(parsed.warnings).toEqual([
      'Rota 45.163.147.0/24 sem linha de AS-PATH; atributos ficaram nulos.',
    ]);
  });

  it('warns when the CLI total disagrees with the parsed rows', () => {
    const output = ` Total routes of this peer : 3
 BGP routing table entry information of 45.163.144.0/22:
 AS-path 268568 268568 268568, origin igp`;
    const parsed = parseHuaweiAdvertisedRoutes(output, { localAs: LOCAL_AS });
    expect(parsed.reportedTotal).toBe(3);
    expect(parsed.warnings).toContain(
      'A CLI reportou 3 rota(s) e 1 foram interpretadas; linhas ambíguas foram ignoradas.',
    );
  });

  it('omits an ambiguous Route Distinguisher total instead of picking one', () => {
    const output = ` Total routes of Route Distinguisher 0:0 : 4
 Total routes of Route Distinguisher 1:1 : 7
 BGP routing table entry information of 45.163.144.0/22:
 AS-path 268568 268568 268568, origin igp`;
    const parsed = parseHuaweiAdvertisedRoutes(output, { localAs: LOCAL_AS });
    expect(parsed.reportedTotal).toBeNull();
    expect(parsed.warnings).toContain(
      'A CLI reportou totais diferentes por Route Distinguisher; o total reportado foi omitido.',
    );
  });

  it('warns about an unknown origin instead of guessing', () => {
    const output = ` BGP routing table entry information of 45.163.144.0/22:
 AS-path 268568 268568 268568, origin confed, pref-val 0`;
    const parsed = parseHuaweiAdvertisedRoutes(output, { localAs: LOCAL_AS });
    expect(parsed.routes[0]?.origin).toBeNull();
    expect(parsed.warnings).toContain('Origem não reconhecida em 45.163.144.0/22: confed');
  });

  it('does not compute prepend when the local ASN is unknown', () => {
    const parsed = parseHuaweiAdvertisedRoutes(ADVERTISED_IPV4, { localAs: null });
    expect(parsed.routes.every((route) => route.prependLocal === 0)).toBe(true);
  });
});
