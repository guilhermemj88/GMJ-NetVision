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
 * Correcoes finais B3, B4 (transporte coberto em ssh-client-write-guards) e B5.
 *
 * B3: nodes ANTERIORES ao baseline so liberam quando as faixas das ip-prefix
 *     NAO se sobrepoem ao bloco autorizado — um `deny` de sub-bloco com OUTRA
 *     lista passaria a ser aceito pelo node 2.
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
  ' if-match ip-prefix PREFIX8to24',
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 rt 268568:660 additive',
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

describe('B3 - nodes anteriores ao baseline', () => {
  it('deny anterior com prefix-list diferente mas sobreposta BLOQUEIA', async () => {
    const ssh = new FakeSsh(POLICY_WITH_OVERLAP);
    const result = await executor(ssh).preflight(device(), { ...ACTIVATE_INPUT });

    expect(result.ok).toBe(false);
    const detail = check('preserved_attributes', result)?.detail ?? '';
    expect(detail).toContain('MITIGATION_BASELINE_UNSAFE');
    expect(detail).toContain('alcanca');
    expect(ssh.applied).toHaveLength(0);
  });

  it('node anterior sem sobreposicao real continua aprovado', async () => {
    const ssh = new FakeSsh(POLICY_WITHOUT_OVERLAP);
    const result = await executor(ssh).preflight(device(), { ...ACTIVATE_INPUT });

    expect(check('preserved_attributes', result)?.ok).toBe(true);
    expect(result.preservedClauses?.baselineNode).toBe(10);
    expect(result.preservedClauses?.safe).toBe(true);
  });

  it('lista nao dumpada no node anterior BLOQUEIA (conflito nao comprovavel)', async () => {
    const ssh = new FakeSsh(POLICY_WITH_UNKNOWN_LIST);
    const result = await executor(ssh).preflight(device(), { ...ACTIVATE_INPUT });

    expect(result.ok).toBe(false);
    expect(check('preserved_attributes', result)?.detail).toContain('NAO pode ser comprovada');
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
      preservedClauses: preActivate.preservedClauses!,
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
