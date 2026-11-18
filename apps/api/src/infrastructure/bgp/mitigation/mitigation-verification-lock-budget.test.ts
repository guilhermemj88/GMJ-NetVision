import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { PhysicalBgpSimulator, SIM_CUSTOMER_PEER } from '../../../testing/physical-bgp-simulator';
import { AGLINK_BGP_PLAN as A } from './aglink-bgp-plan';
import { HuaweiMitigationExecutor } from './huawei-mitigation-executor';
import { captureBeforeEvidence } from './mitigation-physical-verification';
import { testMitigationContract } from './mitigation-test-support';

/**
 * A verificacao fisica roda DENTRO do lock da policy, que tem prazo. O teto `maxBudgetMs`
 * (tempo restante do lock) limita o orcamento total: a verificacao nunca continua depois que
 * a posse do lock expira, e orcamento insuficiente e INCONCLUSIVE (nunca sucesso).
 */

const DEVICE = {
  id: 'host-f1a',
  hostname: 'F1A',
  vendor: 'Huawei',
  model: 'NE8000',
  sshEnabled: true,
} as unknown as HostRecord;
const CONTRACT = {
  ...testMitigationContract(A.policy, A.targetPrefixList, 1100),
  prefixListEntries: [A.prefixDefinition],
};

function harness(mitigated: () => boolean, readCostMs = 0) {
  const sim = new PhysicalBgpSimulator(mitigated);
  let clock = 0;
  let reads = 0;
  const executor = new HuaweiMitigationExecutor({
    ssh: {
      readMitigationConfiguration: async () => {
        throw new Error('nao usado');
      },
      readMitigationRoutePolicy: async () => {
        throw new Error('nao usado');
      },
      applyMitigationCommands: async () => {
        throw new Error('ESCRITA PROIBIDA NO TESTE');
      },
      readMitigationDisplays: async (_device: HostRecord, commands: readonly string[]) => {
        reads += 1;
        clock += readCostMs;
        return sim.read([...commands]);
      },
    },
    config: { executor: 'HUAWEI', liveWriteEnabled: false, allowedDeviceIds: [DEVICE.id] },
    physical: {
      sleep: async (ms: number) => {
        clock += ms;
      },
      clock: () => clock,
    },
  } as never);
  return {
    executor,
    sim,
    reads: () => reads,
    elapsed: () => clock,
  };
}

describe('verificacao fisica limitada ao tempo restante do lock da policy', () => {
  it('sem tempo restante: INCONCLUSIVE imediato, nenhuma leitura no equipamento', async () => {
    const h = harness(() => true);
    for (const maxBudgetMs of [0, -5_000]) {
      const result = await h.executor.verifyMitigationPhysical(DEVICE, {
        contract: CONTRACT,
        customerPeers: [SIM_CUSTOMER_PEER],
        before: null,
        maxBudgetMs,
      });
      expect(result.outcome).toBe('INCONCLUSIVE');
      expect(result.checks[0]!.id).toBe('lock_budget');
    }
    expect(h.reads()).toBe(0);
  });

  it('teto menor que o orcamento padrao: as tentativas param no teto (nunca os 90 s)', async () => {
    let mitigated = false;
    const h = harness(() => mitigated);
    const before = await captureBeforeEvidence((c) => h.sim.read(c), [SIM_CUSTOMER_PEER]);
    // o efeito NUNCA aparece: a verificacao usaria os 90 s inteiros sem o teto
    const result = await h.executor.verifyMitigationPhysical(DEVICE, {
      contract: CONTRACT,
      customerPeers: [SIM_CUSTOMER_PEER],
      before,
      maxBudgetMs: 12_000,
    });
    expect(result.outcome).not.toBe('PASS');
    expect(h.elapsed()).toBeLessThanOrEqual(12_000);
    mitigated = true;
  });

  it('leituras LENTAS: a descoberta consome o orcamento e nenhuma leitura comeca depois dele', async () => {
    // cada sessao custa 9 s; teto de 8 s: a descoberta ja esgota o orcamento
    const h = harness(() => true, 9_000);
    const before = await captureBeforeEvidence((c) => h.sim.read(c), [SIM_CUSTOMER_PEER]);
    const result = await h.executor.verifyMitigationPhysical(DEVICE, {
      contract: CONTRACT,
      customerPeers: [SIM_CUSTOMER_PEER],
      before,
      maxBudgetMs: 8_000,
    });
    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.checks.map((check) => check.id)).toEqual(['budget']);
    expect(h.reads()).toBe(1); // so a descoberta; a evidencia nao foi lida fora do orcamento
  });

  it('com a mitigacao aplicada e teto suficiente: PASS', async () => {
    let mitigated = false;
    const h = harness(() => mitigated);
    const before = await captureBeforeEvidence((c) => h.sim.read(c), [SIM_CUSTOMER_PEER]);
    mitigated = true;
    const result = await h.executor.verifyMitigationPhysical(DEVICE, {
      contract: CONTRACT,
      customerPeers: [SIM_CUSTOMER_PEER],
      before,
      maxBudgetMs: 60_000,
    });
    expect(result.outcome).toBe('PASS');
  });

  it('sem teto: orcamento padrao inalterado', async () => {
    let mitigated = false;
    const h = harness(() => mitigated);
    const before = await captureBeforeEvidence((c) => h.sim.read(c), [SIM_CUSTOMER_PEER]);
    mitigated = true;
    const result = await h.executor.verifyMitigationPhysical(DEVICE, {
      contract: CONTRACT,
      customerPeers: [SIM_CUSTOMER_PEER],
      before,
    });
    expect(result.outcome).toBe('PASS');
  });
});
