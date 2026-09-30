import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import {
  DEFAULT_BOGON_PREFIX_LIST,
  DEFAULT_TARGET_PREFIX_LIST,
  selectNodePair,
} from './mitigation-planner';
import { SimulationCommandExecutor } from './simulation-command-executor';
import {
  MockMitigationExecutor,
  verifyActivation,
  verifyRemoval,
  type MitigationExecutor,
} from './mitigation-executor';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { MitigationCommandService } from './mitigation-command-service';

const LABELS = {
  bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
  targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
};
const RT = '268568:660';
const POLICY = 'PL-HORIZONTES_IPv4-IN';

function host(): HostRecord {
  return {
    id: 'device-1',
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    interfaces: [
      { id: 'if-3011', name: 'Eth-Trunk1.3011', alias: 'HORIZONTE_IP_40GB', description: '' },
      { id: 'if-3013', name: 'Eth-Trunk1.3013', alias: 'HORIZONTE_IP_02_40GB', description: '' },
    ],
  } as unknown as HostRecord;
}

describe('Fase 12 - par de nodes da mitigacao', () => {
  it('A) planner basico: [11,50] -> bogon 1 / mitigacao 2', () => {
    const decisao = selectNodePair({ normalNodes: [11, 50], occupiedNodes: [11, 50] });
    expect(decisao.blocked).toBe(false);
    expect(decisao.pair).toEqual({ bogonNode: 1, mitigationNode: 2 });
    expect(decisao.firstNormalNode).toBe(11);
  });

  it('B) node ocupado: [1,11,50] -> outro par seguro (2/3)', () => {
    const decisao = selectNodePair({ normalNodes: [11, 50], occupiedNodes: [1, 11, 50] });
    expect(decisao.blocked).toBe(false);
    expect(decisao.pair).toEqual({ bogonNode: 2, mitigationNode: 3 });
  });

  it('C) sem par seguro antes do primeiro node normal -> bloqueado', () => {
    const semEspaco = selectNodePair({ normalNodes: [1, 2], occupiedNodes: [1, 2, 50] });
    expect(semEspaco.pair).toBeNull();
    expect(semEspaco.blocked).toBe(true);
    expect(semEspaco.reason).toBe('NO_SAFE_TEMPORARY_NODE');

    const lotado = selectNodePair({ normalNodes: [11], occupiedNodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11] });
    expect(lotado.blocked).toBe(true);
    expect(lotado.reason).toBe('NO_SAFE_TEMPORARY_NODE');
  });

  it('D) ativacao gera DENY BOGONS + PERMIT PREFIX8to24 + RT', () => {
    const preview = new SimulationCommandExecutor().buildMitigation(
      POLICY,
      { bogonNode: 1, mitigationNode: 2 },
      RT,
      LABELS,
    );
    expect(preview.commands).toEqual([
      'system-view',
      `route-policy ${POLICY} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY} permit node 2`,
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${RT} additive`,
      'commit',
    ]);
    expect(preview.safe).toBe(true);
  });

  it('E) read-back com RT mas SEM PREFIX8to24 -> nao verificado', () => {
    const readBack = [
      `route-policy ${POLICY} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY} permit node 2`,
      ` apply extcommunity rt ${RT} additive`,
    ].join('\n');
    const check = verifyActivation(POLICY, readBack, { bogonNode: 1, mitigationNode: 2 }, RT, LABELS);
    expect(check.bogonOk).toBe(true);
    expect(check.mitigationOk).toBe(false);
    expect(check.verified).toBe(false);
    expect(check.summary).toContain('PREFIX8to24');
  });

  it('F) read-back sem o node BOGONS -> nao verificado', () => {
    const readBack = [
      `route-policy ${POLICY} permit node 2`,
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${RT} additive`,
    ].join('\n');
    const check = verifyActivation(POLICY, readBack, { bogonNode: 1, mitigationNode: 2 }, RT, LABELS);
    expect(check.bogonOk).toBe(false);
    expect(check.mitigationOk).toBe(true);
    expect(check.verified).toBe(false);
    expect(check.summary).toContain('node BOGONS 1 ausente');
  });

  it('F2) deny qualquer NAO conta como BOGONS', () => {
    const readBack = [
      `route-policy ${POLICY} deny node 1`,
      ' if-match ip-prefix OUTRA-LISTA',
      `route-policy ${POLICY} permit node 2`,
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${RT} additive`,
    ].join('\n');
    expect(verifyActivation(POLICY, readBack, { bogonNode: 1, mitigationNode: 2 }, RT, LABELS).verified).toBe(false);
  });

  it('G) retirada remove os dois nodes e valida a ausencia', async () => {
    const executor = new MockMitigationExecutor();
    executor.seedPolicy(POLICY, [11, 50]);
    await executor.activate({
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
      rt: RT,
      ...LABELS,
    });
    const ativo = await executor.readRoutePolicy(POLICY);
    expect(verifyActivation(POLICY, ativo, { bogonNode: 1, mitigationNode: 2 }, RT, LABELS).verified).toBe(true);

    await executor.remove({ policyName: POLICY, bogonNode: 1, mitigationNode: 2 });
    const depois = await executor.readRoutePolicy(POLICY);
    const check = verifyRemoval(POLICY, depois, { bogonNode: 1, mitigationNode: 2 });
    expect(check.verified).toBe(true);
    expect(check.partial).toBe(false);
    expect(depois).not.toContain('deny node 1');
    expect(depois).not.toContain('permit node 2');
  });

  it('H) retirada parcial -> partial true e nao verificado', () => {
    const readBack = [`route-policy ${POLICY} permit node 2`, ' if-match ip-prefix PREFIX8to24'].join('\n');
    const check = verifyRemoval(POLICY, readBack, { bogonNode: 1, mitigationNode: 2 });
    expect(check.verified).toBe(false);
    expect(check.partial).toBe(true);
    expect(check.summary).toContain('retirada incompleta');
  });

  it('I) shared policy continua aviso (nao bloqueia)', async () => {
    const repository = new InMemoryMitigationRepository();
    const executor = new MockMitigationExecutor();
    executor.seedPolicy(POLICY, [11, 50]);
    const principal = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-3011',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(principal.id, [{ peerAddress: '10.200.200.106', primary: true }]);
    await repository.upsertRuntime(principal.id, {
      state: 'NORMAL',
      plannedNode: 2,
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
    });
    const compartilhado = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-3013',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(compartilhado.id, [{ peerAddress: '10.200.200.10', primary: true }]);

    const commands = new MitigationCommandService({
      repository,
      hosts: { getHost: async () => host() },
      executor,
      labels: LABELS,
    });
    const resultado = await commands.execute({
      requestId: 'pair-shared-1',
      action: 'ACTIVATE',
      profileId: principal.id,
    });
    expect(resultado.ok).toBe(true);
    expect(resultado.sharedPolicy).toBe(true);
    expect(resultado.safeError).toBeUndefined();
    expect(resultado.bogonNode).toBe(1);
    expect(resultado.mitigationNode).toBe(2);
    expect(resultado.node).toBe(2);
  });

  it('J) seguranca: so MockMitigationExecutor, nenhum Huawei real', () => {
    const executor: MitigationExecutor = new MockMitigationExecutor();
    expect(executor).toBeInstanceOf(MockMitigationExecutor);
    expect('execute' in executor).toBe(false);
    expect('ssh' in executor).toBe(false);
    expect(Object.getOwnPropertyNames(executor).some((nome) => /client|ssh|connection/i.test(nome))).toBe(false);

    const simulacao = new SimulationCommandExecutor();
    expect('execute' in simulacao).toBe(false);
    expect('executeConfig' in simulacao).toBe(false);
    expect(Object.getOwnPropertyNames(simulacao).some((nome) => /client|ssh|connection/i.test(nome))).toBe(false);
  });
});
