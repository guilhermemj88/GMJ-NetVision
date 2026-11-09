import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { REAL_ROUTE_POLICY_CONFIG } from '../../../testing/physical-bgp-simulator';
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
].join('\n');

class RealConfigSsh implements MitigationSshPort {
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
  hostname: 'BHE-VTA-F1A-BGP-01',
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
