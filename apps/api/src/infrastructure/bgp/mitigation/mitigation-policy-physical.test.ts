import { describe, expect, it } from 'vitest';
import { inspectPolicyMitigation } from './mitigation-policy-physical';

// Unidade do INSPETOR FISICO (base do F2/F3). Ele e a unica fonte de
// classificacao de "policy mitigada" no preflight e no reconciler: NORMAL so
// com ZERO nodes de mitigacao; par completo e unico => MITIGATED; qualquer
// coisa parcial/suspeita/multipla => RECONCILIATION_REQUIRED.

const POLICY = 'PL-FLASH-TELECOM_IPv4-IN';
const RT = '268568:660';
const LABELS = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };

const inspect = (readBack: string, rts: string[] = [RT]) =>
  inspectPolicyMitigation({ policyName: POLICY, readBack, rts, labels: LABELS });

describe('inspectPolicyMitigation', () => {
  it('NORMAL: nenhum node referencia as listas de mitigacao', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} permit node 10`,
        `route-policy ${POLICY} permit node 7`,
        ' apply extcommunity rt 268568:660 additive',
        `route-policy ${POLICY} deny node 999`,
      ].join('\n'),
    );

    expect(result.recognized).toBe(true);
    expect(result.state).toBe('NORMAL');
    expect(result.pair).toBeNull();
    expect(result.bogonNodes).toEqual([]);
    expect(result.mitigationNodes).toEqual([]);
  });

  it('MITIGATED: exatamente UM par completo (deny BOGONS + permit alvos/RT)', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        `route-policy ${POLICY} permit node 10`,
      ].join('\n'),
    );

    expect(result.state).toBe('MITIGATED');
    expect(result.pair).toEqual({ bogonNode: 1, mitigationNode: 2 });
  });

  it('L) PARCIAL: apenas o node BOGONS => RECONCILIATION_REQUIRED', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 10`,
      ].join('\n'),
    );

    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.bogonNodes).toEqual([1]);
    expect(result.mitigationNodes).toEqual([]);
    expect(result.pair).toBeNull();
  });

  it('L2) PARCIAL: apenas o node de mitigacao => RECONCILIATION_REQUIRED', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        `route-policy ${POLICY} permit node 10`,
      ].join('\n'),
    );

    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.mitigationNodes).toEqual([2]);
    expect(result.bogonNodes).toEqual([]);
  });

  it('M) SUSPEITO: permit com BOGONS => RECONCILIATION_REQUIRED', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} permit node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 10`,
      ].join('\n'),
    );

    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.partialNodes).toHaveLength(1);
    expect(result.partialNodes[0]?.reason).toContain('BOGONS');
  });

  it('M2) SUSPEITO: deny com PREFIX8to24 => RECONCILIATION_REQUIRED', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} deny node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        `route-policy ${POLICY} permit node 10`,
      ].join('\n'),
    );

    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.partialNodes).toHaveLength(1);
  });

  it('K) MULTIPLO: dois pares completos => RECONCILIATION_REQUIRED', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        `route-policy ${POLICY} deny node 3`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 4`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
      ].join('\n'),
    );

    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.bogonNodes).toEqual([1, 3]);
    expect(result.mitigationNodes).toEqual([2, 4]);
  });

  it('O) RT diferente da do escopo => RECONCILIATION_REQUIRED (node suspeito)', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:999 additive',
      ].join('\n'),
    );

    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.partialNodes[0]?.reason).toContain('RT');
  });

  it('O2) par de OUTRA RT nao e confundido: RT do escopo tambem aceita', () => {
    const readBack = [
      `route-policy ${POLICY} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY} permit node 2`,
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:999 additive',
    ].join('\n');
    // Escopo cuja RT E a 268568:999: o mesmo read-back vira MITIGATED.
    const result = inspect(readBack, ['268568:999']);

    expect(result.state).toBe('MITIGATED');
    expect(result.pair).toEqual({ bogonNode: 1, mitigationNode: 2 });
  });

  it('N) read-back sem a policy => recognized=false e RECONCILIATION_REQUIRED', () => {
    const result = inspect('route-policy PL-OUTRA permit node 1');

    expect(result.recognized).toBe(false);
    expect(result.state).toBe('RECONCILIATION_REQUIRED');
    expect(result.detail).toContain('nao encontrada');
  });

  it('RT sem a prefix-list de alvos NAO e mitigacao (node normal da policy)', () => {
    const result = inspect(
      [
        `route-policy ${POLICY} permit node 5`,
        ' apply extcommunity rt 268568:660 additive',
        `route-policy ${POLICY} permit node 10`,
      ].join('\n'),
    );

    expect(result.state).toBe('NORMAL');
    expect(result.mitigationNodes).toEqual([]);
    expect(result.partialNodes).toEqual([]);
  });
});
