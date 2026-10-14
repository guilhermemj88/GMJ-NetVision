import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  MitigationCommandService,
  type MitigationLiveExecutorPort,
} from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import type {
  MitigationActivationInput,
  MitigationRemovalInput,
} from './mitigation-executor';
import type {
  MitigationPreflightInput,
  MitigationPreflightResult,
} from './huawei-mitigation-executor';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
import {
  assessPolicyPhysicalState,
  MitigationPolicyReconciler,
  PolicyReconcileStaleError,
  type PolicyScopeTarget,
} from './mitigation-policy-reconciler';
import { MitigationAutoEngine } from '../../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../../worker/mitigation/mitigation-traffic-source';

// RUNTIME CONSISTENTE PARA ROUTE-POLICY COMPARTILHADA.
//
// A route-policy e uma entidade FISICA por equipamento: alterar os nodes afeta
// TODOS os profiles daquele device que a usam - e apenas eles. O runtime de
// cada profile precisa refletir esse fato, nunca ficar divergente.

const DEVICE_A = 'host-f1a';
const DEVICE_B = 'host-outro';
const POLICY = 'PL-FLASH-TELECOM_IPv4-IN';
const RT = '268568:660';
const BANDWIDTH = 10_000_000_000n;
const NOW = new Date('2026-10-12T12:00:00.000Z');

function device(id: string): HostRecord {
  return {
    id,
    hostname: id,
    displayName: id,
    name: id,
    sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, username: 'netvision' },
  } as unknown as HostRecord;
}

const READBACK_ACTIVE = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' if-match ip-prefix PREFIX8to24',
  ` apply extcommunity rt ${RT} additive`,
  `route-policy ${POLICY} permit node 10`,
].join('\n');
const READBACK_NORMAL = `route-policy ${POLICY} permit node 10`;
/** BOGON presente, node de mitigacao AUSENTE: estado parcial. */
const READBACK_PARTIAL = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 10`,
].join('\n');

class FakeLiveExecutor implements MitigationLiveExecutorPort {
  activateCalls = 0;
  removeCalls = 0;
  readBacks: string[] = [];
  devicePair: { bogonNode: number; mitigationNode: number } | null = null;
  /** Escrita pode ter sido aplicada, mas o read-back falha (estado desconhecido). */
  readBackError: Error | null = null;
  failPreflight = false;

  enabledFor(): boolean {
    return true;
  }

  async resolveActivePair(): Promise<{ bogonNode: number; mitigationNode: number } | null> {
    return this.devicePair;
  }

  async preflight(_device: HostRecord, input: MitigationPreflightInput): Promise<MitigationPreflightResult> {
    if (this.failPreflight) {
      return {
        ...this.preflightResult(input),
        ok: false,
        blockedReasons: ['read-back indisponivel'],
      };
    }
    return this.preflightResult(input);
  }

  private preflightResult(input: MitigationPreflightInput): MitigationPreflightResult {
    return {
      ok: true,
      mode: input.mode,
      deviceId: DEVICE_A,
      deviceName: DEVICE_A,
      deviceHost: '10.0.0.1',
      policyName: input.policyName,
      existingNodes: [10, 999],
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
      bogonPrefixList: input.bogonPrefixList,
      bogonPrefixListExists: true,
      targetPrefixList: input.targetPrefixList,
      targetPrefixListExists: true,
      rt: input.rt,
      sshReadBackOk: true,
      bogonNodeExists: false,
      bogonNodeMatches: false,
      mitigationNodeExists: false,
      mitigationNodeMatches: false,
      partial: false,
      readBackNodes: [10, 999],
      readBackSummary: 'par livre',
      readBackExcerpt: '',
      checks: [],
      blockedReasons: [],
    };
  }

  async activate(_device: HostRecord, _input: MitigationActivationInput): Promise<{ output: string }> {
    this.activateCalls += 1;
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, _input: MitigationRemovalInput): Promise<{ output: string }> {
    this.removeCalls += 1;
    this.devicePair = null;
    return { output: 'ok' };
  }

  async readRoutePolicy(): Promise<string> {
    if (this.readBackError) throw this.readBackError;
    return this.readBacks.shift() ?? READBACK_NORMAL;
  }
}

interface Harness {
  repository: InMemoryMitigationRepository;
  service: MitigationCommandService;
  live: FakeLiveExecutor;
  seed(interfaceId: string, deviceId?: string): Promise<{ id: string }>;
  activate(profileId: string, requestId: string): ReturnType<MitigationCommandService['execute']>;
  remove(profileId: string, requestId: string): ReturnType<MitigationCommandService['execute']>;
}

function buildHarness(): Harness {
  const repository = new InMemoryMitigationRepository();
  const live = new FakeLiveExecutor();
  const service = new MitigationCommandService({
    repository,
    hosts: {
      getHost: async (id: string) => (id === DEVICE_A || id === DEVICE_B ? device(id) : null),
    },
    executor: new MockMitigationExecutor(),
    live,
    now: () => NOW,
  });
  return {
    repository,
    service,
    live,
    seed: async (interfaceId: string, deviceId: string = DEVICE_A) => {
      const profile = await repository.upsertProfile({
        deviceId,
        policyName: POLICY,
        interfaceId,
        addressFamily: 'IPV4',
        detectedBandwidthBps: BANDWIDTH,
        bandwidthSource: 'DESCRIPTION',
      });
      await repository.replaceProfilePeers(profile.id, [
        { peerId: `peer-${profile.id}`, peerAddress: '10.200.201.22', primary: true },
      ]);
      await repository.upsertRuntime(profile.id, {
        state: 'NORMAL',
        plannedBogonNode: 1,
        plannedMitigationNode: 2,
        plannedNode: 2,
      });
      return { id: profile.id };
    },
    activate: (profileId: string, requestId: string) =>
      service.execute({ requestId, action: 'ACTIVATE', profileId }),
    remove: (profileId: string, requestId: string) =>
      // AUTO-ALL: REMOVE em escopo compartilhado exige a confirmacao explicita
      // do operador (a suite valida a SINCRONIZACAO do escopo, nao o gate).
      service.execute({
        requestId,
        action: 'REMOVE',
        profileId,
        acknowledgeScopeRemoval: true,
      }),
  };
}

async function stateOf(repository: InMemoryMitigationRepository, profileId: string): Promise<string | null> {
  return (await repository.getRuntime(profileId))?.state ?? null;
}

describe('runtime de route-policy compartilhada', () => {
  it('ACTIVATE verificado propaga MITIGATED para TODOS os profiles da mesma policy fisica', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    h.live.readBacks = [READBACK_ACTIVE];

    const result = await h.activate(p1.id, 'req-activate-1');

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    expect(await stateOf(h.repository, p1.id)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2.id)).toBe('MITIGATED');
    // Aviso continua listando o alvo compartilhado (mesmo device/policy).
    expect(result.sharedPolicy).toBe(true);
    expect(result.sharedPolicyTargets.map((target) => target.interfaceId)).toEqual(['if-3065']);
  });

  it('REMOVE verificado propaga NORMAL para todos e o evento fica no ORIGINADOR', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    await h.repository.upsertRuntime(p1.id, { state: 'MITIGATED' });
    await h.repository.upsertRuntime(p2.id, { state: 'MITIGATED' });
    h.live.devicePair = { bogonNode: 1, mitigationNode: 2 };
    h.live.readBacks = [READBACK_NORMAL];

    const result = await h.remove(p2.id, 'req-remove-1');

    expect(result.ok).toBe(true);
    expect(result.status).toBe('REMOVED_VERIFIED');
    expect(await stateOf(h.repository, p1.id)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2.id)).toBe('NORMAL');

    const p2Events = await h.repository.listEvents(p2.id);
    expect(p2Events[0]).toMatchObject({ profileId: p2.id, type: 'REMOVE', verified: true });
    // O profile que apenas COMPARTILHA a policy nao ganha evento: a acao foi uma so.
    expect(await h.repository.listEvents(p1.id)).toEqual([]);
  });

  it('tres profiles no mesmo escopo: ACTIVATE e REMOVE valem para os tres', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    const p3 = await h.seed('if-3064');
    h.live.readBacks = [READBACK_ACTIVE];

    await h.activate(p2.id, 'req-activate-3');
    expect(await Promise.all([p1, p2, p3].map((p) => stateOf(h.repository, p.id)))).toEqual([
      'MITIGATED',
      'MITIGATED',
      'MITIGATED',
    ]);

    h.live.devicePair = { bogonNode: 1, mitigationNode: 2 };
    h.live.readBacks = [READBACK_NORMAL];
    await h.remove(p3.id, 'req-remove-3');
    expect(await Promise.all([p1, p2, p3].map((p) => stateOf(h.repository, p.id)))).toEqual([
      'NORMAL',
      'NORMAL',
      'NORMAL',
    ]);
  });

  it('device DIFERENTE com o MESMO nome de policy nunca e afetado', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066', DEVICE_A);
    const outro = await h.seed('if-3066', DEVICE_B);
    h.live.readBacks = [READBACK_ACTIVE];

    const result = await h.activate(p1.id, 'req-activate-cross');

    expect(await stateOf(h.repository, p1.id)).toBe('MITIGATED');
    expect(await stateOf(h.repository, outro.id)).toBe('NORMAL');
    expect(result.sharedPolicyTargets).toEqual([]);
    expect(result.sharedPolicy).toBe(false);
  });

  it('read-back PARCIAL deixa TODOS os profiles do escopo em RECONCILIATION_REQUIRED', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    h.live.readBacks = [READBACK_PARTIAL];

    const result = await h.activate(p1.id, 'req-activate-parcial');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('REVALIDATION_FAILED');
    expect(await stateOf(h.repository, p1.id)).toBe('RECONCILIATION_REQUIRED');
    expect(await stateOf(h.repository, p2.id)).toBe('RECONCILIATION_REQUIRED');
    const events = await h.repository.listEvents(p1.id);
    expect(events[0]).toMatchObject({ newState: 'RECONCILIATION_REQUIRED', verified: false });
  });

  it('AUTO com a policy ja MITIGATED nao ativa de novo pelo profile irmao', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    h.live.readBacks = [READBACK_ACTIVE];
    await h.activate(p1.id, 'req-activate-auto');
    expect(await stateOf(h.repository, p2.id)).toBe('MITIGATED');
    const activateCallsBefore = h.live.activateCalls;

    const traffic = new SequenceTrafficSource();
    const engine = new MitigationAutoEngine({
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE_A] },
      targets: {
        list: async () => {
          const rows = [];
          for (const profileId of [p1.id, p2.id]) {
            rows.push({
              profileId,
              deviceId: DEVICE_A,
              interfaceId: 'if-1',
              customer: 'FAST TELECOM',
              mode: 'AUTO' as const,
              snapshotAvailable: true,
              readiness: 'READY' as const,
              prefixStatus: 'SAFE' as const,
              blockedReason: null,
              mitigationExcluded: false,
              runtimeState: (await h.repository.getRuntime(profileId))?.state ?? null,
              effectiveBandwidthBps: BANDWIDTH,
              bogonNode: 1,
              mitigationNode: 2,
              sharedPolicy: true,
              peerAddresses: ['10.200.201.22'],
              triggerPercent: 90,
              recoveryPercent: 70,
              triggerSamples: 3,
              recoverySamples: 12,
            });
          }
          return rows;
        },
      },
      traffic,
      exclusions: { listPeerExclusions: (filter) => h.repository.listPeerExclusions(filter) },
      runtime: {
        get: (id) => h.repository.getRuntime(id),
        save: async (id, patch) => {
          await h.repository.upsertRuntime(id, patch);
        },
      },
      commands: { execute: (input) => h.service.execute(input) },
      now: () => NOW,
    });

    let decisions: Awaited<ReturnType<typeof engine.tick>> = [];
    for (let i = 0; i < 3; i += 1) {
      traffic.push(p2.id, (BANDWIDTH * 95n) / 100n);
      decisions = await engine.tick();
    }
    const p2Decision = decisions.find((decision) => decision.profileId === p2.id);
    expect(p2Decision?.outcome).toBe('NO_ACTION');
    expect(p2Decision?.reason).toBe('ALREADY_MITIGATED');
    expect(h.live.activateCalls).toBe(activateCallsBefore);
  });
});

describe('reconciler read-only por policy fisica', () => {
  const labels = {
    bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
    targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
  };
  const target = (profileId: string): PolicyScopeTarget => ({
    profileId,
    addressFamily: 'IPV4',
    mitigationRt: RT,
    pair: { bogonNode: 1, mitigationNode: 2 },
    runtimeState: 'MITIGATED',
  });

  it('MITIGATED quando o par valido esta presente para todos os targets', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READBACK_ACTIVE,
      labels,
      targets: [target('p1'), target('p2')],
    });
    expect(assessment.state).toBe('MITIGATED');
  });

  it('NORMAL quando nenhum node de mitigacao esta presente', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READBACK_NORMAL,
      labels,
      targets: [target('p1'), target('p2')],
    });
    expect(assessment.state).toBe('NORMAL');
  });

  it('RECONCILIATION_REQUIRED em leitura parcial', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READBACK_PARTIAL,
      labels,
      targets: [target('p1'), target('p2')],
    });
    expect(assessment.state).toBe('RECONCILIATION_REQUIRED');
    // F2: a evidencia agora e ESTRUTURAL (nodes do read-back), nao por target.
    expect(assessment.detail).toContain('BOGONS');
    expect(assessment.physical.bogonNodes).toEqual([1]);
    expect(assessment.physical.mitigationNodes).toEqual([]);
    expect(assessment.physical.pair).toBeNull();
  });

  it('F2: par FISICO presente com plano nulo => MITIGATED (nunca NORMAL)', () => {
    const assessment = assessPolicyPhysicalState({
      policyName: POLICY,
      readBack: READBACK_ACTIVE,
      labels,
      targets: [{ ...target('p1'), pair: null }],
    });
    // A ausencia do PLANO nao pode virar NORMAL: o read-back TEM o par 1/2.
    expect(assessment.state).toBe('MITIGATED');
    expect(assessment.physical.pair).toEqual({ bogonNode: 1, mitigationNode: 2 });
  });
});

describe('falha depois de uma escrita real possivel', () => {
  it('ACTIVATE aplicado + read-back que falha => escopo inteiro RECONCILIATION_REQUIRED', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    const outro = await h.seed('if-3066', DEVICE_B);
    h.live.readBackError = new Error('SSH timeout no read-back');

    const result = await h.activate(p1.id, 'req-readback-fail-activate');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('REVALIDATION_FAILED');
    // A escrita FOI iniciada: o estado fisico ficou desconhecido para o escopo.
    expect(h.live.activateCalls).toBe(1);
    expect(await stateOf(h.repository, p1.id)).toBe('RECONCILIATION_REQUIRED');
    expect(await stateOf(h.repository, p2.id)).toBe('RECONCILIATION_REQUIRED');
    // Policy de MESMO nome em outro equipamento permanece intacta.
    expect(await stateOf(h.repository, outro.id)).toBe('NORMAL');
    const events = await h.repository.listEvents(p1.id);
    expect(events[0]).toMatchObject({
      profileId: p1.id,
      type: 'ACTIVATE',
      newState: 'RECONCILIATION_REQUIRED',
      verified: false,
    });
    expect(await h.repository.listEvents(p2.id)).toEqual([]);
  });

  it('REMOVE aplicado + read-back que falha => escopo inteiro RECONCILIATION_REQUIRED', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    await h.repository.upsertRuntime(p1.id, { state: 'MITIGATED' });
    await h.repository.upsertRuntime(p2.id, { state: 'MITIGATED' });
    h.live.devicePair = { bogonNode: 1, mitigationNode: 2 };
    h.live.readBackError = new Error('timeout');

    const result = await h.remove(p2.id, 'req-readback-fail-remove');

    expect(result.ok).toBe(false);
    expect(h.live.removeCalls).toBe(1);
    expect(await stateOf(h.repository, p1.id)).toBe('RECONCILIATION_REQUIRED');
    expect(await stateOf(h.repository, p2.id)).toBe('RECONCILIATION_REQUIRED');
    const events = await h.repository.listEvents(p2.id);
    expect(events[0]).toMatchObject({ profileId: p2.id, type: 'REMOVE', verified: false });
    expect(await h.repository.listEvents(p1.id)).toEqual([]);
  });

  it('preflight que falha ANTES da escrita nao altera runtime nenhum', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    h.live.failPreflight = true;

    const result = await h.activate(p1.id, 'req-preflight-bloqueado');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('REVALIDATION_FAILED');
    expect(h.live.activateCalls).toBe(0);
    expect(await stateOf(h.repository, p1.id)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2.id)).toBe('NORMAL');
    expect(await h.repository.listEvents(p1.id)).toEqual([]);
  });

  it('ACTIVATE verificado propaga o PAR FISICO ATIVO para todo o escopo', async () => {
    const h = buildHarness();
    const p1 = await h.seed('if-3066');
    const p2 = await h.seed('if-3065');
    // P2 tinha um plano DIFERENTE; o par aplicado no equipamento foi o da P1.
    await h.repository.upsertRuntime(p2.id, {
      plannedBogonNode: 5,
      plannedMitigationNode: 6,
      plannedNode: 6,
    });
    h.live.readBacks = [READBACK_ACTIVE];

    await h.activate(p1.id, 'req-par-fisico');

    const rt1 = await h.repository.getRuntime(p1.id);
    const rt2 = await h.repository.getRuntime(p2.id);
    expect([rt1?.plannedBogonNode, rt1?.plannedMitigationNode]).toEqual([1, 2]);
    expect([rt2?.plannedBogonNode, rt2?.plannedMitigationNode]).toEqual([1, 2]);
    expect(rt2?.plannedNode).toBe(2);
  });
});

describe('reconciler: preview read-only e apply local', () => {
  const scope = { deviceId: DEVICE_A, policyName: POLICY };

  async function seedRuntime(
    repository: InMemoryMitigationRepository,
    interfaceId: string,
    state: string,
    deviceId: string = DEVICE_A,
  ) {
    const profile = await repository.upsertProfile({
      deviceId,
      policyName: POLICY,
      interfaceId,
      addressFamily: 'IPV4',
      detectedBandwidthBps: BANDWIDTH,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(profile.id, [
      { peerId: `peer-${profile.id}`, peerAddress: '10.200.201.22', primary: true },
    ]);
    await repository.upsertRuntime(profile.id, {
      state: state as 'NORMAL',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
    });
    return profile;
  }

  function buildReconcile() {
    const repository = new InMemoryMitigationRepository();
    const queue: string[] = [];
    const reads = { count: 0 };
    const reconciler = new MitigationPolicyReconciler({
      repository,
      hosts: {
        getHost: async (id) => (id === DEVICE_A || id === DEVICE_B ? device(id) : null),
      },
      readPolicy: async () => {
        reads.count += 1;
        return queue.shift() ?? READBACK_NORMAL;
      },
      now: () => NOW,
    });
    return { repository, reconciler, queue, reads };
  }

  it('preview nao grava banco e propoe o estado fisico (FAST stale MITIGATED -> NORMAL)', async () => {
    const h = buildReconcile();
    const p1 = await seedRuntime(h.repository, 'if-3066', 'MITIGATED');
    const p2 = await seedRuntime(h.repository, 'if-3065', 'NORMAL');
    h.queue.push(READBACK_NORMAL);
    const spy = vi.spyOn(h.repository, 'upsertRuntime');

    const preview = await h.reconciler.preview(scope);

    expect(spy).not.toHaveBeenCalled();
    expect(preview.state).toBe('NORMAL');
    expect(preview.targets).toEqual([
      expect.objectContaining({
        profileId: p1.id,
        runtimeState: 'MITIGATED',
        proposedRuntimeState: 'NORMAL',
        change: true,
      }),
      expect.objectContaining({ profileId: p2.id, runtimeState: 'NORMAL', change: false }),
    ]);
    expect(h.reads.count).toBe(1);
    spy.mockRestore();
  });

  it('apply local grava SOMENTE runtime, revalida com nova leitura e nao comanda Huawei', async () => {
    const h = buildReconcile();
    const p1 = await seedRuntime(h.repository, 'if-3066', 'MITIGATED');
    const p2 = await seedRuntime(h.repository, 'if-3065', 'NORMAL');
    h.queue.push(READBACK_NORMAL, READBACK_NORMAL);

    const preview = await h.reconciler.preview(scope);
    const applied = await h.reconciler.applyLocal(scope, preview.previewId);

    expect(applied.state).toBe('NORMAL');
    expect(applied.applied).toBe(2);
    expect(applied.failed).toBe(0);
    expect(await stateOf(h.repository, p1.id)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2.id)).toBe('NORMAL');
    // preview + revalidacao do apply = duas LEITURAS (nenhuma escrita).
    expect(h.reads.count).toBe(2);
  });

  it('preview stale e recusado: leitura nova diferente impede o apply', async () => {
    const h = buildReconcile();
    const p1 = await seedRuntime(h.repository, 'if-3066', 'MITIGATED');
    h.queue.push(READBACK_NORMAL);

    const preview = await h.reconciler.preview(scope);
    expect(preview.state).toBe('NORMAL');
    // O equipamento mudou entre o preview e o apply: par ativo de novo.
    h.queue.push(READBACK_ACTIVE);

    await expect(h.reconciler.applyLocal(scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
    // Nada foi gravado com o preview velho.
    expect(await stateOf(h.repository, p1.id)).toBe('MITIGATED');
  });

  it('apply local isola device com a MESMA policy por nome', async () => {
    const h = buildReconcile();
    const pA = await seedRuntime(h.repository, 'if-3066', 'MITIGATED');
    const pB = await seedRuntime(h.repository, 'if-3066', 'MITIGATED', DEVICE_B);
    h.queue.push(READBACK_NORMAL, READBACK_NORMAL);

    const preview = await h.reconciler.preview(scope);
    await h.reconciler.applyLocal(scope, preview.previewId);

    expect(await stateOf(h.repository, pA.id)).toBe('NORMAL');
    expect(await stateOf(h.repository, pB.id)).toBe('MITIGATED');
  });
});
