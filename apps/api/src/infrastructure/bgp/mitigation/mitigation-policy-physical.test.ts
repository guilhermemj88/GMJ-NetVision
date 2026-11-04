import { describe, expect, it } from 'vitest';
import { inspectPolicyMitigation } from './mitigation-policy-physical';

const POLICY = 'PL-CLIENTE_IPv4-IN';
const RT = '268568:660';

const inspect = (readBack: string, policyName = POLICY) =>
  inspectPolicyMitigation({ policyName, readBack, rts: [RT] });

const header = (action: 'deny' | 'permit', node: number) =>
  `route-policy ${POLICY} ${action} node ${node}`;
const rtLine = ` apply extcommunity rt ${RT}`;

const EXACT_PAIR = [
  header('deny', 1),
  ' if-match ip-prefix BOGONS',
  header('permit', 2),
  rtLine,
  header('permit', 10),
  ' if-match ip-prefix CLIENTE-BLOCO',
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  header('deny', 1000),
].join('\n');

describe('inspectPolicyMitigation — nodes 1/2 reservados pelo contrato IPv4', () => {
  it('par exato: deny BOGONS no node 1 + permit com RT660 no node 2', () => {
    expect(inspect(EXACT_PAIR)).toMatchObject({
      recognized: true,
      state: 'MITIGATED',
      bogonNodes: [1],
      mitigationNodes: [2],
      partialNodes: [],
      pair: { bogonNode: 1, mitigationNode: 2 },
    });
  });

  it('somente node 1 canonico: parcial, exige reconciliacao', () => {
    const text = [header('deny', 1), ' if-match ip-prefix BOGONS'].join('\n');
    expect(inspect(text)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      bogonNodes: [1],
      mitigationNodes: [],
      pair: null,
    });
  });

  it('somente node 2 canonico: parcial, exige reconciliacao', () => {
    const text = [header('permit', 2), rtLine].join('\n');
    expect(inspect(text)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      bogonNodes: [],
      mitigationNodes: [2],
      pair: null,
    });
  });

  const invalidCases: Array<[string, string[]]> = [
    ['node 1 sem if-match', [header('deny', 1)]],
    ['node 1 com lista diferente', [header('deny', 1), ' if-match ip-prefix OUTRA']],
    ['node 1 permit', [header('permit', 1), ' if-match ip-prefix BOGONS']],
    ['node 2 com if-match', [header('permit', 2), ' if-match ip-prefix CLIENTE', rtLine]],
    [
      'node 2 com local-preference',
      [header('permit', 2), ' apply local-preference 1100', rtLine],
    ],
    ['node 2 com additive', [header('permit', 2), ` apply extcommunity rt ${RT} additive`]],
    ['node 2 com RT extra', [header('permit', 2), ` apply extcommunity rt ${RT} rt 268568:140`]],
    ['node 2 com BOGONS', [header('permit', 2), ' if-match ip-prefix BOGONS']],
    ['node 2 sem RT', [header('permit', 2)]],
    ['node 2 deny', [header('deny', 2)]],
  ];

  it.each(invalidCases)('%s: node reservado ocupado fora do contrato', (_label, lines) => {
    const result = inspect(lines.join('\n'));
    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.pair).toBeNull();
    expect(
      result.partialNodes.length + result.bogonNodes.length + result.mitigationNodes.length,
    ).toBeGreaterThan(0);
  });

  it('RT660 em node permanente NAO e ownership: CLICKING/HORIZONTES e RT660 sem if-match continuam NORMAL', () => {
    // Formas REAIS dos snapshots (03/11): CLICKING node 50 e HORIZONTES node 11.
    const clicking = [
      header('permit', 50),
      ' if-match ip-prefix PREFIX-DUALNET-V4',
      ' apply local-preference 4000',
      rtLine,
      header('permit', 100),
      ' if-match ip-prefix PREFIX-CLICKING-IPV4',
      ' apply local-preference 4000',
      ' apply extcommunity rt 268568:140 additive',
    ].join('\n');
    expect(inspect(clicking)).toMatchObject({ state: 'NORMAL', pair: null, partialNodes: [] });

    const horizontes = [
      header('permit', 11),
      ' if-match ip-prefix PREFIX-HORIZONTES-IPV4',
      ' apply local-preference 4000',
      ' apply extcommunity rt 268568:140',
      header('deny', 50),
    ].join('\n');
    expect(inspect(horizontes)).toMatchObject({ state: 'NORMAL', pair: null, partialNodes: [] });

    // RT660 sozinha, sem if-match nenhum: continua sendo configuracao permanente
    // do cliente. Fica apenas INFORMATIVA, nunca bloqueia.
    const rtOnly = inspect([header('permit', 50), rtLine].join('\n'));
    expect(rtOnly.state).toBe('NORMAL');
    expect(rtOnly.pair).toBeNull();
    expect(rtOnly.partialNodes).toEqual([]);
    expect(rtOnly.ambiguousNodes).toEqual([expect.objectContaining({ node: 50 })]);

    // Um `deny BOGONS` cedo tambem e politica legitima do cliente.
    const bogonOnly = [
      header('permit', 10),
      ' if-match ip-prefix BOGONS',
      header('deny', 1000),
    ].join('\n');
    expect(inspect(bogonOnly)).toMatchObject({ state: 'NORMAL', pair: null, partialNodes: [] });
  });

  it('meio-par legado IDENTIFICAVEL (assinatura do contrato antigo) bloqueia', () => {
    // if-match da prefix-list de ALVOS de mitigacao + RT no mesmo node, sem o
    // BOGONS: essa combinacao e a assinatura do node 2 antigo, nao politica comum.
    const halfLegacy = [
      header('permit', 6),
      ' if-match ip-prefix PREFIX8to24',
      rtLine,
    ].join('\n');
    const result = inspect(halfLegacy);
    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.pair).toBeNull();
    expect(result.partialNodes).toEqual([
      expect.objectContaining({ node: 6, reason: expect.stringContaining('half-legacy') }),
    ]);
  });

  it('par legado completo fora de 1/2 bloqueia', () => {
    const legacyPair = [
      header('deny', 5),
      ' if-match ip-prefix BOGONS',
      header('permit', 6),
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${RT} additive`,
    ].join('\n');
    const result = inspect(legacyPair);
    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.partialNodes.map((entry) => entry.node).sort()).toEqual([5, 6]);
    expect(result.partialNodes.every((entry) => entry.reason === 'mitigation pair outside nodes 1/2')).toBe(true);
  });

  it('node 0 bloqueia a policy: precedencia nao autorizada sobre o par reservado', () => {
    const text = [
      header('permit', 0),
      header('deny', 1),
      ' if-match ip-prefix BOGONS',
      header('permit', 2),
      rtLine,
    ].join('\n');
    const result = inspect(text);
    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.pair).toBeNull();
    expect(result.precedenceNodes).toEqual([0]);
    expect(result.partialNodes).toEqual([
      expect.objectContaining({ node: 0, action: 'permit' }),
    ]);
  });

  it('policy ausente no read-back nao e conclusiva', () => {
    expect(inspect('route-policy OUTRA permit node 10', POLICY)).toMatchObject({
      recognized: false,
      state: 'RECONCILIATION_REQUIRED',
      pair: null,
    });
  });

  it('nodes 1 e 3 (par fora do contrato) nao viram MITIGATED', () => {
    const text = [header('deny', 1), ' if-match ip-prefix BOGONS', header('permit', 3), rtLine].join(
      '\n',
    );
    const result = inspect(text);
    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.mitigationNodes).toEqual([]);
    expect(result.pair).toBeNull();
  });
});
