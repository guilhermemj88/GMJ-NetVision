import { describe, expect, it } from 'vitest';
import { REAL_ROUTE_POLICY_CONFIG } from '../../../testing/physical-bgp-simulator';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import {
  contractRefusalMessage,
  deriveMitigationNode2Contract,
  ipPrefixListPermits,
  isMitigationNode2Contract,
  MITIGATION_CONTRACT_CLAUSE_ALLOWLIST,
  MITIGATION_CONTRACT_UNSUPPORTED,
  mitigationNode2Clauses,
  parseIpPrefixEntries,
  sameMitigationNode2Contract,
} from './mitigation-node2-contract';
import { exactMitigationNodes } from './mitigation-contract';

/**
 * Derivacao do contrato do node 2 sobre as configuracoes REAIS sanitizadas do equipamento
 * (`__fixtures__/real-aglink/route-policy.cfg`). Prova que o contrato NAO presume que toda policy
 * e igual a AGLINK: cada forma e aceita ou recusada com motivo explicito.
 */

const AGLINK_LISTS = [
  'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8 greater-equal 8 less-equal 32',
  A.prefixDefinition,
].join('\n');

const derive = (policy: string, lists: string | null = null) =>
  deriveMitigationNode2Contract(REAL_ROUTE_POLICY_CONFIG, policy, {
    ...(lists === null ? {} : { prefixListConfiguration: lists, requirePrefixListProof: true }),
  });

describe('politicas REAIS (route-policy.cfg do equipamento)', () => {
  it('AGLINK: elegivel (node 10: lista /23 ge23 le24, LP 1100, RT 140 additive; deny 1000)', () => {
    const result = derive(A.policy, AGLINK_LISTS);
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.contract).toMatchObject({
      policyName: A.policy,
      baselineNode: 10,
      prefixList: 'AGLINK-BLOCO-TODO-23',
      localPreference: 1100,
      rt: '268568:660',
      rtMode: 'REPLACE',
      baselineRt: '268568:140',
      baselineRtAdditive: true,
    });
    expect(mitigationNode2Clauses(result.contract)).toEqual([
      'if-match ip-prefix AGLINK-BLOCO-TODO-23',
      'apply local-preference 1100',
      'apply extcommunity rt 268568:660',
    ]);
    expect(isMitigationNode2Contract(result.contract)).toBe(true);
  });

  it('FLASH: elegivel (RT 140 SEM additive, LP 3000, deny 999)', () => {
    const result = derive('PL-FLASH-TELECOM_IPv4-IN');
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.contract).toMatchObject({
      baselineNode: 10,
      prefixList: 'PREFIX-FLASHTELECOM-IPV4',
      localPreference: 3000,
      baselineRtAdditive: false,
    });
  });

  it('HORIZONTES: RECUSADA (o node permanente 11 ja aplica a RT de mitigacao 660)', () => {
    const result = derive('PL-HORIZONTES_IPv4-IN');
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.code).toBe(MITIGATION_CONTRACT_UNSUPPORTED);
    expect(result.reasons.join(' | ')).toMatch(
      /node 11: o node permanente ja aplica a RT de mitigacao 268568:660/,
    );
    expect(contractRefusalMessage(result)).toMatch(/^MITIGATION_CONTRACT_UNSUPPORTED: /);
  });

  it('JUSTNET (policy compartilhada): o contrato e elegivel; o gate de policy compartilhada segue separado', () => {
    const result = derive('PL-JUSTNET-IPv4-IN');
    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.contract.localPreference).toBe(1000);
  });

  it('policies manuais MITIGACAO-* (dois permits ou RT 660 sem 140) e IPv6 sao RECUSADAS', () => {
    for (const policy of ['MITIGACAO-73S-V4-IN', 'MITIGACAO-GNA-V4-IN', 'PL-AGLINK_IPv6-IN']) {
      const result = derive(policy);
      expect(result.eligible, policy).toBe(false);
    }
    const ipv6 = derive('PL-AGLINK_IPv6-IN');
    if (!ipv6.eligible) {
      expect(ipv6.reasons.join(' | ')).toMatch(
        /if-match fora da allowlist: if-match ipv6 address prefix-list/,
      );
    }
  });

  it('matriz de TODAS as policies IPv4 de import do equipamento: nenhuma e aceita por acidente', () => {
    const names = [
      ...new Set(
        [
          ...REAL_ROUTE_POLICY_CONFIG.matchAll(
            /^route-policy (\S+_IPv4-IN|\S+-V4-IN|\S+-IPv4-IN) /gm,
          ),
        ].map((match) => match[1]!),
      ),
    ];
    expect(names.length).toBeGreaterThan(10);
    const eligible: string[] = [];
    for (const name of names) {
      const result = derive(name);
      if (result.eligible) {
        eligible.push(name);
        // Elegivel => forma exata: um permit, lista, LP, RT 140; nada de 660 no baseline.
        expect(result.contract.baselineRt).toBe('268568:140');
        expect(result.contract.prefixList).toMatch(/\S+/);
      } else {
        expect(result.reasons.length).toBeGreaterThan(0);
      }
    }
    expect(eligible).toContain(A.policy);
    expect(eligible).toContain('PL-FLASH-TELECOM_IPv4-IN');
    expect(eligible).toContain('PL-JUSTNET-IPv4-IN');
    expect(eligible).not.toContain('PL-HORIZONTES_IPv4-IN');
  });
});

describe('recusas explicitas (MITIGATION_CONTRACT_UNSUPPORTED)', () => {
  const P = 'PL-X_IPv4-IN';
  const permanent = (lines: string[]) => [`route-policy ${P} permit node 10`, ...lines].join('\n');
  const ok = [
    ' if-match ip-prefix LIST-X',
    ' apply local-preference 900',
    ' apply extcommunity rt 268568:140 additive',
  ];
  const lists =
    'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8\nip ip-prefix LIST-X index 10 permit 198.51.100.0 24';
  const reasonsOf = (text: string, withLists: string | null = lists) => {
    const result = deriveMitigationNode2Contract(text, P, {
      ...(withLists === null ? {} : { prefixListConfiguration: withLists }),
      requirePrefixListProof: true,
    });
    return result.eligible ? null : result.reasons.join(' | ');
  };

  it('baseline minimo elegivel', () => {
    expect(reasonsOf(permanent(ok))).toBeNull();
  });

  it('mais de um permit', () => {
    expect(
      reasonsOf(
        [permanent(ok), `route-policy ${P} permit node 20`, ' if-match ip-prefix LIST-X'].join(
          '\n',
        ),
      ),
    ).toMatch(/mais de um node permit permanente \[10, 20\]/);
  });

  it('permit sem if-match (permit amplo)', () => {
    expect(
      reasonsOf(permanent([' apply local-preference 900', ' apply extcommunity rt 268568:140'])),
    ).toMatch(/sem if-match ip-prefix \(permit amplo\)/);
  });

  it('sem nenhum permit', () => {
    expect(reasonsOf(`route-policy ${P} deny node 10`)).toMatch(/nenhum node permit de cliente/);
  });

  it('RT 660 no node permanente (caso HORIZONTES node 11)', () => {
    expect(
      reasonsOf(
        permanent([
          ' if-match ip-prefix LIST-X',
          ' apply local-preference 900',
          ' apply extcommunity rt 268568:660',
        ]),
      ),
    ).toMatch(/ja aplica a RT de mitigacao/);
  });

  it('RT 140 junto de outras RTs/communities nao e provada exclusiva', () => {
    expect(
      reasonsOf(
        permanent([
          ' if-match ip-prefix LIST-X',
          ' apply local-preference 900',
          ' apply extcommunity rt 268568:140 rt 268568:330 additive',
        ]),
      ),
    ).toMatch(/fora da allowlist/);
    expect(reasonsOf(permanent([...ok, ' apply community 65000:1']))).toMatch(
      /clausula fora da allowlist: apply community 65000:1/,
    );
    expect(
      reasonsOf(
        permanent([
          ' if-match ip-prefix LIST-X',
          ' apply local-preference 900',
          ' apply extcommunity rt 268568:110 additive',
        ]),
      ),
    ).toMatch(/fora da allowlist \(somente 268568:140\)/);
  });

  it('sem RT ou sem LP no node permanente', () => {
    expect(
      reasonsOf(permanent([' if-match ip-prefix LIST-X', ' apply local-preference 900'])),
    ).toMatch(/exige exatamente um apply extcommunity rt 268568:140 \(encontrado 0\)/);
    expect(
      reasonsOf(permanent([' if-match ip-prefix LIST-X', ' apply extcommunity rt 268568:140'])),
    ).toMatch(/exige exatamente um apply local-preference \(encontrado 0\)/);
  });

  it('mais de um if-match, if-match de outro tipo, goto, LP relativo', () => {
    expect(reasonsOf(permanent([...ok, ' if-match ip-prefix OUTRA']))).toMatch(
      /mais de um if-match/,
    );
    expect(reasonsOf(permanent([...ok, ' if-match community-filter 7']))).toMatch(
      /if-match fora da allowlist/,
    );
    expect(reasonsOf(permanent([...ok, ' goto next-node']))).toMatch(
      /clausula fora da allowlist: goto next-node/,
    );
    expect(
      reasonsOf(
        permanent([
          ' if-match ip-prefix LIST-X',
          ' apply local-preference +100',
          ' apply extcommunity rt 268568:140',
        ]),
      ),
    ).toMatch(/local-preference|encontrado/);
  });

  it('prefix-list inexistente ou configuracao de ip-prefix indisponivel', () => {
    expect(reasonsOf(permanent(ok), 'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8')).toMatch(
      /prefix-list LIST-X inexistente/,
    );
    expect(reasonsOf(permanent(ok), null)).toMatch(/existencia da prefix-list nao comprovada/);
  });

  it('deny anterior ao node do cliente: sem if-match, vazio de prova, ou sobreposto; BOGONS e inofensivo', () => {
    const denyBefore = (lines: string[]) =>
      [`route-policy ${P} deny node 5`, ...lines, permanent(ok)].join('\n');
    expect(reasonsOf(denyBefore([]))).toMatch(/node deny 5 sem if-match antecede o node 10/);
    expect(reasonsOf(denyBefore([' if-match ip-prefix BOGONS']))).toBeNull();
    expect(
      reasonsOf(
        denyBefore([' if-match ip-prefix OVERLAP']),
        `${lists}\nip ip-prefix OVERLAP index 10 permit 198.51.100.128 25`,
      ),
    ).toMatch(/lista OVERLAP\) antecede o 10 e alcanca prefixos de LIST-X/);
    expect(
      reasonsOf(
        denyBefore([' if-match ip-prefix FAR']),
        `${lists}\nip ip-prefix FAR index 10 permit 203.0.113.0 24`,
      ),
    ).toBeNull();
    expect(reasonsOf(denyBefore([' if-match as-path-filter 3']))).toMatch(/if-match nao ip-prefix/);
    // deny DEPOIS do node do cliente nunca alcanca a lista do cliente: irrelevante.
    expect(reasonsOf([permanent(ok), `route-policy ${P} deny node 1000`].join('\n'))).toBeNull();
  });

  it('allowlist documentada tem exatamente as tres clausulas', () => {
    expect(MITIGATION_CONTRACT_CLAUSE_ALLOWLIST).toHaveLength(3);
  });
});

describe('read-back e contrato (exactMitigationNodes)', () => {
  const P = 'PL-X_IPv4-IN';
  const base = [
    `route-policy ${P} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${P} permit node 2`,
    ' if-match ip-prefix LIST-X',
    ' apply local-preference 900',
    ' apply extcommunity rt 268568:660',
    `route-policy ${P} permit node 10`,
    ' if-match ip-prefix LIST-X',
    ' apply local-preference 900',
    ' apply extcommunity rt 268568:140 additive',
  ].join('\n');

  it('aceita o node 2 igual ao contrato derivado dos nodes permanentes do proprio texto', () => {
    expect(exactMitigationNodes(base, P)).toEqual({ bogonOk: true, mitigationOk: true });
  });

  it('com policy sem contrato derivavel o node 2 NUNCA esta ok (fail-closed)', () => {
    const horizontes = base.replace('rt 268568:140 additive', 'rt 268568:660');
    expect(exactMitigationNodes(horizontes, P).mitigationOk).toBe(false);
  });

  it('o contrato do preflight tem precedencia: node 2 com LP diferente do contrato e divergente', () => {
    const derived = deriveMitigationNode2Contract(base, P);
    expect(derived.eligible).toBe(true);
    if (!derived.eligible) return;
    expect(exactMitigationNodes(base, P, derived.contract).mitigationOk).toBe(true);
    expect(
      exactMitigationNodes(base, P, { ...derived.contract, localPreference: 100 }).mitigationOk,
    ).toBe(false);
    expect(sameMitigationNode2Contract(derived.contract, { ...derived.contract })).toBe(true);
    expect(
      sameMitigationNode2Contract(derived.contract, { ...derived.contract, localPreference: 100 }),
    ).toBe(false);
  });
});

describe('ip-prefix: casamento como no VRP (ge/le)', () => {
  const entries = parseIpPrefixEntries(A.prefixDefinition, 'AGLINK-BLOCO-TODO-23')!;
  const m = (prefix: string) => {
    const [address, length] = prefix.split('/');
    const parts = address!.split('.').map(Number);
    const network = parts[0]! * 2 ** 24 + parts[1]! * 2 ** 16 + parts[2]! * 2 ** 8 + parts[3]!;
    return ipPrefixListPermits(entries, { network, length: Number(length) });
  };

  it('AGLINK /23 ge23 le24: aceita /23 e /24 do bloco; rejeita /22, /25 e fora do bloco', () => {
    expect(m('167.250.126.0/23')).toBe(true);
    expect(m('167.250.126.0/24')).toBe(true);
    expect(m('167.250.127.0/24')).toBe(true);
    expect(m('167.250.126.0/25')).toBe(false);
    expect(m('167.250.124.0/22')).toBe(false);
    expect(m('167.250.128.0/24')).toBe(false);
    expect(m('8.8.8.0/24')).toBe(false);
  });
});
