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

  it('BOGONS em node permanente e legitimo, mas node com RT660 exclusiva fora de 1/2 e meio-par legado', () => {
    // Um `deny BOGONS` cedo e politica legitima do cliente.
    const bogonOnly = [
      header('permit', 10),
      ' if-match ip-prefix BOGONS',
      header('deny', 1000),
    ].join('\n');
    expect(inspect(bogonOnly)).toMatchObject({
      state: 'NORMAL',
      bogonNodes: [],
      mitigationNodes: [],
      partialNodes: [],
      pair: null,
    });

    // D9: so o node de mitigacao (RT660 exclusiva, sem o BOGONS) NAO e NORMAL —
    // e resquicio de mitigacao manual/antiga e nunca pode ser adotado.
    const halfLegacy = inspect([header('permit', 50), rtLine].join('\n'));
    expect(halfLegacy.state).toBe('RECONCILIATION_REQUIRED');
    expect(halfLegacy.pair).toBeNull();
    expect(halfLegacy.partialNodes).toEqual([
      expect.objectContaining({ node: 50, reason: expect.stringContaining('half-legacy') }),
    ]);

    // RT660 junto de outra RT nao e assinatura de mitigacao: node normal.
    const normalNode = [header('permit', 60), ` apply extcommunity rt ${RT} rt 268568:140`].join('\n');
    expect(inspect(normalNode).state).toBe('NORMAL');
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
