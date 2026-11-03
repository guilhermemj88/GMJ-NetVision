import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiMitigationExecutor, type MitigationSshPort } from './huawei-mitigation-executor';
import {
  captureMitigationBaseline,
  type MitigationBaselineRecord,
  type MitigationBaselineStore,
} from './mitigation-baseline-record';
import { testDurableBaselineStore } from './mitigation-test-support';

/**
 * Correcoes finais B3 e B5.
 *
 * B3: o contrato IPv4 definitivo nao deriva nem copia atributos de nodes
 *     permanentes. O node 2 e `permit` irrestrito com a RT exclusiva
 *     (amplitude autorizada pelo operador), entao nodes ANTERIORES nao alteram
 *     os comandos — o que se trava aqui e exatamente isso.
 * B5: o REMOVE usa o registro DURAVEL gravado antes da primeira escrita; node
 *     permanente novo/alterado/removido ou registro ausente/invalido bloqueiam.
 */

const DEVICE_ID = 'host-f1a';
const POLICY = 'PL-CLIENTE_IPv4-IN';
const RT = '268568:660';

const PREFIX_LISTS = [
  'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8',
  'ip ip-prefix PREFIX8to24 index 10 permit 10.200.200.0 24 less-equal 24',
  'ip ip-prefix SUB-BLOCO index 10 permit 10.200.200.128 25',
  'ip ip-prefix OUTRA-REDE index 10 permit 192.0.2.0 24',
].join('\n');

const NORMAL_POLICY = [
  `route-policy ${POLICY} permit node 10`,
  ' if-match ip-prefix PREFIX8to24',
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  `route-policy ${POLICY} deny node 1000`,
].join('\n');

/** Node 5 ANTERIOR ao baseline negando um sub-bloco do que o node 2 aceitaria. */
const POLICY_WITH_OVERLAP = [
  `route-policy ${POLICY} deny node 5`,
  ' if-match ip-prefix SUB-BLOCO',
  NORMAL_POLICY,
].join('\n');

/** Node 5 anterior, porem em faixa que NAO alcanca o bloco autorizado. */
const POLICY_WITHOUT_OVERLAP = [
  `route-policy ${POLICY} deny node 5`,
  ' if-match ip-prefix OUTRA-REDE',
  NORMAL_POLICY,
].join('\n');

/** Node 5 anterior com lista que nem aparece no dump -> conflito nao comprovavel. */
const POLICY_WITH_UNKNOWN_LIST = [
  `route-policy ${POLICY} deny node 5`,
  ' if-match ip-prefix LISTA-NAO-DUMPADA',
  NORMAL_POLICY,
].join('\n');

const ACTIVATED_POLICY = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' apply extcommunity rt 268568:660',
  NORMAL_POLICY,
].join('\n');

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
  readonly applied: { commands: string[] }[] = [];
  constructor(public routePolicyConfiguration: string) {}

  async readMitigationConfiguration() {
    return {
      routePolicyConfiguration: this.routePolicyConfiguration,
      prefixListConfiguration: PREFIX_LISTS,
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    return this.routePolicyConfiguration;
  }
  async applyMitigationCommands(_host: HostRecord, commands: readonly string[]) {
    this.applied.push({ commands: [...commands] });
    // Espelha o efeito fisico: ACTIVATE instala o par; REMOVE retira.
    this.routePolicyConfiguration = commands.some((command) => command.startsWith('undo '))
      ? NORMAL_POLICY
      : ACTIVATED_POLICY;
    return { ok: true, output: 'ok' };
  }
}

function executor(ssh: FakeSsh, baseline?: MitigationBaselineStore): HuaweiMitigationExecutor {
  return new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [DEVICE_ID] },
    rt: RT,
    baseline: baseline ?? testDurableBaselineStore(),
  });
}

const ACTIVATE_INPUT = {
  mode: 'ACTIVATE' as const,
  policyName: POLICY,
  bogonNode: 1,
  mitigationNode: 2,
  rt: RT,
  bogonPrefixList: 'BOGONS',
  targetPrefixList: 'PREFIX8to24',
  expectedExistingNodes: [10, 1000] as number[] | null,
};

const REMOVE_INPUT = { ...ACTIVATE_INPUT, mode: 'REMOVE' as const };

const check = (id: string, result: { checks: { id: string; ok: boolean; detail: string }[] }) =>
  result.checks.find((entry) => entry.id === id);

const CANONICAL_ACTIVATE_COMMANDS = [
  'system-view',
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' apply extcommunity rt 268568:660',
  'commit',
];

describe('B3 - nodes anteriores ao baseline nao interferem no contrato fixo', () => {
  it('deny anterior sobreposto nao bloqueia: o node 2 e permit irrestrito autorizado', async () => {
    const ssh = new FakeSsh(POLICY_WITH_OVERLAP);
    const result = await executor(ssh).preflight(device(), {
      ...ACTIVATE_INPUT,
      expectedExistingNodes: [5, 10, 1000],
    });

    expect(result.ok).toBe(true);
    expect(result.preservedClauses).toBeNull();
    expect(result.checks.map((entry) => entry.id)).not.toContain('preserved_attributes');
    expect(ssh.applied).toHaveLength(0);
  });

  it('node anterior sem sobreposicao real tambem nao altera o contrato', async () => {
    const ssh = new FakeSsh(POLICY_WITHOUT_OVERLAP);
    const result = await executor(ssh).preflight(device(), {
      ...ACTIVATE_INPUT,
      expectedExistingNodes: [5, 10, 1000],
    });

    expect(result.ok).toBe(true);
    expect(result.preservedClauses).toBeNull();
  });

  it('lista nao dumpada no node anterior nao impede o ACTIVATE', async () => {
    const ssh = new FakeSsh(POLICY_WITH_UNKNOWN_LIST);
    const result = await executor(ssh).preflight(device(), {
      ...ACTIVATE_INPUT,
      expectedExistingNodes: [5, 10, 1000],
    });

    expect(result.ok).toBe(true);
  });

  it('nenhum atributo do node anterior e copiado para o node 2', async () => {
    const ssh = new FakeSsh(POLICY_WITH_OVERLAP);
    const exec = executor(ssh);
    const preflight = await exec.preflight(device(), {
      ...ACTIVATE_INPUT,
      expectedExistingNodes: [5, 10, 1000],
    });

    await exec.activate(device(), {
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
      rt: RT,
      bogonPrefixList: 'BOGONS',
      targetPrefixList: 'PREFIX8to24',
      ...(preflight.baselineRecord ? { preflightBaseline: preflight.baselineRecord } : {}),
    });

    expect(ssh.applied).toHaveLength(1);
    expect(ssh.applied[0]!.commands).toEqual(CANONICAL_ACTIVATE_COMMANDS);
    expect(ssh.applied[0]!.commands.join('\n')).not.toContain('local-preference');
  });
});

describe('B5 - fingerprint duravel dos nodes permanentes', () => {
  it('registro ausente bloqueia a retirada', async () => {
    const ssh = new FakeSsh(ACTIVATED_POLICY);
    const result = await executor(ssh).preflight(device(), { ...REMOVE_INPUT });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain(
      'MITIGATION_BASELINE_RECORD_MISSING',
    );
  });

  it('registro invalido (corrompido) bloqueia a retirada', async () => {
    const ssh = new FakeSsh(ACTIVATED_POLICY);
    const corrupt: MitigationBaselineStore = {
      durable: true,
      save: async () => undefined,
      load: async () => ({ version: 1, nodes: [] }) as unknown as MitigationBaselineRecord,
    };
    const result = await executor(ssh, corrupt).preflight(device(), { ...REMOVE_INPUT });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain(
      'MITIGATION_BASELINE_RECORD_MISSING',
    );
  });

  it('ACTIVATE seguido de REMOVE continua funcionando ponta a ponta', async () => {
    const baseline = testDurableBaselineStore();
    const ssh = new FakeSsh(NORMAL_POLICY);
    const exec = executor(ssh, baseline);

    const preActivate = await exec.preflight(device(), { ...ACTIVATE_INPUT });
    expect(preActivate.ok).toBe(true);
    await exec.activate(device(), {
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
      rt: RT,
      bogonPrefixList: 'BOGONS',
      targetPrefixList: 'PREFIX8to24',
      ...(preActivate.baselineRecord ? { preflightBaseline: preActivate.baselineRecord } : {}),
    });
    expect(ssh.applied).toHaveLength(1);
    // O ACTIVATE cria SOMENTE os nodes 1 e 2 (node 10/1000 intactos).
    expect(ssh.applied[0]!.commands.filter((line) => /^route-policy /.test(line))).toEqual([
      `route-policy ${POLICY} deny node 1`,
      `route-policy ${POLICY} permit node 2`,
    ]);

    const preRemove = await exec.preflight(device(), { ...REMOVE_INPUT });
    expect(preRemove.ok).toBe(true);
    expect(check('policy_baseline_record', preRemove)?.ok).toBe(true);

    await exec.remove(device(), { policyName: POLICY, bogonNode: 1, mitigationNode: 2 });
    expect(ssh.applied[1]!.commands).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  it('fingerprint cobre exatamente os nodes permanentes (nunca o par)', () => {
    const record = captureMitigationBaseline({
      deviceId: DEVICE_ID,
      policyName: POLICY,
      readBack: ACTIVATED_POLICY,
      bogonNode: 1,
      mitigationNode: 2,
    });

    expect(record?.nodes.map((entry) => entry.node)).toEqual([10, 1000]);
    expect(record?.bogonNode).toBe(1);
    expect(record?.mitigationNode).toBe(2);
  });
});
