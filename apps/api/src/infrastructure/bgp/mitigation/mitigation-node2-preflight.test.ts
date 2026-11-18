import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import {
  REAL_ROUTE_POLICY_CONFIG,
  realConfigDisplayRead,
  syntheticExportPrefixLists,
} from '../../../testing/physical-bgp-simulator';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { HuaweiMitigationExecutor, type MitigationSshPort } from './huawei-mitigation-executor';
import { testDurableBaselineStore } from './mitigation-test-support';

/**
 * Preflight (somente leitura) sobre a configuracao REAL sanitizada do equipamento: AGLINK passa e
 * entrega o contrato; HORIZONTES e RECUSADA com motivo explicito. Nenhuma escrita em nenhum caso.
 */

const DEVICE_ID = 'host-f1a';
const PREFIX_LISTS = [
  'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8 greater-equal 8 less-equal 32',
  'ip ip-prefix PREFIX8to24 index 10 permit 0.0.0.0 8 greater-equal 8 less-equal 24',
  A.prefixDefinition,
  'ip ip-prefix PREFIX-HORIZONTES-IPV4 index 10 permit 198.51.100.0 24',
  'ip ip-prefix PREFIX-FLASHTELECOM-IPV4 index 10 permit 203.0.113.0 24',
  // Definicoes SINTETICAS das listas citadas pelo export real (a captura nao as traz).
  syntheticExportPrefixLists(),
].join('\n');

class RealConfigSsh implements MitigationSshPort {
  readMitigationDisplays = realConfigDisplayRead;
  readonly applied: string[][] = [];
  async readMitigationConfiguration() {
    return {
      routePolicyConfiguration: REAL_ROUTE_POLICY_CONFIG,
      prefixListConfiguration: PREFIX_LISTS,
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    return REAL_ROUTE_POLICY_CONFIG;
  }
  async applyMitigationCommands(_device: HostRecord, commands: readonly string[]) {
    this.applied.push([...commands]);
    return { ok: true, output: 'ok' };
  }
}

const device = {
  id: DEVICE_ID,
  hostname: 'BHE-VTA-F1A-BGP-01',  vendor: 'Huawei',  model: 'NE8000',
  displayName: 'BHE-VTA-F1A-BGP-01',
  sshEnabled: true,
  ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
} as unknown as HostRecord;

const executor = (ssh: RealConfigSsh) =>
  new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [DEVICE_ID] },
    baseline: testDurableBaselineStore(),
  });

const input = (policyName: string, expectedExistingNodes: number[]) => ({
  mode: 'ACTIVATE' as const,
  policyName,
  bogonNode: 1,
  mitigationNode: 2,
  rt: '268568:660',
  bogonPrefixList: 'BOGONS',
  targetPrefixList: 'PREFIX8to24',
  expectedExistingNodes,
});

describe('preflight com a configuracao real: contrato elegivel x inelegivel', () => {
  it('AGLINK: PASS com o contrato (lista, LP 1100, REPLACE 140 -> 660) e check mitigation_contract', async () => {
    const ssh = new RealConfigSsh();
    const result = await executor(ssh).preflight(device, input(A.policy, [10, 1000]));
    expect(result.blockedReasons).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.mitigationContract).toMatchObject({
      policyName: A.policy,
      prefixList: 'AGLINK-BLOCO-TODO-23',
      localPreference: 1100,
      rtMode: 'REPLACE',
      baselineRt: '268568:140',
    });
    expect(result.mitigationContract?.prefixListEntries).toEqual([A.prefixDefinition]);
    const check = result.checks.find((entry) => entry.id === 'mitigation_contract');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/node 10 -> node 2.*rtMode REPLACE/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('HORIZONTES: FAIL com MITIGATION_CONTRACT_UNSUPPORTED e o motivo (node 11 ja aplica a RT 660)', async () => {
    const ssh = new RealConfigSsh();
    const result = await executor(ssh).preflight(device, input('PL-HORIZONTES_IPv4-IN', [11, 50]));
    expect(result.ok).toBe(false);
    expect(result.mitigationContract).toBeNull();
    expect(result.blockedReasons.join(' | ')).toMatch(
      /mitigation_contract: MITIGATION_CONTRACT_UNSUPPORTED: .*node 11: o node permanente ja aplica a RT de mitigacao 268568:660/,
    );
    expect(ssh.applied).toHaveLength(0);
  });

  it('A2 UAY: contrato elegivel, mas o export da COMPUTIZE (deny node 47 TRIPLO_A-BLOCO-TODO) a sombreia => FAIL', async () => {
    const ssh = new RealConfigSsh();
    const result = await executor(ssh).preflight(device, input('PL-UAY_IPv4-IN', [10, 1000]));
    expect(result.checks.find((c) => c.id === 'mitigation_contract')?.ok).toBe(true);
    const check = result.checks.find((c) => c.id === 'mitigation_export');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(
      /^MITIGATION_EXPORT_SHADOWED: PL-COMPUTIZE-IPv4-OUT node 47 \(deny\) antecede o permit MITIGACAO.*TRIPLO_A-BLOCO-TODO/,
    );
    expect(result.ok).toBe(false);
    expect(ssh.applied).toHaveLength(0);
  });

  it('A2 AGLINK: export da COMPUTIZE nao sombreia a lista (PASS) e o check cita o peer/policy', async () => {
    const result = await executor(new RealConfigSsh()).preflight(
      device,
      input(A.policy, [10, 1000]),
    );
    const check = result.checks.find((c) => c.id === 'mitigation_export');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/PL-COMPUTIZE-IPv4-OUT do peer 198\.19\.4\.145/);
  });

  it('A2: leitura do export indisponivel => nao comprovavel => inelegivel', async () => {
    const ssh = new RealConfigSsh();
    ssh.readMitigationDisplays = async () => {
      throw new Error('SSH command failed');
    };
    const result = await executor(ssh).preflight(device, input(A.policy, [10, 1000]));
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === 'mitigation_export')?.detail).toMatch(
      /^MITIGATION_EXPORT_SHADOWED: leitura do export/,
    );
  });

  it('B4: BOGONS que intersecta a lista do cliente torna a policy inelegivel', async () => {
    const ssh = new RealConfigSsh();
    ssh.readMitigationConfiguration = async () => ({
      routePolicyConfiguration: REAL_ROUTE_POLICY_CONFIG,
      prefixListConfiguration: PREFIX_LISTS.replace(
        'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8 greater-equal 8 less-equal 32',
        'ip ip-prefix BOGONS index 10 permit 167.250.0.0 16 greater-equal 16 less-equal 32',
      ),
      warnings: [],
    });
    const result = await executor(ssh).preflight(device, input(A.policy, [10, 1000]));
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === 'mitigation_contract')?.detail).toMatch(
      /BOGONS intersecta a lista do cliente AGLINK-BLOCO-TODO-23/,
    );
  });

  it('FLASH (RT 140 sem additive, deny 999): PASS', async () => {
    const ssh = new RealConfigSsh();
    const result = await executor(ssh).preflight(
      device,
      input('PL-FLASH-TELECOM_IPv4-IN', [10, 999]),
    );
    expect(result.ok).toBe(true);
    expect(result.mitigationContract).toMatchObject({
      localPreference: 3000,
      baselineRtAdditive: false,
    });
  });

  it('ACTIVATE sem o contrato do preflight (ou de outra policy) NAO escreve nada', async () => {
    const ssh = new RealConfigSsh();
    const exec = executor(ssh);
    const pre = await exec.preflight(device, input(A.policy, [10, 1000]));
    const base = {
      policyName: A.policy,
      bogonNode: 1,
      mitigationNode: 2,
      rt: '268568:660',
      bogonPrefixList: 'BOGONS',
      targetPrefixList: 'PREFIX8to24',
      ...(pre.baselineRecord ? { preflightBaseline: pre.baselineRecord } : {}),
    };
    await expect(exec.activate(device, base)).rejects.toThrow(/MITIGATION_CONTRACT_UNSUPPORTED/);
    expect(ssh.applied).toHaveLength(0);
    // Contrato adulterado entre o preflight e a escrita diverge da segunda leitura fisica.
    await expect(
      exec.activate(device, {
        ...base,
        mitigationContract: { ...pre.mitigationContract!, localPreference: 100 },
      }),
    ).rejects.toThrow(/MITIGATION_CONTRACT_DIVERGED/);
    expect(ssh.applied).toHaveLength(0);
    // Contrato valido: escreve exatamente o node 2 estreito.
    await exec.activate(device, { ...base, mitigationContract: pre.mitigationContract! });
    expect(ssh.applied).toHaveLength(1);
    expect(ssh.applied[0]).toContain(' apply local-preference 1100');
  });
});
