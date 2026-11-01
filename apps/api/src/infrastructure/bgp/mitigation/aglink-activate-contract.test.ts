import { describe, expect, it } from 'vitest';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import {
  buildMitigationActivateCommands,
  buildMitigationRemovalCommands,
} from './mitigation-write-guard';

/**
 * Contrato DEFINITIVO do ACTIVATE da AGLINK.
 *
 * Regra do VRP8 que governa tudo aqui: a route-policy termina no PRIMEIRO node
 * que casa. Quando o node 2 (mitigacao) casa, o node 10 NAO roda — entao o node
 * 2 precisa repor, sozinho, o que o node 10 fazia e apenas ACRESCENTAR a RT de
 * mitigacao:
 *
 *   - LP 1100        -> reaplicado explicitamente;
 *   - RT 268568:140  -> reaplicada (vinha do node 10);
 *   - RT 268568:330  -> preservada porque `additive` nao substitui o que ja veio
 *                       do peer;
 *   - RT 268568:660  -> acrescentada (marca a rota para o mitigador).
 *
 * Forma fisica validada no BHE-VTA-F1A (VRP 8.220): o equipamento NAO usa duas
 * linhas `apply extcommunity` no mesmo node (0 ocorrencias) e usa a forma
 * multi-RT numa unica instrucao (`apply extcommunity rt A rt B additive`,
 * 1 ocorrencia real em 1047 linhas de route-policy).
 */

const labels = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };
const pair = { bogonNode: 1, mitigationNode: 2 };
const plan = { policyName: A.policy, ...pair, rt: A.rt, ...labels };

const APPLY_BOTH = 'apply extcommunity rt 268568:140 rt 268568:660 additive';

const CANONICAL_ACTIVATE = [
  'system-view',
  `route-policy ${A.policy} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${A.policy} permit node 2`,
  ` if-match ip-prefix ${A.targetPrefixList}`,
  ' apply local-preference 1100',
  ` ${APPLY_BOTH}`,
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

/** Baseline fisico atual (nodes 10 e 1000), formato de configuracao. */
const BASELINE = [
  `route-policy ${A.policy} permit node 10`,
  ` if-match ip-prefix ${A.targetPrefixList}`,
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  `route-policy ${A.policy} deny node 1000`,
].join('\n');

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
  `      ${APPLY_BOTH}`,
  '  permit : 10 (matched counts: 77)',
  '    Match clauses: ',
  `      if-match ip-prefix ${A.targetPrefixList}`,
  '    Apply clauses: ',
  '      apply local-preference 1100',
  '      apply extcommunity rt 268568:140 additive',
  '  deny : 1000 (matched counts: 0)',
].join('\r\n');

describe('1-2) criacao dos nodes 1 e 2 sem tocar em 10/1000', () => {
  it('gera exatamente a lista canonica do ACTIVATE', () => {
    expect(buildMitigationActivateCommands(plan)).toEqual(CANONICAL_ACTIVATE);
  });

  it('nenhum comando referencia node 10 ou node 1000, nem remove nada', () => {
    const text = buildMitigationActivateCommands(plan).join('\n');
    expect(text).not.toMatch(/node (10|1000)\b/);
    expect(text).not.toMatch(/\bundo\b/);
  });

  it('usa UMA instrucao apply extcommunity (forma fisica do equipamento)', () => {
    const applies = buildMitigationActivateCommands(plan).filter((line) =>
      line.includes('apply extcommunity'),
    );
    expect(applies).toHaveLength(1);
    expect(applies[0]!.trim()).toBe(APPLY_BOTH);
  });

  it('o REMOVE retira somente 1 e 2, sem deny/permit no undo', () => {
    expect(buildMitigationRemovalCommands({ policyName: A.policy, ...pair })).toEqual(
      CANONICAL_REMOVE,
    );
  });
});

describe('3-5) LP1100 preservado, RT660 acrescentada, RT140 e RT330 mantidas', () => {
  // Ordem de sequencia importa: 1 -> 2 -> 10 -> 1000.
  const DURING = [
    `route-policy ${A.policy} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${A.policy} permit node 2`,
    ` if-match ip-prefix ${A.targetPrefixList}`,
    ' apply local-preference 1100',
    ` ${APPLY_BOTH}`,
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

  it('durante: node 2 casa preservando LP1100, RT140 e RT330 e acrescentando RT660', () => {
    for (const prefix of ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24']) {
      expect(evaluate(DURING, prefix, ['268568:330'])).toEqual({
        accepted: true,
        localPreference: 1100,
        rts: ['268568:330', '268568:140', '268568:660'],
        node: 2,
      });
    }
  });

  it('prefixos fora do escopo continuam caindo no deny 1000', () => {
    expect(evaluate(DURING, '198.51.100.0/24', ['268568:330'])).toMatchObject({
      accepted: false,
      node: 1000,
    });
    expect(evaluate(DURING, '167.250.126.0/25', ['268568:330']).accepted).toBe(false);
  });
});

describe('6-7) readback fisico e bloqueio de divergencias', () => {
  it('readback do estado ativado e verificado', () => {
    expect(verifyActivation(A.policy, DISPLAY_AFTER, pair, A.rt, labels).verified).toBe(true);
  });

  it('readback rejeita RT660 sem additive (substituiria RT140/RT330)', () => {
    const text = DISPLAY_AFTER.replace('rt 268568:660 additive', 'rt 268568:660');
    expect(verifyActivation(A.policy, text, pair, A.rt, labels).verified).toBe(false);
  });

  it('readback rejeita RT140 ausente no node de mitigacao', () => {
    const text = DISPLAY_AFTER.replace(APPLY_BOTH, 'apply extcommunity rt 268568:660 additive');
    const v = verifyActivation(A.policy, text, pair, A.rt, labels);
    expect(v.verified).toBe(false);
    expect(v.summary).toContain('AGLINK');
  });

  it('readback rejeita prefix-list alvo trocada', () => {
    const text = DISPLAY_AFTER.replace(
      `if-match ip-prefix ${A.targetPrefixList}`,
      'if-match ip-prefix PREFIX8to24',
    );
    expect(verifyActivation(A.policy, text, pair, A.rt, labels).verified).toBe(false);
  });

  it('readback rejeita baseline alterado (node 10 sem RT140)', () => {
    const text = DISPLAY_AFTER.replace('rt 268568:140 additive', 'rt 268568:999 additive');
    expect(verifyActivation(A.policy, text, pair, A.rt, labels).verified).toBe(false);
  });

  it('readback rejeita par incompleto (so o node de mitigacao)', () => {
    const withoutBogon = DISPLAY_AFTER.split('\r\n')
      .filter((line) => !/deny : 1|node 1|if-match ip-prefix BOGONS/.test(line))
      .join('\r\n');
    const v = verifyActivation(A.policy, withoutBogon, pair, A.rt, labels);
    expect(v.verified).toBe(false);
    expect(v.partial).toBe(true);
  });
});

describe('8) REMOVE manual restaura o estado original', () => {
  it('readback de retirada exige os dois nodes ausentes e baseline intacto', () => {
    expect(verifyRemoval(A.policy, BASELINE, pair).verified).toBe(true);
    const partial = [
      BASELINE,
      `route-policy ${A.policy} permit node 2`,
      ` if-match ip-prefix ${A.targetPrefixList}`,
      ` ${APPLY_BOTH}`,
    ].join('\n');
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

describe('9) clientes com politica diferente nao herdam LP/RT da AGLINK', () => {
  const other = {
    policyName: 'PL-HORIZONTES_IPv4-IN',
    bogonNode: 1,
    mitigationNode: 2,
    rt: '9999:1',
    ...labels,
  };

  it('sem `apply local-preference` e com `additive`', () => {
    const commands = buildMitigationActivateCommands(other);
    expect(commands.join('\n')).not.toContain('local-preference');
    expect(commands).toContain(' apply extcommunity rt 9999:1 additive');
    expect(commands.join('\n')).not.toContain('268568');
  });

  it('o guard rejeita RT diferente da planejada quando a policy e a da AGLINK', () => {
    expect(() => buildMitigationActivateCommands({ ...plan, rt: '268568:999' })).toThrow(
      'AGLINK_MITIGATION_RT_MISMATCH',
    );
  });
});
