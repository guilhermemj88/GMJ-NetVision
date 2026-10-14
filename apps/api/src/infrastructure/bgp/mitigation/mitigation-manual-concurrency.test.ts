import { describe, expect, it } from 'vitest';
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
import { InMemoryPolicyScopeLock } from './mitigation-policy-lock';
import { inspectPolicyMitigation } from './mitigation-policy-physical';
import { MitigationAutoEngine } from '../../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../../worker/mitigation/mitigation-traffic-source';

// QA DAS CORRECOES F3 (nunca instalar um SEGUNDO par) e F4 (serializacao por
// deviceId + policyName), com as DUAS barreiras ativas:
//
//  1) lock de escopo  -> serializa o ciclo inteiro (runtime -> preflight ->
//     escrita -> read-back -> sincronizacao);
//  2) preflight fisico -> inspeciona a POLICY INTEIRA no read-back real
//     (`display route-policy`): ACTIVATE so em policy NORMAL; REMOVE bloqueado
//     com estrutura ambigua.
//
// O fake espelha o executor real (occupancy + existingNodes + inspector F3) e
// permite congelar a operacao nos pontos de exposicao para provar QUE o segundo
// comando NAO entra no preflight enquanto o primeiro detém o lock.
//
// INVARIANTE (assertInvariant): runtime MITIGATED exige o par fisico ativo;
// runtime NORMAL exige ausencia do par; RECONCILIATION_REQUIRED libera.

const DEVICE_A = 'host-f1a';
const DEVICE_B = 'host-outro';
const POLICY_V4 = 'PL-FLASH-TELECOM_IPv4-IN';
const POLICY_ALT = 'PL-FLASH-TELECOM_OUTCONTAGEM-IN';
const RT = '268568:660';
const BANDWIDTH = 10_000_000_000n;
const NOW = new Date('2026-10-12T15:00:00.000Z');
const BASELINE_NODES = [10, 999];
const PAIR_A = { bogonNode: 1, mitigationNode: 2 };
const PAIR_B = { bogonNode: 5, mitigationNode: 6 };

type NodePair = { bogonNode: number; mitigationNode: number };

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Deixa a fila de microtasks/fakes in-memory drenar antes de assertar "nao comecou". */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Gate {
  gated: () => Promise<void>;
  arrived: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  const arrived = deferred();
  const release = deferred();
  return {
    gated: async () => {
      arrived.resolve();
      await release.promise;
    },
    arrived: arrived.promise,
    release: release.resolve,
  };
}

/**
 * Equipamento controlavel com a MESMA semantica do executor real: o read-back
 * `display route-policy` e a fonte da verdade fisica (inspector F3), nodes
 * ocupados e snapshot do discovery bloqueiam o ACTIVATE.
 */
class ControlledDevice implements MitigationLiveExecutorPort {
  /** Estado fisico POR POLICY: cada policy tem nodes/pares proprios. */
  private readonly states = new Map<string, { nodes: Set<number>; pairs: NodePair[] }>();
  activations: NodePair[] = [];
  removals: NodePair[] = [];
  readBacks = 0;
  preflights = 0;
  failAfterActivate = false;
  failAfterRemove = false;
  /** Read-back inconclusivo (N): a policy nao aparece na saida. */
  readBackInconclusive = false;
  /** RT aplicada pelo node de mitigacao errada (O). */
  wrongRt = false;
  /** Read-back 100% customizado (estruturas L/M/K). */
  renderOverride: string | null = null;
  /** Exceção no preflight (R): libera o lock via finally. */
  throwPreflightOnce = false;
  preflightGates: Array<Gate | undefined> = [];
  beforeWriteGates: Array<Gate | undefined> = [];
  afterWriteGates: Array<Gate | undefined> = [];
  beforeReadBackGates: Array<Gate | undefined> = [];
  private preflightIndex = 0;
  private beforeWriteIndex = 0;
  private afterWriteIndex = 0;
  private beforeReadBackIndex = 0;

  private state(policyName: string): { nodes: Set<number>; pairs: NodePair[] } {
    let current = this.states.get(policyName);
    if (!current) {
      current = { nodes: new Set<number>(BASELINE_NODES), pairs: [] };
      this.states.set(policyName, current);
    }
    return current;
  }

  /** Estado da policy principal (compatibilidade dos testes). */
  get nodes(): Set<number> {
    return this.state(POLICY_V4).nodes;
  }

  set nodes(value: Set<number>) {
    this.state(POLICY_V4).nodes = value;
  }

  get pairs(): NodePair[] {
    return this.state(POLICY_V4).pairs;
  }

  set pairs(value: NodePair[]) {
    this.state(POLICY_V4).pairs = value;
  }

  enabledFor(): boolean {
    return true;
  }

  private sortedNodes(policyName: string): number[] {
    return [...this.state(policyName).nodes].sort((left, right) => left - right);
  }

  hasPair(pair: NodePair): boolean {
    return this.pairs.some(
      (active) =>
        active.bogonNode === pair.bogonNode && active.mitigationNode === pair.mitigationNode,
    );
  }

  /** Exatamente o formato que o parser/inspector reais esperam. */
  private renderPolicy(policyName: string): string {
    if (this.renderOverride !== null) return this.renderOverride;
    if (this.readBackInconclusive) {
      return `route-policy PL-OUTRA permit node 1\nroute-policy PL-OUTRA permit node 2`;
    }
    const lines: string[] = [];
    for (const pair of this.state(policyName).pairs) {
      lines.push(
        `route-policy ${policyName} deny node ${pair.bogonNode}`,
        ' if-match ip-prefix BOGONS',
        `route-policy ${policyName} permit node ${pair.mitigationNode}`,
        ' if-match ip-prefix PREFIX8to24',
        ` apply extcommunity rt ${this.wrongRt ? '268568:999' : RT} additive`,
      );
    }
    lines.push(`route-policy ${policyName} permit node 10`);
    lines.push(`route-policy ${policyName} deny node 999`);
    return lines.join('\n');
  }

  private inspect(policyName: string, rt: string) {
    return inspectPolicyMitigation({
      policyName,
      readBack: this.renderPolicy(policyName),
      rts: [rt],
      labels: { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' },
    });
  }

  async resolveActivePair(
    _device?: HostRecord,
    policyName?: string,
  ): Promise<NodePair | null> {
    const active = this.state(policyName ?? POLICY_V4).pairs[0];
    return active ? { ...active } : null;
  }

  async preflight(
    _device: HostRecord,
    input: MitigationPreflightInput,
  ): Promise<MitigationPreflightResult> {
    const snapshot = this.sortedNodes(input.policyName);
    const currentGate = this.preflightGates[this.preflightIndex];
    this.preflightIndex += 1;
    if (currentGate) await currentGate.gated();
    this.preflights += 1;
    if (this.throwPreflightOnce) {
      this.throwPreflightOnce = false;
      throw new Error('SSH caiu no preflight');
    }

    const reasons: string[] = [];
    const physical = this.inspect(input.policyName, input.rt);
    if (input.mode === 'ACTIVATE') {
      if (snapshot.includes(input.bogonNode)) reasons.push(`node ${input.bogonNode} ja ocupado`);
      if (snapshot.includes(input.mitigationNode)) {
        reasons.push(`node ${input.mitigationNode} ja ocupado`);
      }
      const expected = input.expectedExistingNodes;
      if (expected === null) {
        reasons.push('sem snapshot do discovery para comparar existingNodes');
      } else if (expected.join(',') !== snapshot.join(',')) {
        reasons.push(`esperado [${expected.join(', ')}], lido [${snapshot.join(', ')}]`);
      }
      if (physical.state !== 'NORMAL') {
        reasons.push(`policy_mitigation_scope: ${physical.detail}`);
      }
    } else {
      if (!snapshot.includes(input.bogonNode) && !snapshot.includes(input.mitigationNode)) {
        reasons.push('par ausente na policy');
      }
      if (physical.state === 'RECONCILIATION_REQUIRED') {
        // Mesma mensagem do executor real (F3-REMOVE).
        reasons.push(
          `policy_mitigation_scope: ${physical.detail} (reconciliacao obrigatoria antes de retirar)`,
        );
      }
    }
    return {
      ok: reasons.length === 0,
      mode: input.mode,
      deviceId: _device.id,
      deviceName: _device.id,
      deviceHost: '10.0.0.1',
      policyName: input.policyName,
      existingNodes: snapshot,
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
      bogonPrefixList: input.bogonPrefixList,
      bogonPrefixListExists: true,
      targetPrefixList: input.targetPrefixList,
      targetPrefixListExists: true,
      rt: input.rt,
      sshReadBackOk: true,
      bogonNodeExists: snapshot.includes(input.bogonNode),
      bogonNodeMatches: snapshot.includes(input.bogonNode),
      mitigationNodeExists: snapshot.includes(input.mitigationNode),
      mitigationNodeMatches: snapshot.includes(input.mitigationNode),
      partial: false,
      readBackNodes: snapshot,
      readBackSummary: reasons.length === 0 ? 'ok' : reasons.join('; '),
      readBackExcerpt: '',
      checks: [],
      blockedReasons: reasons,
    };
  }

  async activate(_device: HostRecord, input: MitigationActivationInput): Promise<{ output: string }> {
    const beforeGate = this.beforeWriteGates[this.beforeWriteIndex];
    this.beforeWriteIndex += 1;
    if (beforeGate) await beforeGate.gated();
    const pair = { bogonNode: input.bogonNode, mitigationNode: input.mitigationNode };
    const state = this.state(input.policyName);
    this.activations.push(pair);
    state.nodes.add(pair.bogonNode);
    state.nodes.add(pair.mitigationNode);
    state.pairs.push(pair);
    if (this.failAfterActivate) {
      this.failAfterActivate = false;
      throw new Error('SSH timeout depois da escrita');
    }
    const afterGate = this.afterWriteGates[this.afterWriteIndex];
    this.afterWriteIndex += 1;
    if (afterGate) await afterGate.gated();
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }> {
    const beforeGate = this.beforeWriteGates[this.beforeWriteIndex];
    this.beforeWriteIndex += 1;
    if (beforeGate) await beforeGate.gated();
    const pair = { bogonNode: input.bogonNode, mitigationNode: input.mitigationNode };
    const state = this.state(input.policyName);
    this.removals.push(pair);
    state.nodes.delete(pair.bogonNode);
    state.nodes.delete(pair.mitigationNode);
    state.pairs = state.pairs.filter(
      (active) =>
        active.bogonNode !== pair.bogonNode || active.mitigationNode !== pair.mitigationNode,
    );
    if (this.failAfterRemove) {
      this.failAfterRemove = false;
      throw new Error('SSH timeout depois da escrita');
    }
    const afterGate = this.afterWriteGates[this.afterWriteIndex];
    this.afterWriteIndex += 1;
    if (afterGate) await afterGate.gated();
    return { output: 'ok' };
  }

  async readRoutePolicy(_device: HostRecord, policyName: string): Promise<string> {
    const currentGate = this.beforeReadBackGates[this.beforeReadBackIndex];
    this.beforeReadBackIndex += 1;
    if (currentGate) await currentGate.gated();
    this.readBacks += 1;
    return this.renderPolicy(policyName);
  }
}

interface SeedOptions {
  policies?: [string, string];
  pairs?: [NodePair, NodePair];
  runtimeStates?: [string, string];
  deviceB?: boolean;
  expectedNodes?: () => Promise<number[] | null>;
  lockTimeoutMs?: number;
}

async function setup(options: SeedOptions = {}) {
  const repository = new InMemoryMitigationRepository();
  const live = new ControlledDevice();
  const policies = options.policies ?? [POLICY_V4, POLICY_V4];
  const pairs = options.pairs ?? [PAIR_A, PAIR_A];
  const states = options.runtimeStates ?? ['NORMAL', 'NORMAL'];
  const profileIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const profile = await repository.upsertProfile({
      deviceId: DEVICE_A,
      policyName: policies[index]!,
      interfaceId: `if-${index + 1}`,
      addressFamily: 'IPV4',
      detectedBandwidthBps: BANDWIDTH,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(profile.id, [
      { peerId: `peer-${index}`, peerAddress: `10.200.201.${20 + index}`, primary: true },
    ]);
    const pair = pairs[index]!;
    await repository.upsertRuntime(profile.id, {
      state: states[index] as 'NORMAL',
      plannedBogonNode: pair.bogonNode,
      plannedMitigationNode: pair.mitigationNode,
      plannedNode: pair.mitigationNode,
    });
    profileIds.push(profile.id);
  }
  if (options.deviceB) {
    const other = await repository.upsertProfile({
      deviceId: DEVICE_B,
      policyName: POLICY_V4,
      interfaceId: 'if-b',
      addressFamily: 'IPV4',
      detectedBandwidthBps: BANDWIDTH,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(other.id, [
      { peerId: 'peer-b', peerAddress: '10.200.201.99', primary: true },
    ]);
    await repository.upsertRuntime(other.id, {
      state: 'NORMAL',
      plannedBogonNode: PAIR_A.bogonNode,
      plannedMitigationNode: PAIR_A.mitigationNode,
      plannedNode: PAIR_A.mitigationNode,
    });
    profileIds.push(other.id);
  }

  const commands = new MitigationCommandService({
    repository,
    hosts: {
      getHost: async (id) => (id === DEVICE_A || id === DEVICE_B ? device(id) : null),
    },
    executor: new MockMitigationExecutor(),
    live,
    scopeLock: new InMemoryPolicyScopeLock(
      options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs },
    ),
    expectedNodes: options.expectedNodes ?? (async () => BASELINE_NODES),
    now: () => NOW,
  });

  return { repository, live, commands, profileIds };
}

const stateOf = async (repository: InMemoryMitigationRepository, profileId: string) =>
  (await repository.getRuntime(profileId))?.state ?? null;

async function assertInvariant(
  harness: Awaited<ReturnType<typeof setup>>,
  pairs: Array<NodePair | undefined>,
): Promise<void> {
  for (let index = 0; index < harness.profileIds.length; index += 1) {
    const profileId = harness.profileIds[index]!;
    const pair = pairs[index];
    if (!pair) continue;
    const state = await stateOf(harness.repository, profileId);
    const present = harness.live.hasPair(pair);
    if (state === 'MITIGATED') {
      expect(present, `profile ${profileId} MITIGATED sem par fisico ativo`).toBe(true);
    }
    if (state === 'NORMAL') {
      expect(present, `profile ${profileId} NORMAL com par fisico ativo`).toBe(false);
    }
  }
}

function buildEngine(
  h: Awaited<ReturnType<typeof setup>>,
  traffic: SequenceTrafficSource,
) {
  return new MitigationAutoEngine({
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE_A] },
    targets: {
      list: async () => {
        const records = await h.repository.listProfiles();
        const rows = [];
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index]!;
          const runtime = await h.repository.getRuntime(record.id);
          rows.push({
            profileId: record.id,
            deviceId: record.deviceId,
            policyName: record.policyName,
            interfaceId: record.interfaceId,
            customer: `CLIENTE ${index + 1}`,
            mode: 'AUTO' as const,
            snapshotAvailable: true,
            readiness: 'READY' as const,
            prefixStatus: 'SAFE' as const,
            blockedReason: null,
            mitigationExcluded: false,
            runtimeState: runtime?.state ?? null,
            effectiveBandwidthBps: record.detectedBandwidthBps,
            bogonNode: runtime?.plannedBogonNode ?? null,
            mitigationNode: runtime?.plannedMitigationNode ?? null,
            sharedPolicy: true,
            peerAddresses: [`10.200.201.${20 + index}`],
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
    commands: { execute: (input) => h.commands.execute(input) },
    now: () => NOW,
  });
}

describe('F4: serializacao por deviceId + policyName', () => {
  it('A1) ACTIVATE+ACTIVATE (mesmo par): o segundo comando espera no lock e e bloqueado pelo F3; UMA escrita', async () => {
    const h = await setup();
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    const g = gate();
    h.live.afterWriteGates = [g];

    const first = h.commands.execute({ requestId: 'a1-p1', action: 'ACTIVATE', profileId: p1 });
    await g.arrived;
    expect(h.live.activations).toHaveLength(1);

    const second = h.commands.execute({ requestId: 'a1-p2', action: 'ACTIVATE', profileId: p2 });
    // F4: enquanto o primeiro detem o lock, o segundo NEM entra no preflight.
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await flush();
    expect(h.live.preflights).toBe(1);
    expect(secondDone).toBe(false);

    g.release();
    const firstResult = await first;
    const secondResult = await second;

    expect(firstResult.status).toBe('ACTIVATED_VERIFIED');
    // F3: a policy ja esta mitigada fisicamente - segunda escrita proibida.
    expect(secondResult.status).toBe('REVALIDATION_FAILED');
    expect(secondResult.preflight?.ok).toBe(false);
    expect(secondResult.safeError ?? '').toContain('policy_mitigation_scope');
    expect(h.live.activations).toEqual([PAIR_A]);
    expect(h.live.pairs).toEqual([PAIR_A]);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('A2) ACTIVATE+ACTIVATE com planos divergentes: serializado, UMA escrita e ZERO par orfao', async () => {
    const h = await setup({ pairs: [PAIR_A, PAIR_B] });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    const g = gate();
    h.live.afterWriteGates = [g];

    const first = h.commands.execute({ requestId: 'a2-p1', action: 'ACTIVATE', profileId: p1 });
    await g.arrived;
    const second = h.commands.execute({ requestId: 'a2-p2', action: 'ACTIVATE', profileId: p2 });
    await flush();
    expect(h.live.activations).toEqual([PAIR_A]);
    g.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.verified).toBe(true);
    // O segundo plano (5/6) ficaria LIVRE: so o F3 (policy ja mitigada) barra.
    expect(secondResult.status).toBe('REVALIDATION_FAILED');
    expect(secondResult.safeError ?? '').toContain('policy_mitigation_scope');
    expect(h.live.activations).toEqual([PAIR_A]);
    expect(h.live.pairs).toEqual([PAIR_A]);
    expect(h.live.nodes.has(5)).toBe(false);
    expect(h.live.nodes.has(6)).toBe(false);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('B1) ACTIVATE (verificado) + REMOVE concorrente: serializado e consistente ponta a ponta', async () => {
    const h = await setup();
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    const g = gate();
    h.live.afterWriteGates = [g];

    const activate = h.commands.execute({ requestId: 'b1-act', action: 'ACTIVATE', profileId: p1 });
    await g.arrived;
    const remove = h.commands.execute({ requestId: 'b1-rem', action: 'REMOVE', acknowledgeScopeRemoval: true, profileId: p2 });
    await Promise.resolve();
    expect(h.live.removals).toHaveLength(0);

    g.release();
    const activated = await activate;
    const removed = await remove;

    expect(activated.status).toBe('ACTIVATED_VERIFIED');
    expect(removed.status).toBe('REMOVED_VERIFIED');
    expect(h.live.activations).toEqual([PAIR_A]);
    expect(h.live.removals).toEqual([PAIR_A]);
    expect(h.live.pairs).toHaveLength(0);
    expect([...h.live.nodes].sort((a, b) => a - b)).toEqual(BASELINE_NODES);
    expect(await stateOf(h.repository, p1)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2)).toBe('NORMAL');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('B2) REMOVE (verificado) + ACTIVATE concorrente: snapshot defasado bloqueia a ativacao (fail-closed)', async () => {
    const h = await setup({
      runtimeStates: ['MITIGATED', 'MITIGATED'],
      expectedNodes: async () => [1, 2, 10, 999],
    });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    h.live.nodes = new Set([1, 2, 10, 999]);
    h.live.pairs = [{ ...PAIR_A }];
    const g = gate();
    h.live.beforeWriteGates = [g];

    const remove = h.commands.execute({ requestId: 'b2-rem', action: 'REMOVE', acknowledgeScopeRemoval: true, profileId: p1 });
    await g.arrived;
    const activate = h.commands.execute({ requestId: 'b2-act', action: 'ACTIVATE', profileId: p2 });
    await Promise.resolve();
    expect(h.live.activations).toHaveLength(0);

    g.release();
    const removed = await remove;
    const activated = await activate;

    expect(removed.status).toBe('REMOVED_VERIFIED');
    // O snapshot do discovery ainda lista 1/2; sem nova leitura a ativacao
    // NAO acontece (fail-closed) - e o runtime segue NORMAL (verdade fisica).
    expect(activated.status).toBe('REVALIDATION_FAILED');
    expect(activated.preflight?.ok).toBe(false);
    expect(h.live.activations).toHaveLength(0);
    expect(h.live.pairs).toHaveLength(0);
    expect(await stateOf(h.repository, p1)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2)).toBe('NORMAL');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('C) REMOVE+REMOVE: serializado; UMA retirada e o segundo comando bloqueado (par ausente)', async () => {
    const h = await setup({
      runtimeStates: ['MITIGATED', 'MITIGATED'],
      expectedNodes: async () => [1, 2, 10, 999],
    });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    h.live.nodes = new Set([1, 2, 10, 999]);
    h.live.pairs = [{ ...PAIR_A }];
    const g = gate();
    h.live.afterWriteGates = [g];

    const first = h.commands.execute({ requestId: 'c-1', action: 'REMOVE', acknowledgeScopeRemoval: true, profileId: p1 });
    await g.arrived;
    const second = h.commands.execute({ requestId: 'c-2', action: 'REMOVE', acknowledgeScopeRemoval: true, profileId: p2 });
    g.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('REMOVED_VERIFIED');
    expect(secondResult.status).toBe('REVALIDATION_FAILED');
    expect(secondResult.safeError ?? '').toContain('par ausente');
    expect(h.live.removals).toEqual([PAIR_A]);
    expect([...h.live.nodes].sort((a, b) => a - b)).toEqual(BASELINE_NODES);
    expect(await stateOf(h.repository, p1)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2)).toBe('NORMAL');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('D) AUTO ACTIVATE + REMOVE manual: o REMOVE espera no lock e o estado final e consistente', async () => {
    const h = await setup();
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    const g = gate();
    h.live.afterWriteGates = [g];

    const traffic = new SequenceTrafficSource();
    const engine = buildEngine(h, traffic);
    const over = (BANDWIDTH * 95n) / 100n;
    for (let index = 0; index < 3; index += 1) {
      traffic.push(p1, over);
      traffic.push(p2, (BANDWIDTH * 50n) / 100n);
    }

    const ticks = [engine.tick(), engine.tick(), engine.tick()];
    await g.arrived;
    expect(h.live.activations).toHaveLength(1);

    const remove = h.commands.execute({ requestId: 'd-rem', action: 'REMOVE', acknowledgeScopeRemoval: true, profileId: p2 });
    let removeDone = false;
    void remove.then(() => {
      removeDone = true;
    });
    await flush();
    // O manual NAO roda durante o lock do AUTO (F4): zero retirada concorrente.
    expect(removeDone).toBe(false);
    expect(h.live.removals).toHaveLength(0);

    g.release();
    const [allDecisions, removed] = await Promise.all([Promise.all(ticks), remove]);

    expect(
      allDecisions.flat().some((decision) => decision.profileId === p1),
    ).toBe(true);
    expect(removed.status).toBe('REMOVED_VERIFIED');
    expect(h.live.activations).toEqual([PAIR_A]);
    expect(h.live.removals).toEqual([PAIR_A]);
    expect(await stateOf(h.repository, p1)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2)).toBe('NORMAL');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('D2) AUTO ACTIVATE + ACTIVATE manual: UMA ativacao fisica', async () => {
    const h = await setup();
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    const g = gate();
    h.live.preflightGates = [g];

    const manual = h.commands.execute({ requestId: 'd2-manual', action: 'ACTIVATE', profileId: p1 });
    await g.arrived;

    const traffic = new SequenceTrafficSource();
    const engine = buildEngine(h, traffic);
    const over = (BANDWIDTH * 95n) / 100n;
    for (let index = 0; index < 3; index += 1) {
      traffic.push(p2, over);
    }
    const ticks = [engine.tick(), engine.tick(), engine.tick()];
    await flush();
    g.release();
    const manualResult = await manual;
    await Promise.all(ticks);

    expect(manualResult.verified).toBe(true);
    // Nenhuma ativacao extra: o AUTO fica atras do lock e depois encontra a
    // policy ja mitigada (F3/quarda de escopo). Nenhum par extra e nenhum
    // runtime declara MITIGATED sem prova fisica.
    expect(h.live.activations).toEqual([PAIR_A]);
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('F) MESMA policyName em devices DIFERENTES: locks independentes rodam EM PARALELO', async () => {
    const h = await setup({ deviceB: true });
    const [p1, p2, pB] = h.profileIds as [string, string, string, ...string[]];
    const g = gate();
    h.live.preflightGates = [g];

    const first = h.commands.execute({ requestId: 'f-a', action: 'ACTIVATE', profileId: p1 });
    await g.arrived;
    // O device B compartilha o NOME da policy, mas o lock e por deviceId:
    // a operacao do device A NAO segura o device B (roda e conclui agora).
    const second = await h.commands.execute({
      requestId: 'f-b',
      action: 'REMOVE',
      acknowledgeScopeRemoval: true,
      profileId: pB,
    });
    expect(second.status).toBe('REVALIDATION_FAILED');
    expect(second.safeError ?? '').toContain('par ausente');
    expect(await stateOf(h.repository, pB)).toBe('NORMAL');

    g.release();
    const activated = await first;
    expect(activated.verified).toBe(true);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
    expect(await stateOf(h.repository, pB)).toBe('NORMAL');
    await assertInvariant(h, [PAIR_A, PAIR_A, undefined]);
  });

  it('H) DUAS policies no MESMO device: locks independentes rodam EM PARALELO', async () => {
    const h = await setup({ policies: [POLICY_V4, POLICY_ALT] });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    const g = gate();
    h.live.preflightGates = [g];

    const first = h.commands.execute({ requestId: 'h-1', action: 'ACTIVATE', profileId: p1 });
    await g.arrived;
    // Policy diferente no MESMO equipamento: o lock de escopo nao serializa.
    const second = h.commands.execute({ requestId: 'h-2', action: 'ACTIVATE', profileId: p2 });
    const secondResult = await second;
    expect(secondResult.verified).toBe(true);

    g.release();
    const firstResult = await first;
    expect(firstResult.verified).toBe(true);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
  });

  it('Q) timeout de aquisicao: POLICY_BUSY, ZERO escrita, lock liberado depois', async () => {
    const h = await setup({ lockTimeoutMs: 60 });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    const g = gate();
    h.live.afterWriteGates = [g];

    const first = h.commands.execute({ requestId: 'q-1', action: 'ACTIVATE', profileId: p1 });
    await g.arrived;

    const busy = await h.commands.execute({
      requestId: 'q-2',
      action: 'ACTIVATE',
      profileId: p2,
    });
    expect(busy.ok).toBe(false);
    expect(busy.status).toBe('POLICY_BUSY');
    expect(busy.safeError ?? '').toContain('ocupada');
    // Nenhuma escrita/entrada em preflight do comando recusado.
    expect(h.live.activations).toHaveLength(1);
    expect(h.live.preflights).toBe(1);

    g.release();
    const firstResult = await first;
    expect(firstResult.status).toBe('ACTIVATED_VERIFIED');

    // O lock foi liberado: uma NOVA operacao no escopo (REMOVE) funciona.
    const later = await h.commands.execute({ requestId: 'q-3', action: 'REMOVE', acknowledgeScopeRemoval: true, profileId: p1 });
    expect(later.status).toBe('REMOVED_VERIFIED');
    expect(await stateOf(h.repository, p1)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2)).toBe('NORMAL');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });

  it('R) exception durante o lock: propaga, NAO escreve e o lock e liberado (finally)', async () => {
    const h = await setup();
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    h.live.throwPreflightOnce = true;

    await expect(
      h.commands.execute({ requestId: 'r-1', action: 'ACTIVATE', profileId: p1 }),
    ).rejects.toThrow('SSH caiu no preflight');
    expect(h.live.activations).toHaveLength(0);

    // Lock liberado: a proxima operacao do MESMO escopo roda normalmente.
    const retry = await h.commands.execute({ requestId: 'r-2', action: 'ACTIVATE', profileId: p2 });
    expect(retry.status).toBe('ACTIVATED_VERIFIED');
    expect(h.live.activations).toEqual([PAIR_A]);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });
});

describe('F3: segundo par proibido e estruturas ambiguas', () => {
  it('I/J) profile NOVO (plano 3/4) com par 1/2 ativo: AUTO nao tenta (SCOPE_ALREADY_MITIGATED) e o manual e bloqueado no FISICO', async () => {
    const h = await setup({
      runtimeStates: ['MITIGATED', 'NORMAL'],
      expectedNodes: async () => [1, 2, 10, 999],
    });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    h.live.nodes = new Set([1, 2, 10, 999]);
    h.live.pairs = [{ ...PAIR_A }];
    await h.repository.upsertRuntime(p2, {
      state: 'NORMAL',
      plannedBogonNode: 3,
      plannedMitigationNode: 4,
      plannedNode: 4,
    });

    // AUTO: o irmao MITIGATED do mesmo escopo interrompe antes do preflight.
    const traffic = new SequenceTrafficSource();
    const engine = buildEngine(h, traffic);
    const over = (BANDWIDTH * 95n) / 100n;
    let decisions: Awaited<ReturnType<typeof engine.tick>> = [];
    for (let index = 0; index < 3; index += 1) {
      traffic.push(p1, (BANDWIDTH * 50n) / 100n);
      traffic.push(p2, over);
      decisions = await engine.tick();
    }
    const novo = decisions.find((decision) => decision.profileId === p2);
    expect(novo?.outcome).toBe('NO_ACTION');
    expect(novo?.reason).toBe('SCOPE_ALREADY_MITIGATED');
    expect(h.live.preflights).toBe(0);

    // Manual: o preflight fisico bloqueia (3/4 livres; SO o F3 pode barrar).
    const manual = await h.commands.execute({
      requestId: 'ij-manual',
      action: 'ACTIVATE',
      profileId: p2,
    });
    expect(manual.status).toBe('REVALIDATION_FAILED');
    expect(manual.safeError ?? '').toContain('par de mitigacao ativo');
    expect(h.live.activations).toHaveLength(0);
    expect(h.live.pairs).toEqual([PAIR_A]);
    // O novo profile NUNCA vira MITIGATED sem prova fisica (ele segue no ciclo
    // proprio do AUTO: TRIGGER_PENDING/NORMAL - nunca MITIGATED "de graca").
    expect(await stateOf(h.repository, p2)).not.toBe('MITIGATED');
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
  });

  it('K) DOS pares fisicos (1/2 + 3/4): ACTIVATE e REMOVE bloqueados, zero escrita', async () => {
    const h = await setup({
      runtimeStates: ['MITIGATED', 'MITIGATED'],
      expectedNodes: async () => [1, 2, 3, 4, 10, 999],
    });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    h.live.nodes = new Set([1, 2, 3, 4, 10, 999]);
    h.live.pairs = [{ ...PAIR_A }, { bogonNode: 3, mitigationNode: 4 }];

    const activate = await h.commands.execute({
      requestId: 'k-act',
      action: 'ACTIVATE',
      profileId: p2,
    });
    expect(activate.status).toBe('REVALIDATION_FAILED');
    expect(activate.safeError ?? '').toContain('multipla');

    const remove = await h.commands.execute({
      requestId: 'k-rem',
      action: 'REMOVE',
      acknowledgeScopeRemoval: true,
      profileId: p1,
    });
    // Retirar UM par deixaria o outro ativo "sem dono": bloqueado.
    expect(remove.status).toBe('REVALIDATION_FAILED');
    expect(remove.safeError ?? '').toContain('reconciliacao');
    expect(h.live.activations).toHaveLength(0);
    expect(h.live.removals).toHaveLength(0);
    expect(h.live.pairs).toHaveLength(2);
  });

  it('L) estrutura PARCIAL (apenas node BOGONS): ACTIVATE e REMOVE bloqueados', async () => {
    const h = await setup({
      runtimeStates: ['MITIGATED', 'MITIGATED'],
      expectedNodes: async () => [1, 10, 999],
    });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    h.live.nodes = new Set([1, 10, 999]);
    h.live.renderOverride = [
      `route-policy ${POLICY_V4} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY_V4} permit node 10`,
      `route-policy ${POLICY_V4} deny node 999`,
    ].join('\n');

    const activate = await h.commands.execute({
      requestId: 'l-act',
      action: 'ACTIVATE',
      profileId: p2,
    });
    expect(activate.status).toBe('REVALIDATION_FAILED');
    expect(activate.safeError ?? '').toContain('BOGONS');

    const remove = await h.commands.execute({
      requestId: 'l-rem',
      action: 'REMOVE',
      acknowledgeScopeRemoval: true,
      profileId: p1,
    });
    expect(remove.status).toBe('REVALIDATION_FAILED');
    expect(h.live.activations).toHaveLength(0);
    expect(h.live.removals).toHaveLength(0);
  });

  it('M) nodes INCOMPATIVEIS (permit com BOGONS): escrita bloqueada', async () => {
    const h = await setup();
    const [p1] = h.profileIds as [string, string, ...string[]];
    h.live.renderOverride = [
      `route-policy ${POLICY_V4} permit node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY_V4} permit node 10`,
    ].join('\n');

    const activate = await h.commands.execute({
      requestId: 'm-act',
      action: 'ACTIVATE',
      profileId: p1,
    });
    expect(activate.status).toBe('REVALIDATION_FAILED');
    expect(activate.safeError ?? '').toContain('incompativel');
    expect(h.live.activations).toHaveLength(0);
  });

  it('N) read-back INCONCLUSIVO (policy ausente na saida): escrita bloqueada', async () => {
    const h = await setup();
    const [p1] = h.profileIds as [string, string, ...string[]];
    h.live.readBackInconclusive = true;

    const activate = await h.commands.execute({
      requestId: 'n-act',
      action: 'ACTIVATE',
      profileId: p1,
    });
    expect(activate.status).toBe('REVALIDATION_FAILED');
    expect(activate.safeError ?? '').toContain('nao encontrada no read-back');
    expect(h.live.activations).toHaveLength(0);
  });

  it('O) RT INCORRETA no node de mitigacao: escrita bloqueada', async () => {
    const h = await setup({
      pairs: [PAIR_A, PAIR_B],
      expectedNodes: async () => [1, 2, 10, 999],
    });
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    expect(p1).toBeTruthy();
    h.live.nodes = new Set([1, 2, 10, 999]);
    h.live.pairs = [{ ...PAIR_A }];
    h.live.wrongRt = true;

    // p2 planeja 5/6 (livres): SO o node suspeito (RT errada) pode bloquear.
    const activate = await h.commands.execute({
      requestId: 'o-act',
      action: 'ACTIVATE',
      profileId: p2,
    });
    expect(activate.status).toBe('REVALIDATION_FAILED');
    expect(activate.safeError ?? '').toContain('RT de mitigacao');
    expect(h.live.activations).toHaveLength(0);
    expect(h.live.nodes.has(5)).toBe(false);
    expect(h.live.nodes.has(6)).toBe(false);
  });

  it('P) falha DEPOIS da escrita: escopo RECONCILIATION_REQUIRED; REMOVE verificado restaura com prova', async () => {
    const h = await setup();
    const [p1, p2] = h.profileIds as [string, string, ...string[]];
    h.live.failAfterActivate = true;

    const failed = await h.commands.execute({
      requestId: 'p-act',
      action: 'ACTIVATE',
      profileId: p1,
    });
    expect(failed.verified).toBe(false);
    expect(await stateOf(h.repository, p1)).toBe('RECONCILIATION_REQUIRED');
    expect(await stateOf(h.repository, p2)).toBe('RECONCILIATION_REQUIRED');
    expect(h.live.hasPair(PAIR_A)).toBe(true);

    const removed = await h.commands.execute({
      requestId: 'p-rem',
      action: 'REMOVE',
      acknowledgeScopeRemoval: true,
      profileId: p2,
    });
    expect(removed.status).toBe('REMOVED_VERIFIED');
    expect(await stateOf(h.repository, p1)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2)).toBe('NORMAL');
    await assertInvariant(h, [PAIR_A, PAIR_A]);
  });
});
