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

/**
 * Captura REAL do equipamento em produção (anonimizada), no layout TABULAR do
 * VRP atual, colada sem alterar espaços ou colunas.
 *
 * A CLI reporta 35 rotas; o trecho fornecido traz as 12 primeiras linhas, então
 * a contagem de rotas é validada contra o trecho e o total, contra a CLI.
 */
const ADVERTISED_TABULAR_REAL = `
BGP Local router ID is 45.163.144.1
Status codes: * - valid, > - best, d - damped, x - best external, a - add path,
h - history,  i - internal, s - suppressed, S - Stale
Origin : i - IGP, e - EGP, ? - incomplete
RPKI validation codes: V - valid, I - invalid, N - not-found

Total Number of Routes: 35
Network            NextHop                       MED        LocPrf    PrefVal Path/Ogn

*>     45.5.248.0/23      200.194.223.86                                       0      268568 271034i
*>     45.5.248.0/24      200.194.223.86                                       0      268568 271034 271034 271034 271034i
*>     45.5.249.0/24      200.194.223.86                                       0      268568 271034 271034 271034 271034i
*>     45.5.251.0/24      200.194.223.86                                       0      268568 271034i
*>i    45.163.144.0/22    200.194.223.86                                       0      268568 268568 268568i
*>     45.164.184.0/23    200.194.223.86                                       0      268568 268633 268633i
*>     45.168.200.0/22    200.194.223.86                                       0      268568 268144i
*>     45.171.176.0/22    200.194.223.86                                       0      268568 268633 268725 268725 268725 268725 268725 268725i
*>     45.175.51.0/24     200.194.223.86                                       0      268568 268568 268568 268568 268568 268568 268884i
*>     45.225.55.0/24     200.194.223.86                                       0      268568 262957 266942?
*>     168.195.24.0/22    200.194.223.86                                       0      268568 265424 265424 265424 265424 265424 265424 265424 265424?
*>     200.192.151.0/24   200.194.223.86                                       0      268568 28572 28572i
`;

describe('parseHuaweiAdvertisedRoutes (VRP tabular real)', () => {
  const parsed = parseHuaweiAdvertisedRoutes(ADVERTISED_TABULAR_REAL, {
    localAs: LOCAL_AS,
    addressFamily: 'IPV4',
  });
  const byPrefix = new Map(parsed.routes.map((route) => [route.prefix, route]));

  it('reads the total reported by the CLI and parses every row of the excerpt', () => {
    expect(parsed.reportedTotal).toBe(35);
    expect(parsed.routes).toHaveLength(12);
    expect(parsed.routes.map((route) => route.prefix)).toEqual([
      '45.5.248.0/23',
      '45.5.248.0/24',
      '45.5.249.0/24',
      '45.5.251.0/24',
      '45.163.144.0/22',
      '45.164.184.0/23',
      '45.168.200.0/22',
      '45.171.176.0/22',
      '45.175.51.0/24',
      '45.225.55.0/24',
      '168.195.24.0/22',
      '200.192.151.0/24',
    ]);
  });

  it('ignores status/header lines, so only the reported difference is warned about', () => {
    expect(parsed.warnings).toEqual([
      'A CLI reportou 35 rota(s) e 12 foram interpretadas; linhas ambíguas foram ignoradas.',
    ]);
  });

  it('parses the local prepend of the real rows', () => {
    expect(byPrefix.get('45.163.144.0/22')?.prependLocal).toBe(2);
    expect(byPrefix.get('45.175.51.0/24')?.prependLocal).toBe(5);
    expect(byPrefix.get('45.5.248.0/24')?.prependLocal).toBe(0);
    expect(byPrefix.get('45.5.248.0/23')?.prependLocal).toBe(0);
    // Repetição de terceiro (265424) não conta como prepend local.
    expect(byPrefix.get('168.195.24.0/22')?.prependLocal).toBe(0);
    expect(byPrefix.get('45.171.176.0/22')?.prependLocal).toBe(0);
  });

  it('keeps the AS-PATH in order and takes the origin from the final character', () => {
    expect(byPrefix.get('45.163.144.0/22')).toMatchObject({
      asPath: ['268568', '268568', '268568'],
      origin: 'i',
    });
    expect(byPrefix.get('45.5.248.0/23')).toMatchObject({
      asPath: ['268568', '271034'],
      origin: 'i',
    });
    expect(byPrefix.get('45.225.55.0/24')).toMatchObject({
      asPath: ['268568', '262957', '266942'],
      origin: '?',
    });
    expect(byPrefix.get('168.195.24.0/22')?.origin).toBe('?');
    expect(byPrefix.get('200.192.151.0/24')).toMatchObject({
      asPath: ['268568', '28572', '28572'],
      origin: 'i',
    });
  });

  it('never takes the "i" of the "*>i" status as the origin', () => {
    const withStatusI = byPrefix.get('45.163.144.0/22');
    expect(withStatusI?.origin).toBe('i');
    // O prefixo continua íntegro e o AS-PATH não ganhou nenhum símbolo de status.
    expect(withStatusI?.prefix).toBe('45.163.144.0/22');
    expect(withStatusI?.asPath).toEqual(['268568', '268568', '268568']);
    expect(parsed.routes.some((route) => route.prefix.includes('*'))).toBe(false);
  });

  it('leaves blank MED/LocPrf as null and reads PrefVal 0 from every row', () => {
    for (const route of parsed.routes) {
      expect(route.med).toBeNull();
      expect(route.localPreference).toBeNull();
      expect(route.preferredValue).toBe(0);
      expect(route.nextHop).toBe('200.194.223.86');
    }
  });

  it('still parses the same rows when the header line is not captured', () => {
    const rowsOnly = ADVERTISED_TABULAR_REAL.split('\n')
      .filter((line) => line.startsWith('*>'))
      .join('\n');
    const withoutHeader = parseHuaweiAdvertisedRoutes(rowsOnly, {
      localAs: LOCAL_AS,
      addressFamily: 'IPV4',
    });

    expect(withoutHeader.reportedTotal).toBeNull();
    expect(withoutHeader.routes).toHaveLength(12);
    expect(withoutHeader.routes.find((route) => route.prefix === '45.163.144.0/22')).toMatchObject({
      med: null,
      localPreference: null,
      preferredValue: 0,
      asPath: ['268568', '268568', '268568'],
      origin: 'i',
      prependLocal: 2,
    });
    expect(withoutHeader.routes.find((route) => route.prefix === '45.175.51.0/24')?.prependLocal).toBe(5);
  });

  it('reads MED and LocPrf when the columns are filled', () => {
    // Mesmas colunas do cabeçalho real: Network 0, NextHop 19, MED 49,
    // LocPrf 60, PrefVal 70, Path/Ogn 78 — deslocadas em 7 pelo campo de status.
    const put = (cells: string[], start: number, value: string): void => {
      for (let index = 0; index < value.length; index += 1) cells[start + index] = value[index] ?? ' ';
    };
    const row = (prefix: string, med: string, locPrf: string, prefVal: string, path: string): string => {
      const cells = new Array<string>(85).fill(' ');
      put(cells, 0, '*>');
      put(cells, 7, prefix);
      put(cells, 26, '200.194.223.86');
      // Valores alinhados à direita dentro de cada coluna.
      if (med) put(cells, 67 - med.length, med);
      if (locPrf) put(cells, 77 - locPrf.length, locPrf);
      if (prefVal) put(cells, 85 - prefVal.length, prefVal);
      put(cells, 85, path);
      return cells.join('');
    };
    const output = [
      'Total Number of Routes: 2',
      'Network            NextHop                       MED        LocPrf    PrefVal Path/Ogn',
      '',
      row('45.163.144.0/22', '100', '250', '0', '268568 268568 271034i'),
      row('45.5.248.0/23', '1', '', '0', '268568 271034i'),
    ].join('\n');

    const filled = parseHuaweiAdvertisedRoutes(output, {
      localAs: LOCAL_AS,
      addressFamily: 'IPV4',
    });

    expect(filled.warnings).toEqual([]);
    expect(filled.routes[0]).toMatchObject({
      med: 100,
      localPreference: 250,
      preferredValue: 0,
      origin: 'i',
      prependLocal: 1,
    });
    // MED preenchido com LocPrf em branco: cada coluna mantém o seu valor.
    expect(filled.routes[1]).toMatchObject({
      med: 1,
      localPreference: null,
      preferredValue: 0,
      prependLocal: 0,
    });
  });
});
