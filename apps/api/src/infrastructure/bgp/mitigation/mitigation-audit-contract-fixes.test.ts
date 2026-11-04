import { describe, expect, it } from 'vitest';
import {
  parseHuaweiRoutePolicyNodes,
  parseHuaweiRoutePolicyNodesLenient,
} from './huawei-bgp-policy-parser';
import { precedenceConflictNodes } from './mitigation-contract';
import {
  MockMitigationExecutor,
  verifyActivation,
} from './mitigation-executor';
import {
  MemoryMitigationBaselineStore,
  baselineRecordId,
  captureMitigationBaseline,
} from './mitigation-baseline-record';
import { AutomationMitigationBaselineStore } from '../../../worker/mitigation/baseline-store';
import { MemoryAutomationStore } from '../../../worker/mitigation/automation-store';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { MitigationCommandService } from './mitigation-command-service';
import { selectNodePair } from './mitigation-planner';
import type { HostRecord } from '@gmj/shared';

const POLICY = 'PL-CLIENTE_IPv4-IN';
const RT = '268568:660';
const LABELS = { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' };

const PERMANENT_AND_CONTRACT = [
  `route-policy ${POLICY} permit node 10`,
  ' if-match ip-prefix PREFIX8to24',
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ` apply extcommunity rt ${RT}`,
].join('\n');

const CONTRACT = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ` apply extcommunity rt ${RT}`,
].join('\n');

function host(): HostRecord {
  return {
    id: 'device-1',
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    interfaces: [{ id: 'if-1', name: 'Eth-Trunk1.3058', alias: 'AGLINK', description: '' }],
  } as unknown as HostRecord;
}

describe('D1: node 0 tem precedencia sobre o par reservado 1/2', () => {
  it('o parser NAO descarta node 0 (formato de configuracao e de display)', () => {
    const config = `route-policy ${POLICY} permit node 0\n${CONTRACT}`;
    expect((parseHuaweiRoutePolicyNodes(config).get(POLICY) ?? []).map((n) => n.node)).toEqual([0, 1, 2]);

    const display = [
      `Route-policy: ${POLICY}`,
      '  permit : 0',
      '    Apply clauses:',
      '  deny : 1',
      '    if-match ip-prefix BOGONS',
      '  permit : 2',
      `    apply extcommunity rt ${RT}`,
    ].join('\n');
    expect((parseHuaweiRoutePolicyNodesLenient(display).get(POLICY) ?? []).map((n) => n.node)).toContain(0);
  });

  it('precedenceConflictNodes lista somente nodes anteriores ao reservado', () => {
    expect(precedenceConflictNodes([{ node: 0 }, { node: 1 }, { node: 2 }, { node: 10 }])).toEqual([0]);
    expect(precedenceConflictNodes([{ node: 1 }, { node: 2 }])).toEqual([]);
  });

  it('readback NAO declara par verificado quando existe node 0', () => {
    const comNode0 = `route-policy ${POLICY} permit node 0\n${CONTRACT}`;
    const resultado = verifyActivation(POLICY, comNode0, { bogonNode: 1, mitigationNode: 2 }, RT, LABELS);
    expect(resultado.verified).toBe(false);
    expect(resultado.summary).toContain('precede o par reservado');

    // Sem node 0 o mesmo read-back e aceito (o endurecimento nao quebra o caso bom).
    expect(
      verifyActivation(POLICY, CONTRACT, { bogonNode: 1, mitigationNode: 2 }, RT, LABELS).verified,
    ).toBe(true);
  });

  it('planner recusa o par quando um node 0 existe', () => {
    const decisao = selectNodePair({ normalNodes: [0, 10], occupiedNodes: [0, 10] });
    expect(decisao.blocked).toBe(true);
    expect(decisao.pair).toBeNull();
  });
});

describe('D3: baseline pertence a operacao e e invalidado na retirada', () => {
  const scope = { deviceId: 'device-1', policyName: POLICY };

  it('release descarta o registro: um par identico posterior nao e adotado', async () => {
    const store = new MemoryMitigationBaselineStore();
    const record = captureMitigationBaseline({
      ...scope,
      readBack: PERMANENT_AND_CONTRACT,
      bogonNode: 1,
      mitigationNode: 2,
    });
    expect(record).not.toBeNull();
    await store.save(record!);
    expect(await store.load(scope)).not.toBeNull();

    await store.release(scope);
    expect(await store.load(scope)).toBeNull();
  });

  it('store duravel grava marcador de retirada e load passa a devolver null', async () => {
    const backend = new MemoryAutomationStore();
    const store = new AutomationMitigationBaselineStore(backend);
    const record = captureMitigationBaseline({
      ...scope,
      readBack: PERMANENT_AND_CONTRACT,
      bogonNode: 1,
      mitigationNode: 2,
    });
    await store.save(record!);
    expect(await store.load(scope)).not.toBeNull();

    await store.release(scope);
    expect(await store.load(scope)).toBeNull();
    const marker = await backend.transaction((tx) => tx.get<{ released?: boolean }>(baselineRecordId(scope)));
    expect(marker?.released).toBe(true);
  });
});

describe('D8: Mock.remove segue o builder canonico', () => {
  it('remove o par 1/2 com os comandos exatos', async () => {
    const executor = new MockMitigationExecutor();
    executor.seedPolicy(POLICY, [1, 2, 10]);
    await executor.remove({ policyName: POLICY, bogonNode: 1, mitigationNode: 2, rt: RT } as never);
    expect(executor.calls).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  it('recusa nodes fora de 1/2 (mesmo contrato do executor real)', async () => {
    const executor = new MockMitigationExecutor();
    executor.seedPolicy(POLICY, [10, 1000]);
    await expect(
      executor.remove({ policyName: POLICY, bogonNode: 10, mitigationNode: 1000, rt: RT } as never),
    ).rejects.toThrow(/MITIGATION_CONTRACT_MISMATCH/);
    expect(executor.calls).toEqual([]);
  });
});

describe('D2: IDEMPOTENCY_CONFLICT nao reutiliza recibo de outra operacao', () => {
  async function setup() {
    const repository = new InMemoryMitigationRepository();
    const executor = new MockMitigationExecutor();
    executor.seedPolicy(POLICY, [10]);
    const create = (interfaceId: string) =>
      repository.upsertProfile({
        deviceId: 'device-1',
        policyName: POLICY,
        interfaceId,
        addressFamily: 'IPV4',
        detectedBandwidthBps: 40_000_000_000n,
        bandwidthSource: 'DESCRIPTION',
      });
    const primeira = await create('if-1');
    const segunda = await create('if-2');
    await repository.replaceProfilePeers(primeira.id, [{ peerAddress: '10.200.201.2', primary: true }]);
    await repository.replaceProfilePeers(segunda.id, [{ peerAddress: '10.200.201.3', primary: true }]);
    for (const profile of [primeira, segunda]) {
      await repository.upsertRuntime(profile.id, {
        state: 'NORMAL',
        plannedNode: 2,
        plannedBogonNode: 1,
        plannedMitigationNode: 2,
      });
    }
    const service = new MitigationCommandService({
      repository,
      hosts: { getHost: async () => host() },
      executor,
      labels: LABELS,
    });
    return { service, primeira, segunda, executor };
  }

  it('mesmo requestId, outro perfil: conflito sem policy/interface/verificacao alheias', async () => {
    const { service, primeira, segunda, executor } = await setup();
    const a = await service.execute({ requestId: 'r-1', action: 'ACTIVATE', profileId: primeira.id });
    expect(a.ok, JSON.stringify({status: a.status, safeError: a.safeError, blocked: a.preflight?.blockedReasons})).toBe(true);
    expect(a.policy).toBe(POLICY);
    const escritas = [...executor.calls];

    const b = await service.execute({ requestId: 'r-1', action: 'ACTIVATE', profileId: segunda.id });
    expect(b.status).toBe('IDEMPOTENCY_CONFLICT');
    expect(b.ok).toBe(false);
    expect(b.policy).toBeNull();
    expect(b.interface).toBeNull();
    expect(b.interfaceId).toBeNull();
    expect(b.verification).toBeNull();
    expect(b.customer).toBeNull();
    expect(b.commandPreview).toEqual([]);
    expect(b.notification?.published ?? false).toBe(false);
    // Nenhuma escrita nova atribuida ao perfil B.
    expect(executor.calls).toEqual(escritas);
  });

  it('mesmo requestId, mesma operacao: repeticao idempotente preservada', async () => {
    const { service, primeira } = await setup();
    const a = await service.execute({ requestId: 'r-2', action: 'ACTIVATE', profileId: primeira.id });
    const b = await service.execute({ requestId: 'r-2', action: 'ACTIVATE', profileId: primeira.id });
    expect(a.ok, JSON.stringify({status: a.status, safeError: a.safeError, blocked: a.preflight?.blockedReasons})).toBe(true);
    expect(b.idempotent).toBe(true);
    expect(b.status).toBe(a.status);
    expect(b.policy).toBe(POLICY);
  });
});
