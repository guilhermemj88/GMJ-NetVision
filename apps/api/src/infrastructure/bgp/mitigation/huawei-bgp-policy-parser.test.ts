import { describe, expect, it } from 'vitest';
import {
  allNodesOf,
  parseHuaweiRoutePolicyNodesLenient,
  nodesApplyingRouteTarget,
  parseHuaweiBgpPolicyConfiguration,
  parseHuaweiRoutePolicyNodes,
  permitNodesOf,
  resolvePeerInboundPolicy,
} from './huawei-bgp-policy-parser';

const BGP_CONFIG = [
  '#',
  'bgp 64500',
  ' peer 10.200.200.106 as-number 6939',
  ' peer 10.200.200.106 route-policy PL-HORIZONTES_IPv4-IN import',
  ' peer 10.200.200.106 route-policy PL-HORIZONTES_IPv4-OUT export',
  ' peer 10.200.200.10 route-policy PL-HORIZONTES_IPv4-IN import',
  ' peer 10.200.200.40 route-policy PL-SO-EXPORT export',
  ' peer 10.200.200.20 group PL-GRUPO-X',
  ' peer PL-GRUPO-X route-policy PL-GRUPO-IN import',
  ' peer 10.200.200.30 group PL-GRUPO-X',
  ' peer 10.200.200.30 route-policy PL-DIRETO-IN import',
  ' ipv4-family unicast',
  '  peer 10.200.200.106 enable',
  '#',
  'return',
].join('\n');

describe('parser da configuracao BGP (policy IN por peer)', () => {
  const parsed = parseHuaweiBgpPolicyConfiguration(BGP_CONFIG);

  it('extrai a policy de import declarada no peer', () => {
    expect(resolvePeerInboundPolicy('10.200.200.106', parsed)).toBe('PL-HORIZONTES_IPv4-IN');
    expect(resolvePeerInboundPolicy('10.200.200.10', parsed)).toBe('PL-HORIZONTES_IPv4-IN');
  });

  it('nunca usa a policy de export como se fosse import', () => {
    expect(resolvePeerInboundPolicy('10.200.200.40', parsed)).toBeNull();
    expect(parsed.directPeerPolicies.get('10.200.200.106')).toBe('PL-HORIZONTES_IPv4-IN');
  });

  it('herda a policy do peer-group quando o peer nao tem policy propria', () => {
    expect(resolvePeerInboundPolicy('10.200.200.20', parsed)).toBe('PL-GRUPO-IN');
  });

  it('a policy declarada no peer vence a do grupo', () => {
    expect(resolvePeerInboundPolicy('10.200.200.30', parsed)).toBe('PL-DIRETO-IN');
  });

  it('peer fora da configuracao nao inventa policy', () => {
    expect(resolvePeerInboundPolicy('10.200.200.99', parsed)).toBeNull();
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
