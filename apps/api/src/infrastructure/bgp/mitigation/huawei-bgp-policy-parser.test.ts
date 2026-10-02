import { describe, expect, it } from 'vitest';
import {
  allNodesOf,
  bgpPolicyKey,
  parseHuaweiRoutePolicyNodesLenient,
  nodesApplyingRouteTarget,
  parseHuaweiBgpPolicyConfiguration,
  parseHuaweiRoutePolicyNodes,
  permitNodesOf,
  resolvePeerInboundPolicy,
} from './huawei-bgp-policy-parser';

/**
 * Dump no formato REAL do VRP: o peer aparece no bloco global (`as-number`) e a
 * POLICY EFETIVA dentro de `ipv4-family unicast`.
 */
function bgpV4(...peerLines: string[]): string {
  return ['bgp 64500', ' ipv4-family unicast', ...peerLines.map((line) => ` ${line}`)].join('\n');
}

const BGP_CONFIG = [
  '#',
  'bgp 64500',
  ' peer 10.200.200.106 as-number 6939',
  ' peer 10.200.200.10 as-number 6939',
  ' peer 10.200.200.20 group PL-GRUPO-X',
  ' peer 10.200.200.30 group PL-GRUPO-X',
  ' ipv4-family unicast',
  '  peer 10.200.200.106 enable',
  '  peer 10.200.200.106 route-policy PL-HORIZONTES_IPv4-IN import',
  '  peer 10.200.200.106 route-policy PL-HORIZONTES_IPv4-OUT export',
  '  peer 10.200.200.10 route-policy PL-HORIZONTES_IPv4-IN import',
  '  peer 10.200.200.40 route-policy PL-SO-EXPORT export',
  '  peer PL-GRUPO-X route-policy PL-GRUPO-IN import',
  '  peer 10.200.200.20 group PL-GRUPO-X',
  '  peer 10.200.200.30 group PL-GRUPO-X',
  '  peer 10.200.200.30 route-policy PL-DIRETO-IN import',
  '#',
  'return',
].join('\n');

describe('parser da configuracao BGP (policy IN por peer, com address-family)', () => {
  const parsed = parseHuaweiBgpPolicyConfiguration(BGP_CONFIG);

  it('extrai a policy de import declarada no peer', () => {
    expect(resolvePeerInboundPolicy('10.200.200.106', 'IPV4', parsed)).toBe('PL-HORIZONTES_IPv4-IN');
    expect(resolvePeerInboundPolicy('10.200.200.10', 'IPV4', parsed)).toBe('PL-HORIZONTES_IPv4-IN');
  });

  it('nunca usa a policy de export como se fosse import', () => {
    expect(resolvePeerInboundPolicy('10.200.200.40', 'IPV4', parsed)).toBeNull();
    expect(parsed.directPeerPolicies.get(bgpPolicyKey('IPV4', '10.200.200.106'))).toBe(
      'PL-HORIZONTES_IPv4-IN',
    );
  });

  it('herda a policy do peer-group quando o peer nao tem policy propria', () => {
    expect(resolvePeerInboundPolicy('10.200.200.20', 'IPV4', parsed)).toBe('PL-GRUPO-IN');
  });

  it('a policy declarada no peer vence a do grupo', () => {
    expect(resolvePeerInboundPolicy('10.200.200.30', 'IPV4', parsed)).toBe('PL-DIRETO-IN');
  });

  it('peer fora da configuracao nao inventa policy', () => {
    expect(resolvePeerInboundPolicy('10.200.200.99', 'IPV4', parsed)).toBeNull();
  });
});

// Fixture do cenario real: node 11 e um node NORMAL do cliente (aplica a RT
// 268568:110), o node 1 e um node de MITIGACAO (aplica a RT 268568:660).
const RP_CONFIG = [
  '#',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
  ' if-match ip-prefix PREFIX-HORIZONTES-IPV4',
  ' apply local-preference 4000',
  ' apply extcommunity rt 268568:110 additive',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 1',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
  ' apply extcommunity rt 268568:110 additive',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-HORIZONTES_IPv4-IN deny node 5',
  'route-policy PL-VAZIA-IN permit node 9',
  ' if-match community-filter X',
  '#',
  'return',
].join('\n');

describe('parser de nodes de route-policy (generico, com as RTs de cada node)', () => {
  const nodes = parseHuaweiRoutePolicyNodes(RP_CONFIG);
  const horizons = nodes.get('PL-HORIZONTES_IPv4-IN') ?? [];

  it('devolve node, action e as route-targets aplicadas', () => {
    expect(horizons).toEqual([
      {
        node: 1,
        action: 'permit',
        ifMatchIpPrefix: [],
        routeTargets: ['268568:660'],
      },
      {
        node: 2,
        action: 'permit',
        ifMatchIpPrefix: [],
        routeTargets: ['268568:110', '268568:660'],
      },
      { node: 5, action: 'deny', ifMatchIpPrefix: [], routeTargets: [] },
      {
        node: 11,
        action: 'permit',
        ifMatchIpPrefix: ['PREFIX-HORIZONTES-IPV4'],
        routeTargets: ['268568:110'],
      },
    ]);
  });

  it('node 11 com RT normal 268568:110 NAO e node de mitigacao', () => {
    expect(nodesApplyingRouteTarget(horizons, '268568:660')).not.toContain(11);
  });

  it('node 1 com a RT de mitigacao 268568:660 E node de mitigacao', () => {
    expect(nodesApplyingRouteTarget(horizons, '268568:660')).toContain(1);
  });

  it('node com duas RTs incluindo a de mitigacao E node de mitigacao', () => {
    expect(nodesApplyingRouteTarget(horizons, '268568:660')).toContain(2);
  });

  it('node sem RT nenhuma NAO e node de mitigacao', () => {
    const semRt = nodes.get('PL-VAZIA-IN') ?? [];
    expect(semRt).toEqual([{ node: 9, action: 'permit', ifMatchIpPrefix: [], routeTargets: [] }]);
    expect(nodesApplyingRouteTarget(semRt, '268568:660')).toEqual([]);
  });

  it('a classificacao depende da RT do motor (outra RT nao conta)', () => {
    expect(nodesApplyingRouteTarget(horizons, '268568:110')).toEqual([2, 11]);
    expect(nodesApplyingRouteTarget(horizons, '9999:1')).toEqual([]);
  });

  it('separa permit, deny e todos os nodes existentes', () => {
    expect(permitNodesOf(horizons)).toEqual([1, 2, 11]);
    expect(allNodesOf(horizons)).toEqual([1, 2, 5, 11]);
  });

  it('nao inventa policy que nao existe na configuracao', () => {
    expect(nodes.has('PL-INEXISTENTE')).toBe(false);
  });
});

// ---- Fase 12b: read-back real do `display route-policy` (formato DISPLAY) ----

/** Saida REAL do F1A para `display route-policy PL-HORIZONTES_IPv4-IN`. */
const DISPLAY_READBACK = [
  'Info: The max number of VTY users is 21, the number of current VTY users online is 1.',
  '<BHE-VTA-F1A-BGP-01>screen-length 0 temporary',
  'Info: The configuration takes effect on the current user terminal interface only.',
  '<BHE-VTA-F1A-BGP-01>',
  '<BHE-VTA-F1A-BGP-01>display route-policy PL-HORIZONTES_IPv4-IN',
  'Route-policy: PL-HORIZONTES_IPv4-IN',
  '  permit : 11 (matched counts: 2)',
  '    Match clauses: ',
  '      if-match ip-prefix PREFIX-HORIZONTES-IPV4',
  '    Apply clauses: ',
  '      apply local-preference 4000',
  '      apply extcommunity rt 268568:140',
  '  deny : 50 (matched counts: 0)',
  '<BHE-VTA-F1A-BGP-01>',
  '<BHE-VTA-F1A-BGP-01>quit',
].join('\n');

describe('parser do display route-policy (read-back real)', () => {
  const nodes = parseHuaweiRoutePolicyNodesLenient(DISPLAY_READBACK);

  it('le a policy e os nodes 11 (permit) e 50 (deny)', () => {
    const horizons = nodes.get('PL-HORIZONTES_IPv4-IN') ?? [];
    expect(horizons.map((entry) => entry.node)).toEqual([11, 50]);
    expect(horizons.find((entry) => entry.node === 11)?.action).toBe('permit');
    expect(horizons.find((entry) => entry.node === 11)?.ifMatchIpPrefix).toEqual([
      'PREFIX-HORIZONTES-IPV4',
    ]);
    expect(horizons.find((entry) => entry.node === 11)?.routeTargets).toEqual(['268568:140']);
    expect(horizons.find((entry) => entry.node === 50)?.action).toBe('deny');
  });

  it('ignora o `(matched counts: N)` dinamico e o banner do SSH', () => {
    const comContadorDiferente = DISPLAY_READBACK.replace('matched counts: 2', 'matched counts: 987');
    expect(
      (parseHuaweiRoutePolicyNodesLenient(comContadorDiferente).get('PL-HORIZONTES_IPv4-IN') ?? [])
        .map((entry) => entry.node),
    ).toEqual([11, 50]);
  });

  it('continua lendo o formato de CONFIGURACAO (lenient)', () => {
    const configNodes = parseHuaweiRoutePolicyNodesLenient(RP_CONFIG);
    expect((configNodes.get('PL-HORIZONTES_IPv4-IN') ?? []).map((entry) => entry.node)).toEqual([
      1, 2, 5, 11,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Casos REAIS do F1A (`display current-configuration configuration bgp`).
// O bloco global traz so as-number/description; a policy de import vive DENTRO
// de `ipv4-family unicast` / `ipv6-family unicast`.
// ---------------------------------------------------------------------------
const F1A_BGP_CONFIG = [
  '#',
  'bgp 268568',
  ' peer 10.200.200.158 as-number 267627',
  ' peer 10.200.200.158 description playconnect',
  ' peer 10.200.200.166 as-number 28590',
  ' peer 10.200.200.166 description RNJ',
  ' peer 10.200.200.178 as-number 28590',
  ' peer 10.200.200.178 description RNJ-02',
  ' peer 10.200.201.34 as-number 266010',
  ' peer 10.200.201.34 description SUPERNET-V4',
  ' peer 10.200.201.122 as-number 273443',
  ' peer 10.200.201.122 description WFREDES-V4-273443',
  ' peer 2804:532C:0:1::6E as-number 64602',
  ' peer 2804:532C:0:1::6E description WF_Bonsucesso',
  ' peer 2804:532C:0:1::112 as-number 272454',
  ' peer 2804:532C:0:1::112 description RNJ',
  ' peer 2804:532C:0:1::12A as-number 272454',
  ' peer 2804:532C:0:1::12A description RNJ',
  ' peer 2804:532C:0:1::12D as-number 274388',
  ' peer 2804:532C:0:1::12D description PREFIX-PLAYCONNECT',
  ' ipv4-family unicast',
  '  peer 10.200.200.158 enable',
  '  peer 10.200.200.158 route-policy PL-PLAYCONNECT_IPv4-IN import',
  '  peer 10.200.200.158 route-policy PL-PLAYCONNECT_IPv4-OUT export',
  '  peer 10.200.200.166 route-policy PL-RNJ_IPv4-IN import',
  '  peer 10.200.200.166 route-policy PL-RNJ_IPv4-OUT export',
  '  peer 10.200.200.178 route-policy PL-RNJ_IPv4-IN import',
  '  peer 10.200.200.178 route-policy PL-RNJ_IPv4-OUT export',
  '  peer 10.200.201.34 route-policy PL-SUPERNET-IPv4-IN import',
  '  peer 10.200.201.34 route-policy PL-SUPERNET-IPv4-OUT export',
  '  peer 10.200.201.122 route-policy PL-WFREDES-V4-IN import',
  '  peer 10.200.201.122 route-policy PL-WFREDES-V4-OUT export',
  ' #',
  ' ipv4-family flow',
  '  peer 172.20.0.16 redirect ip rfc-compatible',
  '  peer 172.20.0.16 route-policy ACCEPT-IN-WANGUARD import',
  ' #',
  ' ipv6-family unicast',
  '  peer 2804:532C:0:1::6E enable',
  '  peer 2804:532C:0:1::6E route-policy PL-WF_Bonsucesso_IPv6-IN import',
  '  peer 2804:532C:0:1::6E route-policy PL-WF_Bonsucesso_IPv6-OUT export',
  '  peer 2804:532C:0:1::112 route-policy PL-RNJ_IPv6-IN import',
  '  peer 2804:532C:0:1::112 route-policy PL-RNJ_IPv6-OUT export',
  '  peer 2804:532C:0:1::12A route-policy PL-RNJ_IPv6-IN import',
  '  peer 2804:532C:0:1::12A route-policy PL-RNJ_IPv6-OUT export',
  '  peer 2804:532C:0:1::12D route-policy PL-PLAYCONNECT_IPv6-IN import',
  '  peer 2804:532C:0:1::12D route-policy PL-PLAYCONNECT_IPv6-OUT export',
  '#',
  'return',
].join('\n');

describe('parser com address-family — casos reais do F1A', () => {
  const parsed = parseHuaweiBgpPolicyConfiguration(F1A_BGP_CONFIG);
  const ipv4 = (peer: string) => resolvePeerInboundPolicy(peer, 'IPV4', parsed);
  const ipv6 = (peer: string) => resolvePeerInboundPolicy(peer, 'IPV6', parsed);

  it('IPv4: PLAY CONNECT/RNJ/RNJ-02/SUPERNET/WF resolvem a policy de import', () => {
    expect(ipv4('10.200.200.158')).toBe('PL-PLAYCONNECT_IPv4-IN');
    expect(ipv4('10.200.200.166')).toBe('PL-RNJ_IPv4-IN');
    expect(ipv4('10.200.200.178')).toBe('PL-RNJ_IPv4-IN');
    expect(ipv4('10.200.201.34')).toBe('PL-SUPERNET-IPv4-IN');
    expect(ipv4('10.200.201.122')).toBe('PL-WFREDES-V4-IN');
  });

  it('IPv6: RNJ/RNJ-02/PLAY/WF resolvem a policy de import', () => {
    expect(ipv6('2804:532c:0:1::112')).toBe('PL-RNJ_IPv6-IN');
    expect(ipv6('2804:532c:0:1::12a')).toBe('PL-RNJ_IPv6-IN');
    expect(ipv6('2804:532c:0:1::12d')).toBe('PL-PLAYCONNECT_IPv6-IN');
    expect(ipv6('2804:532c:0:1::6e')).toBe('PL-WF_Bonsucesso_IPv6-IN');
  });

  it('IPv6 em MAIUSCULO/expandido normaliza', () => {
    expect(ipv6('2804:532C:0000:0001:0000:0000:0000:0112')).toBe('PL-RNJ_IPv6-IN');
  });

  it('peer IPv4 nao existe na family IPv6 (e vice-versa)', () => {
    expect(resolvePeerInboundPolicy('10.200.200.158', 'IPV6', parsed)).toBeNull();
    expect(resolvePeerInboundPolicy('2804:532c:0:1::112', 'IPV4', parsed)).toBeNull();
  });

  it('ipv4-family flow NAO alimenta a family unicast', () => {
    expect(ipv4('172.20.0.16')).toBeNull();
  });
});

describe('parser com address-family — casos negativos', () => {
  it('A) policy somente export nunca resolve como import', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration(
      bgpV4('peer 10.0.0.5 route-policy PL-ONLY-OUT export'),
    );
    expect(resolvePeerInboundPolicy('10.0.0.5', 'IPV4', parsed)).toBeNull();
  });

  it('B) mesma chave em outra family nao cruza (peer e peer-group)', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration(
      [
        'bgp 64500',
        ' ipv4-family unicast',
        '  peer 10.0.0.1 route-policy PL-V4-IN import',
        '  peer GRUPO-VX route-policy PL-G4-IN import',
        '  peer 10.0.0.9 group GRUPO-VX',
        ' #',
        ' ipv6-family unicast',
        '  peer 2001:DB8::1 route-policy PL-V6-IN import',
        '  peer GRUPO-VX route-policy PL-G6-IN import',
        '  peer 2001:DB8::9 group GRUPO-VX',
        '#',
      ].join('\n'),
    );
    expect(resolvePeerInboundPolicy('10.0.0.1', 'IPV4', parsed)).toBe('PL-V4-IN');
    expect(resolvePeerInboundPolicy('10.0.0.1', 'IPV6', parsed)).toBeNull();
    expect(resolvePeerInboundPolicy('2001:db8::1', 'IPV6', parsed)).toBe('PL-V6-IN');
    expect(resolvePeerInboundPolicy('2001:db8::1', 'IPV4', parsed)).toBeNull();
    // O MESMO nome de grupo em families diferentes nao colide.
    expect(resolvePeerInboundPolicy('10.0.0.9', 'IPV4', parsed)).toBe('PL-G4-IN');
    expect(resolvePeerInboundPolicy('2001:db8::9', 'IPV6', parsed)).toBe('PL-G6-IN');
  });

  it('C) peer global sem route-policy na family => null', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration(
      ['bgp 64500', ' peer 10.0.0.7 as-number 65001', ' peer 10.0.0.7 description SO-GLOBAL', '#'].join('\n'),
    );
    expect(resolvePeerInboundPolicy('10.0.0.7', 'IPV4', parsed)).toBeNull();
    expect(resolvePeerInboundPolicy('10.0.0.7', 'IPV6', parsed)).toBeNull();
  });

  it('D) IPv6 maiusculo/comprimido/expandido resolve a mesma policy', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration(
      [
        'bgp 64500',
        ' ipv6-family unicast',
        '  peer 2804:532C:0000:0001:0000:0000:0000:0142 route-policy PL-NORM-IN import',
        '#',
      ].join('\n'),
    );
    expect(resolvePeerInboundPolicy('2804:532c:0:1::142', 'IPV6', parsed)).toBe('PL-NORM-IN');
    expect(resolvePeerInboundPolicy('2804:532C:0:1::142', 'IPV6', parsed)).toBe('PL-NORM-IN');
  });

  it('E) direct wins sobre group dentro da family', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration(
      ['bgp 64500', ' ipv4-family unicast', '  peer GRUPO-Y route-policy PL-GRUPO-IN import', '  peer 10.0.0.3 group GRUPO-Y', '  peer 10.0.0.3 route-policy PL-DIRETO-IN import', '#'].join('\n'),
    );
    expect(resolvePeerInboundPolicy('10.0.0.3', 'IPV4', parsed)).toBe('PL-DIRETO-IN');
  });

  it('F) sem bloco de family nada resolve (fail-closed)', () => {
    const parsed = parseHuaweiBgpPolicyConfiguration(
      ['bgp 64500', ' peer 10.0.0.1 route-policy PL-V4-IN import', '#'].join('\n'),
    );
    expect(parsed.directPeerPolicies.size).toBe(0);
    expect(resolvePeerInboundPolicy('10.0.0.1', 'IPV4', parsed)).toBeNull();
  });
});
