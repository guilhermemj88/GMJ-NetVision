import { describe, expect, it } from 'vitest';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { verifyActivation, verifyRemoval } from './mitigation-executor';
import { derivePreservedClauses } from './mitigation-policy-clauses';
import {
  buildMitigationActivateCommands,
  buildMitigationRemovalCommands,
} from './mitigation-write-guard';

/**
 * Contrato DEFINITIVO do ACTIVATE (IPv4, aprovado pelo operador).
 *
 * O par e SEMPRE nodes 1 e 2, sem derivacao de clausulas de node 10:
 *
 *   - node 1: deny   + SOMENTE `if-match ip-prefix BOGONS`;
 *   - node 2: permit irrestrito + SOMENTE `apply extcommunity rt 268568:660`.
 *
 * O node 2 NAO tem if-match, prefix-list, local-preference, `additive` nem
 * `goto`. Os atributos normais do cliente (LP/RTs do baseline) sao EVIDENCIA de
 * auditoria e nunca sao copiados para o node de mitigacao.
 *
 * Amplitude AUTORIZADA: como o node 2 casa antes do node 10 e nao tem if-match,
 * qualquer prefixo que nao seja BOGON passa no node 2 — inclusive prefixo fora
 * da lista do cliente. Esse e o comportamento aprovado, nao um defeito.
 */

const labels = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };
const pair = { bogonNode: 1, mitigationNode: 2 };
const plan = { policyName: A.policy, ...pair, rt: A.rt, ...labels };

const APPLY_RT = 'apply extcommunity rt 268568:660';

const CANONICAL_ACTIVATE = [
  'system-view',
  `route-policy ${A.policy} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${A.policy} permit node 2`,
  ` ${APPLY_RT}`,
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

/** Atributos normais do cliente, derivados do MESMO mecanismo usado em producao. */
const PRESERVED = derivePreservedClauses(BASELINE, A.policy, A.targetPrefixList, A.rt);

/** Baseline + o par criado pelo ACTIVATE, como aparece em `display route-policy`. */
const DISPLAY_AFTER = [
  `Route-policy: ${A.policy}`,
  '  deny : 1 (matched counts: 0)',
  '    Match clauses: ',
  '      if-match ip-prefix BOGONS',
  '  permit : 2 (matched counts: 3)',
  '    Apply clauses: ',
  `      ${APPLY_RT}`,
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
    expect(buildMitigationActivateCommands(plan, PRESERVED)).toEqual(CANONICAL_ACTIVATE);
  });

  it('nenhum comando referencia node 10 ou node 1000, nem remove nada', () => {
    const text = buildMitigationActivateCommands(plan, PRESERVED).join('\n');
    expect(text).not.toMatch(/node (10|1000)\b/);
    expect(text).not.toMatch(/\bundo\b/);
  });

  it('o node 2 nao carrega if-match, local-preference, additive nem goto', () => {
    const commands = buildMitigationActivateCommands(plan, PRESERVED);
    const header = commands.indexOf(`route-policy ${A.policy} permit node 2`);
    expect(header).toBeGreaterThan(-1);
    // Entre o header do node 2 e o commit existe SOMENTE a RT exclusiva.
    expect(commands.slice(header + 1, -1)).toEqual([` ${APPLY_RT}`]);
    expect(commands.slice(header).join('\n')).not.toMatch(
      /if-match|local-preference|additive|goto/,
    );
  });

  it('o REMOVE retira somente 1 e 2, sem deny/permit no undo', () => {
    expect(buildMitigationRemovalCommands({ policyName: A.policy, ...pair })).toEqual(
      CANONICAL_REMOVE,
    );
  });
});

describe('3-5) o node 2 casa primeiro: RT exclusiva e amplitude autorizada', () => {
  // Ordem de sequencia importa: 1 -> 2 -> 10 -> 1000.
  const DURING = [
    `route-policy ${A.policy} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${A.policy} permit node 2`,
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

  it('durante: node 2 casa e aplica SOMENTE a RT de mitigacao (sem repor LP/RTs)', () => {
    for (const prefix of ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24']) {
      expect(evaluate(DURING, prefix, ['268568:330'])).toEqual({
        accepted: true,
        // O node 2 nao reaplica atributos normais: LP volta ao default do peer
        // e a RT nao-additive SUBSTITUI a lista de extcommunities.
        localPreference: 100,
        rts: ['268568:660'],
        node: 2,
      });
    }
  });

  it('amplitude AUTORIZADA: prefixo fora da lista do cliente passa no node 2', () => {
    for (const prefix of ['198.51.100.0/24', '167.250.126.0/25']) {
      expect(evaluate(DURING, prefix, ['268568:330'])).toMatchObject({
        accepted: true,
        node: 2,
        rts: ['268568:660'],
      });
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
  it('readback do estado ativado e verificado', () => {
    expect(verifyActivation(A.policy, DISPLAY_AFTER, pair, A.rt, labels, PRESERVED).verified).toBe(true);
  });

  it('readback rejeita node 2 com additive', () => {
    const text = DISPLAY_AFTER.replace(
      `      ${APPLY_RT}`,
      `      ${APPLY_RT} additive`,
    );
    expect(verifyActivation(A.policy, text, pair, A.rt, labels, PRESERVED).verified).toBe(false);
  });

  it('readback rejeita node 2 com clausulas extras (if-match/local-preference)', () => {
    const comIfMatch = DISPLAY_AFTER.replace(
      `      ${APPLY_RT}`,
      `      if-match ip-prefix ${A.targetPrefixList}\r\n      ${APPLY_RT}`,
    );
    expect(verifyActivation(A.policy, comIfMatch, pair, A.rt, labels, PRESERVED).verified).toBe(
      false,
    );
    const comLocalPreference = DISPLAY_AFTER.replace(
      `      ${APPLY_RT}`,
      `      apply local-preference 1100\r\n      ${APPLY_RT}`,
    );
    expect(
      verifyActivation(A.policy, comLocalPreference, pair, A.rt, labels, PRESERVED).verified,
    ).toBe(false);
  });

  it('readback rejeita node 1 que nao e deny', () => {
    const text = DISPLAY_AFTER.replace('  deny : 1 (', '  permit : 1 (');
    const v = verifyActivation(A.policy, text, pair, A.rt, labels, PRESERVED);
    expect(v.verified).toBe(false);
    expect(v.bogonOk).toBe(false);
    expect(v.partial).toBe(true);
  });

  it('readback rejeita baseline alterado (node 10 sem RT140)', () => {
    const text = DISPLAY_AFTER.replace('rt 268568:140 additive', 'rt 268568:999 additive');
    expect(verifyActivation(A.policy, text, pair, A.rt, labels, PRESERVED).verified).toBe(false);
  });

  it('readback rejeita par incompleto (so o node de mitigacao)', () => {
    const withoutBogon = DISPLAY_AFTER.split('\r\n')
      .filter((line) => !/deny : 1|node 1|if-match ip-prefix BOGONS/.test(line))
      .join('\r\n');
    const v = verifyActivation(A.policy, withoutBogon, pair, A.rt, labels, PRESERVED);
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
      ` ${APPLY_RT}`,
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

describe('9) CONTRATO UNICO: qualquer policy recebe o mesmo par e a mesma RT', () => {
  // Policy de outro cliente: prefixo, LP e RT totalmente diferentes da AGLINK.
  const OUTRO_BASELINE = [
    'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ' if-match ip-prefix PREFIX-HORIZONTES-IPV4',
    ' apply local-preference 4000',
    ' apply extcommunity rt 268568:110 additive',
    'route-policy PL-HORIZONTES_IPv4-IN permit node 50',
    ' if-match ip-prefix PREFIX-OUTRO-CLIENTE',
    ' apply local-preference 200',
  ].join('\n');
  const other = {
    policyName: 'PL-HORIZONTES_IPv4-IN',
    bogonNode: 1,
    mitigationNode: 2,
    rt: '268568:660',
    bogonPrefixList: 'BOGONS',
    targetPrefixList: 'PREFIX-HORIZONTES-IPV4',
  };
  const preserved = derivePreservedClauses(
    OUTRO_BASELINE,
    other.policyName,
    other.targetPrefixList,
    other.rt,
  );

  it('gera o MESMO par, com BOGONS e a RT exclusiva, sem copiar atributos do cliente', () => {
    expect(buildMitigationActivateCommands(other, preserved)).toEqual([
      'system-view',
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' apply extcommunity rt 268568:660',
      'commit',
    ]);
  });

  it('o baseline derivado (LP/RT do cliente) e evidencia: nao altera os comandos', () => {
    expect(buildMitigationActivateCommands(other, preserved)).toEqual(
      buildMitigationActivateCommands(other),
    );
  });

  it('qualquer par diferente de 1/2 e rejeitado antes da escrita', () => {
    for (const par of [
      { bogonNode: 3, mitigationNode: 4 },
      { bogonNode: 1, mitigationNode: 3 },
      { bogonNode: 5, mitigationNode: 6 },
    ]) {
      expect(() => buildMitigationActivateCommands({ ...other, ...par })).toThrow(
        /MITIGATION_CONTRACT_MISMATCH/,
      );
    }
  });

  it('qualquer RT diferente de 268568:660 e rejeitada antes da escrita', () => {
    expect(() => buildMitigationActivateCommands({ ...other, rt: '268568:661' })).toThrow(
      /MITIGATION_CONTRACT_MISMATCH/,
    );
    expect(() =>
      buildMitigationRemovalCommands({ policyName: other.policyName, bogonNode: 3, mitigationNode: 4 }),
    ).toThrow(/MITIGATION_CONTRACT_MISMATCH/);
  });

  it('o readback de outro cliente exige somente o par 1/2 (nodes 10/1000 so na AGLINK)', () => {
    const display = [
      'Route-policy: PL-HORIZONTES_IPv4-IN',
      '  deny : 1 (matched counts: 0)',
      '      if-match ip-prefix BOGONS',
      '  permit : 2 (matched counts: 0)',
      '      apply extcommunity rt 268568:660',
      '  permit : 11 (matched counts: 0)',
      '      if-match ip-prefix PREFIX-HORIZONTES-IPV4',
      '      apply local-preference 4000',
      '      apply extcommunity rt 268568:110 additive',
    ].join('\r\n');
    const pair2 = { bogonNode: 1, mitigationNode: 2 };
    expect(verifyActivation(other.policyName, display, pair2, other.rt, other, preserved).verified).toBe(
      true,
    );
    expect(
      verifyActivation(
        other.policyName,
        display.replace(
          '      apply extcommunity rt 268568:660',
          '      apply extcommunity rt 268568:660 additive',
        ),
        pair2,
        other.rt,
        other,
        preserved,
      ).verified,
    ).toBe(false);
  });
});
