import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiMitigationExecutor, type MitigationSshPort } from './huawei-mitigation-executor';
import {
  MemoryMitigationBaselineStore,
  type MitigationBaselineRecord,
  type MitigationBaselineStore,
} from './mitigation-baseline-record';
import { MockMitigationExecutor, type MitigationActivationInput } from './mitigation-executor';
import {
  createFakeDurableBackend,
  FakeDurableBaselineStore,
  testPreservedClauses,
} from './mitigation-test-support';

/**
 * B6 — PERSISTENCIA DURAVEL OBRIGATORIA DO BASELINE.
 *
 * Escrita real no Huawei exige registro persistente (PostgreSQL/Prisma). A
 * memoria do processo nunca e aceita como fallback: sem registro duravel nao
 * existe ACTIVATE, e o registro precisa ser recuperavel por uma instancia nova.
 */

const DEVICE_ID = 'host-f1a';
const POLICY = 'PL-CLIENTE_IPv4-IN';
const RT = '268568:660';

const PREFIX_LISTS = [
  'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8',
  'ip ip-prefix PREFIX8to24 index 10 permit 10.200.200.0 24 less-equal 24',
].join('\n');

const NORMAL_POLICY = [
  `route-policy ${POLICY} permit node 10`,
  ' if-match ip-prefix PREFIX8to24',
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  `route-policy ${POLICY} deny node 1000`,
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
  configReads = 0;
  /** Segunda leitura fisica (imediatamente antes da escrita) pode divergir. */
  secondReadConfiguration: string | null = null;

  constructor(public routePolicyConfiguration: string = NORMAL_POLICY) {}

  async readMitigationConfiguration() {
    this.configReads += 1;
    const divergent = this.configReads > 1 ? this.secondReadConfiguration : null;
    return {
      routePolicyConfiguration: divergent ?? this.routePolicyConfiguration,
      prefixListConfiguration: PREFIX_LISTS,
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    return this.routePolicyConfiguration;
  }
  async applyMitigationCommands(_host: HostRecord, commands: readonly string[]) {
    this.applied.push({ commands: [...commands] });
    this.routePolicyConfiguration = commands.some((command) => command.startsWith('undo '))
      ? NORMAL_POLICY
      : ACTIVATED_POLICY;
    return { ok: true, output: 'ok' };
  }
}

function executor(
  ssh: FakeSsh,
  baseline?: MitigationBaselineStore,
): HuaweiMitigationExecutor {
  return new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [DEVICE_ID] },
    rt: RT,
    ...(baseline ? { baseline } : {}),
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

const activation = (preflight: {
  preservedClauses?: MitigationActivationInput['preservedClauses'] | null;
  baselineRecord?: MitigationBaselineRecord | null;
}) => ({
  policyName: POLICY,
  bogonNode: 1,
  mitigationNode: 2,
  rt: RT,
  bogonPrefixList: 'BOGONS',
  targetPrefixList: 'PREFIX8to24',
  ...(preflight.preservedClauses ? { preservedClauses: preflight.preservedClauses } : {}),
  ...(preflight.baselineRecord ? { preflightBaseline: preflight.baselineRecord } : {}),
});

const check = (id: string, result: { checks: { id: string; ok: boolean; detail: string }[] }) =>
  result.checks.find((entry) => entry.id === id);

describe('B6 - escrita real exige armazenamento DURAVEL do baseline', () => {
  it('sem store duravel o ACTIVATE e bloqueado e nada e escrito', async () => {
    const ssh = new FakeSsh();
    const exec = executor(ssh); // default = MemoryMitigationBaselineStore
    const preflight = await exec.preflight(device(), { ...ACTIVATE_INPUT });

    expect(check('baseline_record_store', preflight)?.ok).toBe(false);
    expect(check('baseline_record_store', preflight)?.detail).toContain(
      'MITIGATION_BASELINE_RECORD_UNAVAILABLE',
    );
    expect(preflight.ok).toBe(false);

    await expect(
      exec.activate(device(), activation(preflight)),
    ).rejects.toThrow(/MITIGATION_BASELINE_RECORD_UNAVAILABLE/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('persistencia desabilitada (store apenas em memoria) bloqueia o ACTIVATE', async () => {
    const ssh = new FakeSsh();
    const exec = executor(ssh, new MemoryMitigationBaselineStore());
    const preflight = await exec.preflight(device(), { ...ACTIVATE_INPUT });

    expect(preflight.ok).toBe(false);
    await expect(
      exec.activate(device(), activation(preflight)),
    ).rejects.toThrow(/MITIGATION_BASELINE_RECORD_UNAVAILABLE/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('banco indisponivel bloqueia o ACTIVATE', async () => {
    const ssh = new FakeSsh();
    const offline: MitigationBaselineStore = {
      durable: true,
      save: async () => {
        throw new Error('ECONNREFUSED 5432');
      },
      load: async () => {
        throw new Error('ECONNREFUSED 5432');
      },
      release: async () => undefined,
    };
    const exec = executor(ssh, offline);
    const preflight = await exec.preflight(device(), { ...ACTIVATE_INPUT });

    await expect(
      exec.activate(device(), activation(preflight)),
    ).rejects.toThrow(/MITIGATION_BASELINE_RECORD_UNAVAILABLE/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('falha ao gravar o registro bloqueia o ACTIVATE', async () => {
    const ssh = new FakeSsh();
    const failingSave: MitigationBaselineStore = {
      durable: true,
      save: async () => {
        throw new Error('write rejected');
      },
      load: async () => null,
      release: async () => undefined,
    };
    const exec = executor(ssh, failingSave);
    const preflight = await exec.preflight(device(), { ...ACTIVATE_INPUT });

    await expect(
      exec.activate(device(), activation(preflight)),
    ).rejects.toThrow(/MITIGATION_BASELINE_RECORD_UNAVAILABLE/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('registro que nao pode ser confirmado apos a gravacao bloqueia o ACTIVATE', async () => {
    const ssh = new FakeSsh();
    const amnesic: MitigationBaselineStore = {
      durable: true,
      save: async () => undefined,
      load: async () => null,
      release: async () => undefined,
    };
    const exec = executor(ssh, amnesic);
    const preflight = await exec.preflight(device(), { ...ACTIVATE_INPUT });

    await expect(
      exec.activate(device(), activation(preflight)),
    ).rejects.toThrow(/registro nao confirmado apos a gravacao/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('leitura fisica divergente do baseline do preflight bloqueia sem commit', async () => {
    const ssh = new FakeSsh();
    ssh.secondReadConfiguration = NORMAL_POLICY.replace(
      ' apply local-preference 1100',
      ' apply local-preference 500',
    );
    const exec = executor(ssh, new FakeDurableBaselineStore(createFakeDurableBackend()));
    const preflight = await exec.preflight(device(), { ...ACTIVATE_INPUT });
    expect(preflight.ok).toBe(true);

    await expect(
      exec.activate(device(), activation(preflight)),
    ).rejects.toThrow(/MITIGATION_BASELINE_DIVERGED/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('save persistente bem-sucedido permite o ACTIVATE e grava o escopo correto', async () => {
    const backend = createFakeDurableBackend();
    const ssh = new FakeSsh();
    const exec = executor(ssh, new FakeDurableBaselineStore(backend));
    const preflight = await exec.preflight(device(), { ...ACTIVATE_INPUT });
    expect(preflight.ok).toBe(true);

    await exec.activate(device(), activation(preflight));

    expect(ssh.applied).toHaveLength(1);
    expect(ssh.applied[0]!.commands).toContain('commit');
    const stored = [...backend.rows.values()].map(
      (raw) => JSON.parse(raw) as MitigationBaselineRecord,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      deviceId: DEVICE_ID,
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
    });
    expect(stored[0]!.nodes.map((node) => node.node)).toEqual([10, 1000]);
  });
});

describe('B6 - recuperacao por instancia independente', () => {
  it('instancia A grava, A e descartada, B carrega o mesmo registro e valida o REMOVE', async () => {
    const backend = createFakeDurableBackend();

    // Instancia A: ACTIVATE real com o proprio adaptador sobre o backend.
    const sshA = new FakeSsh();
    const instanceA = executor(sshA, new FakeDurableBaselineStore(backend));
    const preflightA = await instanceA.preflight(device(), { ...ACTIVATE_INPUT });
    await instanceA.activate(device(), activation(preflightA));
    expect(sshA.applied).toHaveLength(1);

    // Instancia A descartada: nada mais e reaproveitado dela (nem a memoria do
    // processo, nem o adaptador). B usa um adaptador NOVO sobre o mesmo backend.
    const sshB = new FakeSsh(ACTIVATED_POLICY);
    const instanceB = executor(sshB, new FakeDurableBaselineStore(backend));

    const preflightB = await instanceB.preflight(device(), { ...REMOVE_INPUT });
    expect(check('policy_baseline_record', preflightB)?.ok).toBe(true);
    expect(preflightB.ok).toBe(true);

    await instanceB.remove(device(), { policyName: POLICY, bogonNode: 1, mitigationNode: 2 });
    expect(sshB.applied).toHaveLength(1);
    expect(sshB.applied[0]!.commands).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  it('instancia B sem registro no backend bloqueia o REMOVE', async () => {
    const ssh = new FakeSsh(ACTIVATED_POLICY);
    const instanceB = executor(ssh, new FakeDurableBaselineStore(createFakeDurableBackend()));
    const result = await instanceB.preflight(device(), { ...REMOVE_INPUT });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain(
      'MITIGATION_BASELINE_RECORD_MISSING',
    );
  });

  it('registro corrompido no backend bloqueia o REMOVE', async () => {
    const backend = createFakeDurableBackend();
    backend.rows.set(`mitigation-baseline:${DEVICE_ID}:${POLICY}`, '{"version":1}');
    const ssh = new FakeSsh(ACTIVATED_POLICY);
    const exec = executor(ssh, new FakeDurableBaselineStore(backend));
    const result = await exec.preflight(device(), { ...REMOVE_INPUT });

    expect(result.ok).toBe(false);
    expect(check('policy_baseline_record', result)?.detail).toContain(
      'MITIGATION_BASELINE_RECORD_MISSING',
    );
  });
});

describe('B6 - MOCK continua funcionando', () => {
  it('executor MOCK nao exige baseline duravel', async () => {
    const mock = new MockMitigationExecutor();
    mock.seedNode(POLICY, 10, { ifMatchIpPrefix: ['PREFIX8to24'] });
    const preserved = testPreservedClauses(POLICY, 'PREFIX8to24', RT);

    await mock.activate(activation({ preservedClauses: preserved }));
    const readBack = await mock.readRoutePolicy(POLICY);

    expect(readBack).toContain(`route-policy ${POLICY} deny node 1`);
    expect(readBack).toContain(`route-policy ${POLICY} permit node 2`);
    expect(readBack).toContain(`route-policy ${POLICY} permit node 10`);
  });
});
