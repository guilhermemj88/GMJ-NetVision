import { describe, expect, it } from 'vitest';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import { buildMitigationActivateCommands, buildMitigationRemovalCommands } from './mitigation-write-guard';

/**
 * Contrato FISICO do ACTIVATE da AGLINK.
 *
 * Regra do VRP8 que governa tudo aqui: a route-policy termina no PRIMEIRO node
 * que casa. Quando o node 2 (mitigacao) casa, o node 10 NAO roda. Por isso o
 * node 2 precisa repor, sozinho, tudo o que o node 10 fazia.
 *
 * O que ele repoe: `local-preference 1100`.
 * O que ele NAO repoe (de proposito): as extended communities normais
 * (RT 268568:140 aplicada pelo node 10; RT 268568:330 recebida do peer).
 *
 * Substituir o conjunto de RTs e o MECANISMO da mitigacao, nao um efeito
 * colateral: as policies de exportacao dos provedores normais (SEMPRE, SEABORN,
 * SEABORN-BH, CIRION, TUDDO, VS-IX) NAO negam RT660 sozinha — o `deny 5` de
 * SEMPRE/SEABORN exige MITIGACAO **e** NO-EXPORT-<peer> (dois if-match = AND).
 * Se o prefixo mantivesse RT140, continuaria sendo anunciado a todos eles e o
 * trafego nunca seria desviado. Por isso `apply extcommunity rt 268568:660`
 * entra SEM `additive` no caso AGLINK.
 */

const labels = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };
const pair = { bogonNode: 1, mitigationNode: 2 };
const plan = { policyName: A.policy, ...pair, rt: A.rt, ...labels };

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

/** Modelo de referencia: primeiro node que casa, LP e RT add/replace. */
const AGLINK_SCOPE = new Set(['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24']);

function evaluate(config: string, prefix: string, incomingRts: string[]) {
  const result = { accepted: false, localPreference: 100, rts: [...incomingRts], node: 0 };
  for (const block of config.split(/(?=^route-policy )/m)) {
    const header = /^route-policy \S+ (permit|deny) node (\d+)$/.exec(block.trim().split('\n')[0]!);
    if (!header) continue;
    const list = /if-match ip-prefix (\S+)/.exec(block)?.[1];
    // AGLINK-BLOCO-TODO-23 = `167.250.126.0/23 ge 23 le 24`, ou seja exatamente
    // os tres prefixos do escopo (nenhum outro /23 ou /24 cabe na lista).
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
    for (const m of block.matchAll(/apply extcommunity rt (\d+:\d+)( additive)?/g)) {
      if (!m[2]) result.rts = [];
      if (!result.rts.includes(m[1]!)) result.rts.push(m[1]!);
    }
    return result;
  }
  return result;
}

/** Baseline fisico atual do equipamento (nodes 10 e 1000), formato `display`. */
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
  '      apply extcommunity rt 268568:660',
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

  it('nenhum comando referencia node 10 ou node 1000', () => {
    const text = buildMitigationActivateCommands(plan).join('\n');
    expect(text).not.toMatch(/node (10|1000)\b/);
    expect(text).not.toMatch(/\bundo\b/);
  });

  it('o REMOVE retira somente 1 e 2, sem deny/permit no undo', () => {
    expect(buildMitigationRemovalCommands(pair ? { policyName: A.policy, ...pair } : pair)).toEqual(
      CANONICAL_REMOVE,
    );
  });
});

describe('3-5) LP1100 mantido, RT660 adicionada, RTs normais substituidas', () => {
  // Ordem de sequencia importa: 1 -> 2 -> 10 -> 1000.
  const BEFORE = [
    `route-policy ${A.policy} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${A.policy} permit node 2`,
    ` if-match ip-prefix ${A.targetPrefixList}`,
    ' apply local-preference 1100',
    ' apply extcommunity rt 268568:660',
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

  it('durante: node 2 casa, LP1100 preservado e somente RT660 permanece', () => {
    for (const prefix of ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24']) {
      expect(evaluate(BEFORE, prefix, ['268568:330'])).toEqual({
        accepted: true,
        localPreference: 1100,
        rts: ['268568:660'],
        node: 2,
      });
    }
  });

  it('a RT660 e aplicada sem `additive` no caso AGLINK (unica forma de desviar)', () => {
    const commands = buildMitigationActivateCommands(plan);
    expect(commands).toContain(' apply extcommunity rt 268568:660');
    expect(commands).not.toContain(' apply extcommunity rt 268568:660 additive');
  });
  it('prefixos fora do escopo continuam caindo no deny 1000', () => {
    expect(evaluate(BEFORE, '198.51.100.0/24', ['268568:330'])).toMatchObject({
      accepted: false,
      node: 1000,
    });
    expect(evaluate(BEFORE, '167.250.126.0/25', ['268568:330']).accepted).toBe(false);
  });
});

describe('6-7) readback fisico e bloqueio de divergencias', () => {
  it('readback do estado ativado e verificado', () => {
    expect(verifyActivation(A.policy, DISPLAY_AFTER, pair, A.rt, labels).verified).toBe(true);
  });

  it('readback rejeita LP divergente', () => {
    const text = DISPLAY_AFTER.replace('apply local-preference 1100', 'apply local-preference 100');
    const v = verifyActivation(A.policy, text, pair, A.rt, labels);
    expect(v.verified).toBe(false);
    expect(v.summary).toContain('AGLINK');
  });

  it('readback rejeita RT140 sobrevivendo no node de mitigacao', () => {
    const text = DISPLAY_AFTER.replace(
      'apply extcommunity rt 268568:660',
      'apply extcommunity rt 268568:660 additive',
    );
    expect(verifyActivation(A.policy, text, pair, A.rt, labels).verified).toBe(false);
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
      ' apply extcommunity rt 268568:660',
    ].join('\n');
    expect(verifyRemoval(A.policy, partial, pair).verified).toBe(false);
    expect(verifyRemoval(A.policy, DISPLAY_AFTER.replace('1100', '100'), pair).verified).toBe(
      false,
    );
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
    expect(commands).toContain(` if-match ip-prefix ${other.targetPrefixList}`);
  });

  it('o guard rejeita RT diferente da planejada quando a policy e a da AGLINK', () => {
    expect(() => buildMitigationActivateCommands({ ...plan, rt: '268568:999' })).toThrow(
      'AGLINK_MITIGATION_RT_MISMATCH',
    );
  });
});
