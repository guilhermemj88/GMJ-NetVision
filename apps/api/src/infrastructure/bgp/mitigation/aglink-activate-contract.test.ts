import { describe, expect, it } from 'vitest';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import {
  deriveMitigationNode2Contract,
  mitigationNode2Clauses,
  MITIGATION_CONTRACT_UNSUPPORTED,
  type MitigationNode2Contract,
} from './mitigation-node2-contract';
import {
  buildMitigationActivateCommands,
  buildMitigationRemovalCommands,
} from './mitigation-write-guard';

/**
 * Contrato DEFINITIVO do ACTIVATE (IPv4) com o node 2 ESTREITO.
 *
 *   - node 1: deny + SOMENTE `if-match ip-prefix BOGONS`;
 *   - node 2: permit + `if-match ip-prefix <LISTA do node permanente>` +
 *     `apply local-preference <LP do node permanente>` + `apply extcommunity rt 268568:660`
 *     (SEM additive: a RT 660 SUBSTITUI a 140 - `rtMode: 'REPLACE'`).
 *
 * Nada de permit-all: prefixo fora da lista nao casa no node 2 e segue para os nodes
 * permanentes (comportamento atual preservado).
 */

const labels = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };
const pair = { bogonNode: 1, mitigationNode: 2 };
const plan = { policyName: A.policy, ...pair, rt: A.rt, ...labels };

/** Baseline fisico real da AGLINK (nodes 10 e 1000), formato de configuracao. */
const BASELINE = [
  `route-policy ${A.policy} permit node 10`,
  ` if-match ip-prefix ${A.targetPrefixList}`,
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  `route-policy ${A.policy} deny node 1000`,
].join('\n');

const PREFIX_LISTS = `ip ip-prefix BOGONS index 10 permit 10.0.0.0 8 greater-equal 8 less-equal 32
${A.prefixDefinition}`;

function contractOf(): MitigationNode2Contract {
  const derived = deriveMitigationNode2Contract(BASELINE, A.policy, {
    prefixListConfiguration: PREFIX_LISTS,
    requirePrefixListProof: true,
  });
  if (!derived.eligible) throw new Error(derived.reasons.join('; '));
  return derived.contract;
}
const CONTRACT = contractOf();

const CANONICAL_ACTIVATE = [
  'system-view',
  `route-policy ${A.policy} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${A.policy} permit node 2`,
  ` if-match ip-prefix ${A.targetPrefixList}`,
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:660',
  'commit',
];

const CANONICAL_REMOVE = [
  'system-view',
  `undo route-policy ${A.policy} node 1`,
  `undo route-policy ${A.policy} node 2`,
  'commit',
];

const AGLINK_SCOPE = new Set(['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24']);

/** Modelo de referencia: primeiro node que casa, LP e RT add/replace. */
function evaluate(config: string, prefix: string, incomingRts: string[]) {
  const result = { accepted: false, localPreference: 100, rts: [...incomingRts], node: 0 };
  for (const block of config.split(/(?=^route-policy )/m)) {
    const header = /^route-policy \S+ (permit|deny) node (\d+)$/.exec(block.trim().split('\n')[0]!);
    if (!header) continue;
    const list = /if-match ip-prefix (\S+)/.exec(block)?.[1];
    const matches =
      !list ||
      (list === 'BOGONS' && prefix.startsWith('10.')) ||
      (list === A.targetPrefixList && AGLINK_SCOPE.has(prefix));
    if (!matches) continue;
    result.node = Number(header[2]);
    if (header[1] === 'deny') return result;
    result.accepted = true;
    const lp = /apply local-preference (\d+)/.exec(block)?.[1];
    if (lp) result.localPreference = Number(lp);
    for (const m of block.matchAll(/apply extcommunity rt ([^\n]+)/g)) {
      const additive = /\badditive\b/.test(m[1]!);
      const values = [...m[1]!.matchAll(/(\d+:\d+)/g)].map((x) => x[1]!);
      if (!additive) result.rts = [];
      for (const rt of values) if (!result.rts.includes(rt)) result.rts.push(rt);
    }
    return result;
  }
  return result;
}

const APPLY_RT = 'apply extcommunity rt 268568:660';

/** Baseline + o par criado pelo ACTIVATE, como aparece em `display route-policy`. */
const DISPLAY_AFTER = [
  `Route-policy: ${A.policy}`,
  '  deny : 1 (matched counts: 0)',
  '    Match clauses: ',
  '      if-match ip-prefix BOGONS',
  '  permit : 2 (matched counts: 3)',
  '    Match clauses: ',
  `      if-match ip-prefix ${A.targetPrefixList}`,
  '    Apply clauses: ',
  '      apply local-preference 1100',
  `      ${APPLY_RT}`,
  '  permit : 10 (matched counts: 77)',
  '    Match clauses: ',
  `      if-match ip-prefix ${A.targetPrefixList}`,
  '    Apply clauses: ',
  '      apply local-preference 1100',
  '      apply extcommunity rt 268568:140 additive',
  '  deny : 1000 (matched counts: 0)',
].join('\r\n');

describe('contrato derivado do baseline AGLINK', () => {
  it('deriva lista, LP, RT 140 aditiva e o modo de RT explicito REPLACE', () => {
    expect(CONTRACT).toMatchObject({
      version: 1,
      policyName: A.policy,
      baselineNode: 10,
      prefixList: A.targetPrefixList,
      localPreference: 1100,
      rt: '268568:660',
      rtMode: 'REPLACE',
      baselineRt: '268568:140',
      baselineRtAdditive: true,
    });
    expect(CONTRACT.prefixListEntries).toHaveLength(1);
    expect(mitigationNode2Clauses(CONTRACT)).toEqual([
      `if-match ip-prefix ${A.targetPrefixList}`,
      'apply local-preference 1100',
      APPLY_RT,
    ]);
  });
});

describe('1-2) criacao dos nodes 1 e 2 sem tocar em 10/1000', () => {
  it('gera exatamente a lista canonica do ACTIVATE', () => {
    expect(buildMitigationActivateCommands(plan, CONTRACT)).toEqual(CANONICAL_ACTIVATE);
  });

  it('sem contrato valido NENHUM comando e gerado (fail-closed)', () => {
    expect(() => buildMitigationActivateCommands(plan)).toThrow(MITIGATION_CONTRACT_UNSUPPORTED);
    expect(() =>
      buildMitigationActivateCommands(plan, { ...CONTRACT, rtMode: 'ADDITIVE' } as never),
    ).toThrow(MITIGATION_CONTRACT_UNSUPPORTED);
    expect(() =>
      buildMitigationActivateCommands(plan, { ...CONTRACT, policyName: 'OUTRA-POLICY' }),
    ).toThrow(MITIGATION_CONTRACT_UNSUPPORTED);
  });

  it('nenhum comando referencia node 10 ou node 1000, nem remove nada', () => {
    const text = buildMitigationActivateCommands(plan, CONTRACT).join('\n');
    expect(text).not.toMatch(/node (10|1000)\b/);
    expect(text).not.toMatch(/\bundo\b/);
  });

  it('o node 2 tem if-match + local-preference + RT 660, sem additive nem goto', () => {
    const commands = buildMitigationActivateCommands(plan, CONTRACT);
    const header = commands.indexOf(`route-policy ${A.policy} permit node 2`);
    expect(header).toBeGreaterThan(-1);
    expect(commands.slice(header + 1, -1)).toEqual([
      ` if-match ip-prefix ${A.targetPrefixList}`,
      ' apply local-preference 1100',
      ` ${APPLY_RT}`,
    ]);
    expect(commands.slice(header).join('\n')).not.toMatch(/additive|goto|permit-all/);
  });

  it('o REMOVE retira somente 1 e 2, sem deny/permit no undo', () => {
    expect(buildMitigationRemovalCommands({ policyName: A.policy, ...pair })).toEqual(
      CANONICAL_REMOVE,
    );
  });
});

describe('3-5) o node 2 estreito: LP preservada, RT substituida, sem permit-all', () => {
  const DURING = [
    `route-policy ${A.policy} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${A.policy} permit node 2`,
    ` if-match ip-prefix ${A.targetPrefixList}`,
    ' apply local-preference 1100',
    ` ${APPLY_RT}`,
    BASELINE,
  ].join('\n');

  it('antes: node 10 casa, LP1100 e RTs 330 (peer) + 140 (policy)', () => {
    expect(evaluate(BASELINE, '167.250.126.0/23', ['268568:330'])).toEqual({
      accepted: true,
      localPreference: 1100,
      rts: ['268568:330', '268568:140'],
      node: 10,
    });
  });

  it('durante: node 2 casa, MANTEM a LP 1100 e a RT 660 substitui as demais (140 e 330)', () => {
    for (const prefix of ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24']) {
      expect(evaluate(DURING, prefix, ['268568:330'])).toEqual({
        accepted: true,
        localPreference: 1100,
        rts: ['268568:660'],
        node: 2,
      });
    }
  });

  it('prefixo FORA da lista nao casa no node 2 e segue o comportamento atual', () => {
    for (const prefix of ['198.51.100.0/24', '167.250.126.0/25']) {
      expect(evaluate(DURING, prefix, ['268568:330'])).toEqual(
        evaluate(BASELINE, prefix, ['268568:330']),
      );
      expect(evaluate(DURING, prefix, ['268568:330']).node).not.toBe(2);
    }
  });

  it('BOGONS continua negado no node 1', () => {
    expect(evaluate(DURING, '10.10.0.0/16', ['268568:330'])).toMatchObject({
      accepted: false,
      node: 1,
    });
  });
});

describe('6-7) readback fisico e bloqueio de divergencias', () => {
  it('readback do estado ativado e verificado (com e sem o contrato do preflight)', () => {
    expect(verifyActivation(A.policy, DISPLAY_AFTER, pair, A.rt, labels, CONTRACT).verified).toBe(
      true,
    );
    expect(verifyActivation(A.policy, DISPLAY_AFTER, pair, A.rt, labels).verified).toBe(true);
  });

  it('readback do contrato ANTIGO (permit irrestrito so com a RT) NAO e verificado', () => {
    const legacy = [
      `Route-policy: ${A.policy}`,
      '  deny : 1 (matched counts: 0)',
      '      if-match ip-prefix BOGONS',
      '  permit : 2 (matched counts: 3)',
      `      ${APPLY_RT}`,
      '  permit : 10 (matched counts: 77)',
      `      if-match ip-prefix ${A.targetPrefixList}`,
      '      apply local-preference 1100',
      '      apply extcommunity rt 268568:140 additive',
      '  deny : 1000 (matched counts: 0)',
    ].join('\r\n');
    const v = verifyActivation(A.policy, legacy, pair, A.rt, labels, CONTRACT);
    expect(v.verified).toBe(false);
    expect(v.mitigationOk).toBe(false);
    expect(verifyActivation(A.policy, legacy, pair, A.rt, labels).verified).toBe(false);
  });

  it('readback rejeita node 2 com additive', () => {
    const text = DISPLAY_AFTER.replace(`      ${APPLY_RT}`, `      ${APPLY_RT} additive`);
    expect(verifyActivation(A.policy, text, pair, A.rt, labels, CONTRACT).verified).toBe(false);
  });

  it('readback rejeita node 2 com lista, LP ou clausula divergentes do contrato', () => {
    const lp = DISPLAY_AFTER.replace(
      '      apply local-preference 1100\r\n      apply extcommunity rt 268568:660',
      '      apply local-preference 100\r\n      apply extcommunity rt 268568:660',
    );
    expect(verifyActivation(A.policy, lp, pair, A.rt, labels, CONTRACT).verified).toBe(false);
    const list = DISPLAY_AFTER.replace(
      /(permit : 2[\s\S]*?if-match ip-prefix )\S+/,
      '$1PREFIX8to24',
    );
    expect(verifyActivation(A.policy, list, pair, A.rt, labels, CONTRACT).verified).toBe(false);
    const extra = DISPLAY_AFTER.replace(
      `      ${APPLY_RT}`,
      `      ${APPLY_RT}\r\n      apply community 65000:1`,
    );
    expect(verifyActivation(A.policy, extra, pair, A.rt, labels, CONTRACT).verified).toBe(false);
  });

  it('readback rejeita node 1 que nao e deny', () => {
    const text = DISPLAY_AFTER.replace('  deny : 1 (', '  permit : 1 (');
    const v = verifyActivation(A.policy, text, pair, A.rt, labels, CONTRACT);
    expect(v.verified).toBe(false);
    expect(v.bogonOk).toBe(false);
    expect(v.partial).toBe(true);
  });

  it('readback rejeita baseline alterado (node 10 sem RT140)', () => {
    const text = DISPLAY_AFTER.replace('rt 268568:140 additive', 'rt 268568:999 additive');
    expect(verifyActivation(A.policy, text, pair, A.rt, labels, CONTRACT).verified).toBe(false);
  });

  it('readback rejeita par incompleto (so o node de mitigacao)', () => {
    const withoutBogon = DISPLAY_AFTER.split('\r\n')
      .filter((line) => !/deny : 1 |if-match ip-prefix BOGONS/.test(line))
      .join('\r\n');
    const v = verifyActivation(A.policy, withoutBogon, pair, A.rt, labels, CONTRACT);
    expect(v.verified).toBe(false);
    expect(v.partial).toBe(true);
  });
});

describe('8) REMOVE manual restaura o estado original', () => {
  it('readback de retirada exige os dois nodes ausentes e baseline intacto', () => {
    expect(verifyRemoval(A.policy, BASELINE, pair).verified).toBe(true);
    const partial = [BASELINE, `route-policy ${A.policy} permit node 2`, ` ${APPLY_RT}`].join('\n');
    expect(verifyRemoval(A.policy, partial, pair).verified).toBe(false);
  });

  it('depois do REMOVE o prefixo volta ao node 10 com LP1100 e RTs originais', () => {
    expect(evaluate(BASELINE, '167.250.126.0/23', ['268568:330'])).toEqual({
      accepted: true,
      localPreference: 1100,
      rts: ['268568:330', '268568:140'],
      node: 10,
    });
  });
});

describe('9) outro cliente elegivel recebe o MESMO formato, com os SEUS valores', () => {
  const OUTRO_BASELINE = [
    'route-policy PL-FLASH-TELECOM_IPv4-IN permit node 10',
    ' if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
    ' apply local-preference 3000',
    ' apply extcommunity rt 268568:140',
    'route-policy PL-FLASH-TELECOM_IPv4-IN deny node 999',
  ].join('\n');
  const other = {
    policyName: 'PL-FLASH-TELECOM_IPv4-IN',
    bogonNode: 1,
    mitigationNode: 2,
    rt: '268568:660',
    bogonPrefixList: 'BOGONS',
    targetPrefixList: 'PREFIX8to24',
  };
  const derived = deriveMitigationNode2Contract(OUTRO_BASELINE, other.policyName);
  if (!derived.eligible) throw new Error('FLASH deve ser elegivel');

  it('FLASH (RT 140 sem additive): LP 3000 e a lista do proprio cliente', () => {
    expect(derived.contract).toMatchObject({
      prefixList: 'PREFIX-FLASHTELECOM-IPV4',
      localPreference: 3000,
      baselineRtAdditive: false,
      rtMode: 'REPLACE',
    });
    expect(buildMitigationActivateCommands(other, derived.contract)).toEqual([
      'system-view',
      'route-policy PL-FLASH-TELECOM_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-FLASH-TELECOM_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
      ' apply local-preference 3000',
      ' apply extcommunity rt 268568:660',
      'commit',
    ]);
  });

  it('qualquer par diferente de 1/2 e rejeitado antes da escrita', () => {
    for (const par of [
      { bogonNode: 3, mitigationNode: 4 },
      { bogonNode: 1, mitigationNode: 3 },
      { bogonNode: 5, mitigationNode: 6 },
    ]) {
      expect(() => buildMitigationActivateCommands({ ...other, ...par }, derived.contract)).toThrow(
        /MITIGATION_CONTRACT_MISMATCH/,
      );
    }
  });

  it('qualquer RT diferente de 268568:660 e rejeitada antes da escrita', () => {
    expect(() =>
      buildMitigationActivateCommands({ ...other, rt: '268568:661' }, derived.contract),
    ).toThrow(/MITIGATION_CONTRACT_MISMATCH/);
    expect(() =>
      buildMitigationRemovalCommands({
        policyName: other.policyName,
        bogonNode: 3,
        mitigationNode: 4,
      }),
    ).toThrow(/MITIGATION_CONTRACT_MISMATCH/);
  });

  it('o readback exige o node 2 derivado do PROPRIO cliente', () => {
    const display = [
      'Route-policy: PL-FLASH-TELECOM_IPv4-IN',
      '  deny : 1 (matched counts: 0)',
      '      if-match ip-prefix BOGONS',
      '  permit : 2 (matched counts: 0)',
      '      if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
      '      apply local-preference 3000',
      '      apply extcommunity rt 268568:660',
      '  permit : 10 (matched counts: 0)',
      '      if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
      '      apply local-preference 3000',
      '      apply extcommunity rt 268568:140',
      '  deny : 999 (matched counts: 0)',
    ].join('\r\n');
    expect(verifyActivation(other.policyName, display, pair, other.rt, other).verified).toBe(true);
    // LP da AGLINK (1100) num cliente de LP 3000 = node 2 divergente.
    const wrongLp = display.replace(
      'local-preference 3000\r\n      apply extcommunity rt 268568:660',
      'local-preference 1100\r\n      apply extcommunity rt 268568:660',
    );
    expect(verifyActivation(other.policyName, wrongLp, pair, other.rt, other).verified).toBe(false);
  });
});
