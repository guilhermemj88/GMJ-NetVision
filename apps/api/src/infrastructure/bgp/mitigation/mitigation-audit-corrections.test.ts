import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiMitigationExecutor } from './huawei-mitigation-executor';
import type { MitigationSshPort } from './huawei-mitigation-executor';
import { buildMitigationActivateCommands } from './mitigation-write-guard';
import { derivePreservedClauses } from './mitigation-policy-clauses';

/**
 * Correções da auditoria do Claude (fail-closed no preflight).
 *
 * Regras travadas aqui:
 *  - sem baseline derivavel nao existe ACTIVATE  -> MITIGATION_BASELINE_NOT_DERIVABLE
 *  - baseline cuja estrutura nao reproduzimos    -> MITIGATION_BASELINE_UNSAFE
 *  - node 1/2 ocupados seguem bloqueados
 *  - preview e escrita sao exatamente os mesmos comandos
 */

const DEVICE_ID = 'host-f1a';
const POLICY = 'PL-TEST_IPv4-IN';
const RT = '268568:660';

function device(): HostRecord {
  return {
    id: DEVICE_ID,
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
  } as unknown as HostRecord;
}

class FakeSsh implements MitigationSshPort {
  readonly applied: string[][] = [];
  constructor(public routePolicyConfiguration: string) {}
  async readMitigationConfiguration() {
    return {
      routePolicyConfiguration: this.routePolicyConfiguration,
      prefixListConfiguration: [
        'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8',
        'ip ip-prefix PREFIX8to24 index 10 permit 10.200.200.0 24',
      ].join('\n'),
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    return this.routePolicyConfiguration;
  }
  async applyMitigationCommands(_host: HostRecord, commands: readonly string[]) {
    this.applied.push([...commands]);
    return { ok: true, output: 'simulated' };
  }
}

function executor(ssh: FakeSsh): HuaweiMitigationExecutor {
  return new HuaweiMitigationExecutor({
    ssh,
    config: {
      executor: 'HUAWEI',
      liveWriteEnabled: true,
      allowedDeviceIds: [DEVICE_ID],
    },
    rt: RT,
  });
}

const input = {
  mode: 'ACTIVATE' as const,
  policyName: POLICY,
  bogonNode: 1,
  mitigationNode: 2,
  rt: RT,
  bogonPrefixList: 'BOGONS',
  targetPrefixList: 'PREFIX8to24',
  expectedExistingNodes: null as number[] | null,
};

const AGLINK_SIMPLE = [
  `route-policy ${POLICY} permit node 10`,
  ' if-match ip-prefix PREFIX8to24',
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  `route-policy ${POLICY} deny node 1000`,
].join('\n');

const check = (id: string, result: { checks: { id: string; ok: boolean; detail: string }[] }) =>
  result.checks.find((entry) => entry.id === id);

describe('1) baseline ausente bloqueia', () => {
  it('policy sem node que cobre os prefixos: MITIGATION_BASELINE_NOT_DERIVABLE e nada escrito', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix OUTRA-LISTA',
        ' apply local-preference 500',
        `route-policy ${POLICY} deny node 1000`,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.ok).toBe(false);
    expect(check('preserved_attributes', result)?.detail).toContain(
      'MITIGATION_BASELINE_NOT_DERIVABLE',
    );
    expect(ssh.applied).toHaveLength(0);
  });

  it('policy totalmente vazia tambem bloqueia', async () => {
    const ssh = new FakeSsh('');
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.ok).toBe(false);
    expect(result.preservedClauses?.baselineNode).toBeNull();
  });
});

describe('2-4) baseline nao reproduzivel bloqueia', () => {
  it('2) if-match adicional no node original', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix PREFIX8to24',
        ' if-match community-filter CLIENTE-X',
        ' apply local-preference 1100',
        `route-policy ${POLICY} deny node 1000`,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.ok).toBe(false);
    const detail = check('preserved_attributes', result)?.detail ?? '';
    expect(detail).toContain('MITIGATION_BASELINE_UNSAFE');
    expect(detail).toContain('if-match adicional');
    expect(ssh.applied).toHaveLength(0);
  });

  it('3) goto no node original', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix PREFIX8to24',
        ' goto 50',
        `route-policy ${POLICY} deny node 1000`,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.ok).toBe(false);
    expect(check('preserved_attributes', result)?.detail).toContain('goto');
  });

  it('3b) apply sem semantica reproduzivel', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply traffic-index 7',
        `route-policy ${POLICY} deny node 1000`,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.ok).toBe(false);
    expect(check('preserved_attributes', result)?.detail).toContain('sem semantica reproduzivel');
  });

  it('4) node anterior catch-all pode capturar as rotas antes do baseline', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} permit node 5`,
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply local-preference 1100',
        `route-policy ${POLICY} deny node 1000`,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.ok).toBe(false);
    expect(check('preserved_attributes', result)?.detail).toContain('pode capturar as rotas antes');
    expect(ssh.applied).toHaveLength(0);
  });

  it('4b) node anterior com a MESMA prefix-list vira o proprio baseline (nao bloqueia)', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} permit node 5`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply local-preference 200',
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply local-preference 1100',
        `route-policy ${POLICY} deny node 1000`,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.preservedClauses).toMatchObject({ baselineNode: 5, safe: true });
  });
});

describe('5) AGLINK simples continua aprovada', () => {
  it('deriva LP e RT do baseline e aprova o preflight', async () => {
    const ssh = new FakeSsh(AGLINK_SIMPLE);
    const result = await executor(ssh).preflight(device(), {
      ...input,
      expectedExistingNodes: [10, 1000],
    });
    expect(result.ok).toBe(true);
    expect(result.preservedClauses).toMatchObject({
      baselineNode: 10,
      baselineMatch: 'PREFIX_LIST',
      safe: true,
      localPreference: 'apply local-preference 1100',
      routeTargets: ['268568:140'],
    });
    expect(result.preservedClauses?.expectedClauses).toEqual([
      'if-match ip-prefix PREFIX8to24',
      'apply local-preference 1100',
      'apply extcommunity rt 268568:140 rt 268568:660 additive',
    ]);
  });
});

describe('8) preview e escrita sao identicos', () => {
  it('as mesmas preservadas geram os mesmos comandos no preview e na escrita', async () => {
    const ssh = new FakeSsh(AGLINK_SIMPLE);
    const result = await executor(ssh).preflight(device(), { ...input });
    const preserved = result.preservedClauses!;
    const preview = buildMitigationActivateCommands(
      {
        policyName: POLICY,
        bogonNode: 1,
        mitigationNode: 2,
        rt: RT,
        bogonPrefixList: 'BOGONS',
        targetPrefixList: 'PREFIX8to24',
      },
      preserved,
    );
    await executor(ssh).activate(device(), { ...input, preservedClauses: preserved });
    expect(ssh.applied).toHaveLength(1);
    expect(ssh.applied[0]).toEqual(preview);
  });

  it('a escrita SEM preserved (plano divergente) nunca coincide com o preview aprovado', () => {
    const preserved = derivePreservedClauses(AGLINK_SIMPLE, POLICY, 'PREFIX8to24', RT);
    const plan = {
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
      rt: RT,
      bogonPrefixList: 'BOGONS',
      targetPrefixList: 'PREFIX8to24',
    };
    expect(buildMitigationActivateCommands(plan, preserved)).not.toEqual(
      buildMitigationActivateCommands(plan),
    );
  });
});

describe('9) nodes 1/2 ocupados continuam bloqueados', () => {
  it('nao sobrescreve e nao escreve', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix CLIENTE-BLOQUEADO',
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix OPERADOR',
        AGLINK_SIMPLE,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input });
    expect(result.ok).toBe(false);
    expect(result.nodeOccupancy).toMatchObject({
      status: 'FULLY_OCCUPIED',
      blocked: true,
      conflictingNodes: [1, 2],
    });
    expect(ssh.applied).toHaveLength(0);
  });
});

describe('10) REMOVE nao sofre regressao', () => {
  it('continua retirando somente o par, com commit', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        AGLINK_SIMPLE,
      ].join('\n'),
    );
    await executor(ssh).remove(device(), { policyName: POLICY, bogonNode: 1, mitigationNode: 2 });
    expect(ssh.applied[0]).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  // Baseline do cliente com a MESMA lista autorizada e SEM a RT de mitigacao:
  // e o node normal da policy (nunca propriedade temporaria). Sem reconhece-lo
  // a retirada ficaria travada em TODA policy de cliente.
  const ACTIVATED_WITH_BASELINE = [
    `route-policy ${POLICY} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${POLICY} permit node 2`,
    ' if-match ip-prefix PREFIX8to24',
    ' apply local-preference 1100',
    ' apply extcommunity rt 268568:140 rt 268568:660 additive',
    AGLINK_SIMPLE,
  ].join('\n');

  it('baseline com a mesma prefix-list e sem a RT de mitigacao nao bloqueia a retirada', async () => {
    const ssh = new FakeSsh(ACTIVATED_WITH_BASELINE);
    const result = await executor(ssh).preflight(device(), { ...input, mode: 'REMOVE' });

    expect(check('policy_mitigation_scope', result)?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('segundo par instalado na policy continua bloqueando a retirada', async () => {
    const ssh = new FakeSsh(
      [
        ACTIVATED_WITH_BASELINE,
        `route-policy ${POLICY} deny node 3`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 4`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    expect(check('policy_mitigation_scope', result)?.ok ?? false).toBe(false);
    expect(ssh.applied).toHaveLength(0);
  });

  it('node com a prefix-list e COM a RT de mitigacao nunca vira baseline (ambiguidade)', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 2`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    expect(check('policy_mitigation_scope', result)?.ok ?? false).toBe(false);
  });
});
