import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiMitigationExecutor } from './huawei-mitigation-executor';
import type { MitigationSshPort } from './huawei-mitigation-executor';
import { buildMitigationActivateCommands } from './mitigation-write-guard';
import { derivePreservedClauses } from './mitigation-policy-clauses';
import {
  captureMitigationBaseline,
  type MitigationBaselineStore,
} from './mitigation-baseline-record';
import { testDurableBaselineStore } from './mitigation-test-support';

/**
 * Correções da auditoria (fail-closed no preflight) alinhadas ao contrato IPv4
 * definitivo.
 *
 * Regras travadas aqui:
 *  - o contrato NAO depende de baseline derivavel nem copia atributos de nodes
 *    permanentes: node 2 = permit irrestrito + RT 268568:660
 *  - a forma do baseline do cliente nao reprova o ACTIVATE
 *  - node 1/2 ocupados seguem bloqueados
 *  - preview e escrita sao exatamente os mesmos comandos (lista canonica)
 *  - o registro DURAVEL e a unica evidencia usada pelo REMOVE
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

function executor(ssh: FakeSsh, baseline?: MitigationBaselineStore): HuaweiMitigationExecutor {
  return new HuaweiMitigationExecutor({
    ssh,
    config: {
      executor: 'HUAWEI',
      liveWriteEnabled: true,
      allowedDeviceIds: [DEVICE_ID],
    },
    rt: RT,
    baseline: baseline ?? testDurableBaselineStore(),
  });
}

/**
 * Executor com o registro DURAVEL do ACTIVATE (B5) gravado a partir do
 * read-back informado — equivale a uma mitigacao ativa registrada.
 */
async function executorWithBaseline(
  ssh: FakeSsh,
  readBack: string,
): Promise<HuaweiMitigationExecutor> {
  const baseline = testDurableBaselineStore();
  const record = captureMitigationBaseline({
    deviceId: DEVICE_ID,
    policyName: POLICY,
    readBack,
    bogonNode: 1,
    mitigationNode: 2,
  });
  if (!record) throw new Error('fixture sem baseline');
  await baseline.save(record);
  return executor(ssh, baseline);
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

describe('1) baseline derivavel nao e pre-requisito do contrato', () => {
  it('node 10 com outra prefix-list nao bloqueia e nada e copiado', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix OUTRA-LISTA',
        ' apply local-preference 500',
        `route-policy ${POLICY} deny node 1000`,
      ].join('\n'),
    );
    const result = await executor(ssh).preflight(device(), {
      ...input,
      expectedExistingNodes: [10, 1000],
    });

    expect(result.ok).toBe(true);
    expect(result.preservedClauses).toBeNull();
    expect(result.baselineRecord?.nodes.map((entry) => entry.node)).toEqual([10, 1000]);
    expect(ssh.applied).toHaveLength(0);
  });

  it('policy totalmente vazia tambem bloqueia', async () => {
    const ssh = new FakeSsh('');
    const result = await executor(ssh).preflight(device(), { ...input });

    expect(result.ok).toBe(false);
    expect(result.preservedClauses).toBeNull();
  });
});

const CANONICAL_ACTIVATE_COMMANDS = [
  'system-view',
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' apply extcommunity rt 268568:660',
  'commit',
];

const BASELINE_SHAPES = [
  {
    nome: 'if-match adicional no node original',
    expectedExistingNodes: [10, 1000],
    readBack: [
      `route-policy ${POLICY} permit node 10`,
      ' if-match ip-prefix PREFIX8to24',
      ' if-match community-filter CLIENTE-X',
      ' apply local-preference 1100',
      `route-policy ${POLICY} deny node 1000`,
    ].join('\n'),
  },
  {
    nome: 'goto no node original',
    expectedExistingNodes: [10, 1000],
    readBack: [
      `route-policy ${POLICY} permit node 10`,
      ' if-match ip-prefix PREFIX8to24',
      ' goto 50',
      `route-policy ${POLICY} deny node 1000`,
    ].join('\n'),
  },
  {
    nome: 'apply sem semantica reproduzivel',
    expectedExistingNodes: [10, 1000],
    readBack: [
      `route-policy ${POLICY} permit node 10`,
      ' if-match ip-prefix PREFIX8to24',
      ' apply traffic-index 7',
      `route-policy ${POLICY} deny node 1000`,
    ].join('\n'),
  },
  {
    nome: 'node anterior catch-all',
    expectedExistingNodes: [5, 10, 1000],
    readBack: [
      `route-policy ${POLICY} permit node 5`,
      `route-policy ${POLICY} permit node 10`,
      ' if-match ip-prefix PREFIX8to24',
      ' apply local-preference 1100',
      `route-policy ${POLICY} deny node 1000`,
    ].join('\n'),
  },
  {
    nome: 'node anterior com a MESMA prefix-list',
    expectedExistingNodes: [5, 10, 1000],
    readBack: [
      `route-policy ${POLICY} permit node 5`,
      ' if-match ip-prefix PREFIX8to24',
      ' apply local-preference 200',
      `route-policy ${POLICY} permit node 10`,
      ' if-match ip-prefix PREFIX8to24',
      ' apply local-preference 1100',
      `route-policy ${POLICY} deny node 1000`,
    ].join('\n'),
  },
];

describe('2-4) forma do baseline do cliente nao reprova o contrato fixo', () => {
  it.each(BASELINE_SHAPES)(
    '$nome: preflight aprova, nada e copiado e so os nodes 1/2 sao escritos',
    async ({ readBack, expectedExistingNodes }) => {
      const ssh = new FakeSsh(readBack);
      const exec = executor(ssh);
      const result = await exec.preflight(device(), {
        ...input,
        expectedExistingNodes,
      });

      expect(result.ok).toBe(true);
      expect(result.preservedClauses).toBeNull();
      expect(result.checks.map((entry) => entry.id)).not.toContain('preserved_attributes');

      await exec.activate(device(), {
        ...input,
        ...(result.baselineRecord ? { preflightBaseline: result.baselineRecord } : {}),
      });

      expect(ssh.applied).toHaveLength(1);
      expect(ssh.applied[0]).toEqual(CANONICAL_ACTIVATE_COMMANDS);
    },
  );
});

describe('5) baseline simples continua aprovada', () => {
  it('aprova o preflight e registra os nodes permanentes, sem derivar preserved', async () => {
    const ssh = new FakeSsh(AGLINK_SIMPLE);
    const result = await executor(ssh).preflight(device(), {
      ...input,
      expectedExistingNodes: [10, 1000],
    });

    expect(result.ok).toBe(true);
    expect(result.preservedClauses).toBeNull();
    expect(result.baselineRecord?.nodes.map((entry) => entry.node)).toEqual([10, 1000]);
    expect(ssh.applied).toHaveLength(0);
  });
});

describe('8) preview e escrita sao identicos', () => {
  it('a lista canonica do preview coincide com a escrita, sem preserved', async () => {
    const ssh = new FakeSsh(AGLINK_SIMPLE);
    const exec = executor(ssh);
    const result = await exec.preflight(device(), {
      ...input,
      expectedExistingNodes: [10, 1000],
    });
    const preview = buildMitigationActivateCommands({
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
      rt: RT,
      bogonPrefixList: 'BOGONS',
      targetPrefixList: 'PREFIX8to24',
    });

    await exec.activate(device(), {
      ...input,
      ...(result.baselineRecord ? { preflightBaseline: result.baselineRecord } : {}),
    });

    expect(ssh.applied).toHaveLength(1);
    expect(ssh.applied[0]).toEqual(preview);
    expect(preview).toEqual(CANONICAL_ACTIVATE_COMMANDS);
  });

  it('o builder ignora preserved: a lista e a mesma com ou sem baseline', () => {
    const preserved = derivePreservedClauses(AGLINK_SIMPLE, POLICY, 'PREFIX8to24', RT);
    const plan = {
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
      rt: RT,
      bogonPrefixList: 'BOGONS',
      targetPrefixList: 'PREFIX8to24',
    };

    expect(buildMitigationActivateCommands(plan, preserved)).toEqual(
      buildMitigationActivateCommands(plan),
    );
    expect(buildMitigationActivateCommands(plan)).toEqual(CANONICAL_ACTIVATE_COMMANDS);
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
        ' apply extcommunity rt 268568:660',
        AGLINK_SIMPLE,
      ].join('\n'),
    );
    const exec = await executorWithBaseline(ssh, AGLINK_SIMPLE);
    await exec.remove(device(), { policyName: POLICY, bogonNode: 1, mitigationNode: 2 });
    expect(ssh.applied[0]).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  // B5: o baseline NAO e heuristico. O registro gravado antes da primeira
  // escrita e a fonte dos nodes permanentes; o baseline do cliente (mesma lista
  // autorizada, sem a RT de mitigacao) e reconhecido por ele - nunca por
  // adivinhacao a partir do read-back do momento.
  const ACTIVATED_WITH_BASELINE = [
    `route-policy ${POLICY} deny node 1`,
    ' if-match ip-prefix BOGONS',
    `route-policy ${POLICY} permit node 2`,
    ' apply extcommunity rt 268568:660',
    AGLINK_SIMPLE,
  ].join('\n');

  it('baseline com a mesma prefix-list e sem a RT de mitigacao nao bloqueia a retirada', async () => {
    const ssh = new FakeSsh(ACTIVATED_WITH_BASELINE);
    const exec = await executorWithBaseline(ssh, ACTIVATED_WITH_BASELINE);
    const result = await exec.preflight(device(), { ...input, mode: 'REMOVE' });

    expect(check('policy_baseline_record', result)?.ok).toBe(true);
    expect(check('policy_mitigation_scope', result)?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('registro de baseline ausente BLOQUEIA a retirada (nao presume original)', async () => {
    const ssh = new FakeSsh(ACTIVATED_WITH_BASELINE);
    const result = await executor(ssh).preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain(
      'MITIGATION_BASELINE_RECORD_MISSING',
    );
  });

  it('node permanente ALTERADO desde o ACTIVATE bloqueia a retirada', async () => {
    const ssh = new FakeSsh(
      // Altera SO o node permanente (RT normal do cliente); o node 2 fica igual.
      ACTIVATED_WITH_BASELINE.replace(
        ' apply extcommunity rt 268568:140 additive',
        ' apply extcommunity rt 268568:999 additive',
      ),
    );
    const exec = await executorWithBaseline(ssh, ACTIVATED_WITH_BASELINE);
    const result = await exec.preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain('MITIGATION_BASELINE_DRIFT');
    expect(ssh.applied).toHaveLength(0);
  });

  it('node permanente ACRESCENTADO desde o ACTIVATE bloqueia a retirada', async () => {
    const ssh = new FakeSsh(
      [ACTIVATED_WITH_BASELINE, `route-policy ${POLICY} permit node 70`].join('\n'),
    );
    const exec = await executorWithBaseline(ssh, ACTIVATED_WITH_BASELINE);
    const result = await exec.preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain('nao existia no ACTIVATE');
  });

  it('node permanente REMOVIDO desde o ACTIVATE bloqueia a retirada', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 2`,
        ' apply extcommunity rt 268568:660',
      ].join('\n'),
    );
    const exec = await executorWithBaseline(ssh, ACTIVATED_WITH_BASELINE);
    const result = await exec.preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain('nao existe mais');
  });

  it('segundo par instalado na policy continua bloqueando a retirada', async () => {
    const ssh = new FakeSsh(
      [
        ACTIVATED_WITH_BASELINE,
        `route-policy ${POLICY} deny node 3`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 4`,
        ' apply extcommunity rt 268568:660',
      ].join('\n'),
    );
    const exec = await executorWithBaseline(ssh, ACTIVATED_WITH_BASELINE);
    const result = await exec.preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    // Nodes fora do par reservado (1/2) nao sao propriedade da mitigacao: o
    // bloqueio vem do registro DURAVEL (nodes 3/4 nao existiam no ACTIVATE).
    expect(check('policy_baseline_record', result)?.ok ?? false).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain('nao existia no ACTIVATE');
    expect(ssh.applied).toHaveLength(0);
  });

  it('node permanente com a RT de mitigacao nunca substitui o registro duravel', async () => {
    const ssh = new FakeSsh(
      [
        `route-policy ${POLICY} deny node 1`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${POLICY} permit node 2`,
        ' apply extcommunity rt 268568:660',
        `route-policy ${POLICY} permit node 10`,
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
      ].join('\n'),
    );
    const exec = await executorWithBaseline(ssh, ACTIVATED_WITH_BASELINE);
    const result = await exec.preflight(device(), { ...input, mode: 'REMOVE' });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.ok ?? false).toBe(false);
  });
});
