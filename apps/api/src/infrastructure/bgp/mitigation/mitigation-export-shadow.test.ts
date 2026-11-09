import { describe, expect, it } from 'vitest';
import {
  REAL_BGP_CONFIG,
  REAL_EXTCOMMUNITY_FILTER,
  REAL_ROUTE_POLICY_CONFIG,
  syntheticAllPrefixLists,
} from '../../../testing/physical-bgp-simulator';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { checkMitigationExport } from './mitigation-export-shadow';
import { deriveMitigationNode2Contract } from './mitigation-node2-contract';
import { testMitigationContract } from './mitigation-test-support';

/**
 * Elegibilidade do lado do EXPORT (A2) sobre a config REAL sanitizada. As definicoes de
 * ip-prefix sao SINTETICAS (a captura nao as traz): cada lista ganha um /24 distinto, entao a
 * unica sobreposicao e por NOME igual (ex.: TRIPLO_A-BLOCO-TODO, da UAY e do deny node 47).
 */

const BOGONS = 'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8 greater-equal 8 less-equal 32';
const LISTS = [
  BOGONS,
  syntheticAllPrefixLists()
    .split('\n')
    .filter((line) => !line.includes(' AGLINK-BLOCO-TODO-23 '))
    .join('\n'),
  A.prefixDefinition,
].join('\n');

const names = [
  ...new Set(
    [...REAL_ROUTE_POLICY_CONFIG.matchAll(/^route-policy (\S+-(?:IPv4|V4)-IN|\S+_IPv4-IN) /gm)].map(
      (match) => match[1]!,
    ),
  ),
];

function classify(policy: string, routeRts?: string[]) {
  const derived = deriveMitigationNode2Contract(REAL_ROUTE_POLICY_CONFIG, policy, {
    prefixListConfiguration: LISTS,
    requirePrefixListProof: true,
  });
  if (!derived.eligible) return { kind: 'CONTRACT_REFUSED' as const, reasons: derived.reasons };
  const shadow = checkMitigationExport({
    contract: derived.contract,
    routePolicyConfiguration: REAL_ROUTE_POLICY_CONFIG,
    prefixListConfiguration: LISTS,
    bgpConfiguration: REAL_BGP_CONFIG,
    extcommunityFilterOutput: REAL_EXTCOMMUNITY_FILTER,
    ...(routeRts ? { routeRts } : {}),
  });
  return shadow.ok
    ? { kind: 'ELIGIBLE' as const, reasons: [] }
    : { kind: 'EXPORT_SHADOWED' as const, reasons: shadow.reasons };
}

describe('matriz de elegibilidade (contrato + export), FIXADA (B5)', () => {
  const result = new Map(names.map((name) => [name, classify(name)]));
  const of = (kind: string) =>
    [...result.entries()]
      .filter(([, r]) => r.kind === kind)
      .map(([name]) => name)
      .sort();

  it('38 policies IPv4 de import: 21 elegiveis, 1 sombreada no export (UAY), 16 recusadas', () => {
    expect(names).toHaveLength(38);
    expect(of('ELIGIBLE')).toEqual(
      [
        'PL-73S_IPv4-IN',
        'PL-ACM_IPv4-IN',
        'PL-AGLINK_IPv4-IN',
        'PL-BHNET_IPv4-IN',
        'PL-CETRO-V4-IN',
        'PL-CLICKING-V4-IN',
        'PL-CONNECT_BH-V4-IN',
        'PL-FIRE-TELECOM_IPv4-IN',
        'PL-FLASH-TELECOM_IPv4-IN',
        'PL-GMTELECOM_IPv4-IN',
        'PL-GNA_IPv4-IN',
        'PL-JUSTNET-IPv4-IN',
        'PL-PLAYCONNECT_IPv4-IN',
        'PL-PONTUALNET_IPv4-IN',
        'PL-RHEOLI_IPv4-IN',
        'PL-RNJ_IPv4-IN',
        'PL-SPARKNET_IPv4-IN',
        'PL-SUPERNET-IPv4-IN',
        'PL-TOPUM_IPv4-IN',
        'PL-VNT_IPv4-IN',
        'PL-WFREDES-V4-IN',
      ].sort(),
    );
    expect(of('EXPORT_SHADOWED')).toEqual(['PL-UAY_IPv4-IN']);
    expect(of('CONTRACT_REFUSED')).toEqual(
      [
        'INFINIT_PROVEDOR_IPv4-IN',
        'MITIGACAO-73S-V4-IN',
        'MITIGACAO-CLICKING-V4-IN',
        'MITIGACAO-GNA-V4-IN',
        'PL-BLINK-GRANDELLA_IPv4-IN',
        'PL-CIRION-IPv4-IN',
        'PL-COMPUTIZE-IPv4-IN',
        'PL-HORIZONTES_IPv4-IN',
        'PL-ITOP_IPv4-IN',
        'PL-LIKEE_IPv4-IN',
        'PL-LIVINET_IPv4-IN',
        'PL-MIX-TELECOM-V4-IN',
        'PL-SEABORN-BH-IPv4-IN',
        'PL-SEABORN-IPv4-IN',
        'PL-SEMPRE-IPv4-IN',
        'PL-TUDDO-IPv4-IN',
      ].sort(),
    );
  });

  it('UAY: recusada com MITIGATION_EXPORT_SHADOWED pelo deny node 47 (TRIPLO_A-BLOCO-TODO)', () => {
    const uay = result.get('PL-UAY_IPv4-IN')!;
    expect(uay.kind).toBe('EXPORT_SHADOWED');
    expect(uay.reasons.join(' | ')).toMatch(
      /PL-COMPUTIZE-IPv4-OUT node 47 \(deny\).*lista TRIPLO_A-BLOCO-TODO sobrepoe TRIPLO_A-BLOCO-TODO/,
    );
  });

  it('AGLINK passa: nenhum deny anterior ao node 300 casa 167.250.126.0/23', () => {
    expect(result.get(A.policy)!.kind).toBe('ELIGIBLE');
  });

  it('B1: o REPLACE e obrigatorio - com additive (140+660) o deny node 90 da COMPUTIZE sombrearia ate a AGLINK', () => {
    const additive = classify(A.policy, ['268568:140', '268568:660']);
    expect(additive.kind).toBe('EXPORT_SHADOWED');
    expect(additive.reasons.join(' | ')).toMatch(
      /node 90 \(deny\).*extcommunity-filter 140 casa as RTs da rota/,
    );
  });
});

describe('checkMitigationExport: casos unitarios', () => {
  const contract = {
    ...testMitigationContract('PL-X_IPv4-IN', 'CLIENTE', 1000),
    prefixListEntries: ['ip ip-prefix CLIENTE index 10 permit 198.51.100.0 24'],
  };
  const bgp = [
    'bgp 1',
    ' ipv4-family unicast',
    '  peer 192.0.2.9 route-policy OUT export',
    '#',
  ].join('\n');
  const filter = [
    'Named Extended Community basic filter: MITIGACAO',
    '    index: 10            permit     rt : 268568:660',
  ].join('\n');
  const run = (policy: string, lists: string, overrides: Record<string, unknown> = {}) =>
    checkMitigationExport({
      contract,
      routePolicyConfiguration: policy,
      prefixListConfiguration: lists,
      bgpConfiguration: bgp,
      extcommunityFilterOutput: filter,
      ...overrides,
    });
  const permit300 = ['route-policy OUT permit node 300', ' if-match extcommunity-filter MITIGACAO'];

  it('export limpo: ok', () => {
    expect(run(permit300.join('\n'), '').ok).toBe(true);
  });

  it('deny com lista sobreposta antes do permit => sombreado; sem sobreposicao => ok', () => {
    const overlap = [
      'route-policy OUT deny node 10',
      ' if-match ip-prefix OVER',
      ...permit300,
    ].join('\n');
    expect(run(overlap, 'ip ip-prefix OVER index 10 permit 198.51.100.128 25').ok).toBe(false);
    expect(run(overlap, 'ip ip-prefix OVER index 10 permit 203.0.113.0 24').ok).toBe(true);
  });

  it('deny com lista nao definida, deny sem condicao e condicao nao avaliavel => nao comprovavel', () => {
    for (const lines of [
      ['route-policy OUT deny node 10', ' if-match ip-prefix SEM-DEFINICAO'],
      ['route-policy OUT deny node 10'],
      ['route-policy OUT deny node 10', ' if-match as-path-filter 3'],
    ]) {
      const result = run([...lines, ...permit300].join('\n'), '');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('MITIGATION_EXPORT_SHADOWED');
    }
  });

  it('deny que depende de OUTRA RT (filtro desconhecido => nao comprovavel; filtro de outra RT => ok)', () => {
    const other = `${filter}\nNamed Extended Community basic filter: OUTRA\n    index: 10            permit     rt : 268568:100`;
    const policy = [
      'route-policy OUT deny node 10',
      ' if-match extcommunity-filter OUTRA',
      ...permit300,
    ].join('\n');
    expect(run(policy, '', { extcommunityFilterOutput: other }).ok).toBe(true);
    expect(run(policy, '').ok).toBe(false); // OUTRA nao existe na saida: desconhecido
  });

  it('sem permit MITIGACAO generico, sem peer descoberto ou sem policy => inelegivel', () => {
    expect(
      run(
        'route-policy OUT deny node 10\n if-match ip-prefix X',
        'ip ip-prefix X index 10 permit 203.0.113.0 24',
      ).ok,
    ).toBe(false);
    expect(run(permit300.join('\n'), '', { bgpConfiguration: 'bgp 1' }).ok).toBe(false);
    expect(run('', '').ok).toBe(false);
    expect(run(permit300.join('\n'), '', { extcommunityFilterOutput: null }).ok).toBe(false);
  });

  it('permit anterior que casa nao sombreia (a rota ja sai exportada)', () => {
    const policy = [
      'route-policy OUT permit node 10',
      ' if-match ip-prefix CLIENTE',
      ...permit300,
    ].join('\n');
    expect(run(policy, 'ip ip-prefix CLIENTE index 10 permit 198.51.100.0 24').ok).toBe(true);
  });
});
