import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from '../../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import {
  MitigationCommandService,
  type MitigationLiveExecutorPort,
} from '../../infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from '../../infrastructure/bgp/mitigation/mitigation-executor';
import type {
  MitigationActivationInput,
  MitigationRemovalInput,
} from '../../infrastructure/bgp/mitigation/mitigation-executor';
import type {
  MitigationPreflightInput,
  MitigationPreflightResult,
} from '../../infrastructure/bgp/mitigation/huawei-mitigation-executor';
import { inspectPolicyMitigation } from '../../infrastructure/bgp/mitigation/mitigation-policy-physical';
import { InMemoryPolicyScopeLock } from '../../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { MitigationAutoEngine } from './mitigation-auto-engine';
import { SequenceTrafficSource } from './mitigation-traffic-source';

// AUD-AUTO-ALL: validacao MULTI-ASN em route-policy compartilhada (-IN).
//
// A unidade de acao BGP e a POLICY (deviceId + policyName); a deteccao e por
// interface. ASNs diferentes NAO sao bloqueio: o escopo nunca consulta o ASN
// dos peers (prova por fixtures espelhando a JUSTNET: 4 interfaces, 3 ASNs).
// Cenarios: 2 ASNs / 4 interfaces / ataques simultaneos / recuperacao parcial
// (nunca remove sozinho) / REMOVE manual protegido / lock e deduplicacao.

const DEVICE_A = 'host-f1a';
const POLICY_V4 = 'PL-JUSTNET-IPv4-IN';
const RT = '268568:660';
const BANDWIDTH = 10_000_000_000n;
const NOW = new Date('2026-10-14T15:00:00.000Z');
const BASELINE_NODES = [10, 999];
const PAIR = { bogonNode: 1, mitigationNode: 2 };

// Peers reais da JUSTNET (ASNs distintos na MESMA policy -IN).
const JUSTNET_PEERS = [
  { peerId: 'peer-as271217', peerAddress: '10.200.201.226' },
  { peerId: 'peer-as262663', peerAddress: '10.200.201.230' },
  { peerId: 'peer-as264886-a', peerAddress: '10.200.201.66' },
  { peerId: 'peer-as264886-b', peerAddress: '10.200.201.70' },
];

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

/** Executor live fiel ao equipamento (mesma semantica do shared-policy.test). */
class DeviceTruthExecutor implements MitigationLiveExecutorPort {
  nodes = new Set<number>(BASELINE_NODES);
  activateCalls = 0;
  removeCalls = 0;

  enabledFor(): boolean {
    return true;
  }

  async resolveActivePair(): Promise<{ bogonNode: number; mitigationNode: number } | null> {
    return this.nodes.has(PAIR.bogonNode) && this.nodes.has(PAIR.mitigationNode)
      ? { ...PAIR }
      : null;
  }

  async preflight(
    _device: HostRecord,
    input: MitigationPreflightInput,
  ): Promise<MitigationPreflightResult> {
    const reasons: string[] = [];
    const current = [...this.nodes].sort((a, b) => a - b);
    if (input.mode === 'ACTIVATE') {
      if (this.nodes.has(input.bogonNode)) reasons.push(`node ${input.bogonNode} ja ocupado`);
      if (this.nodes.has(input.mitigationNode)) {
        reasons.push(`node ${input.mitigationNode} ja ocupado`);
      }
      const expected = input.expectedExistingNodes;
      if (expected === null) reasons.push('sem snapshot do discovery para comparar');
      else if (expected.join(',') !== current.join(',')) reasons.push('existingNodes divergente');
      const physical = inspectPolicyMitigation({
        policyName: input.policyName,
        readBack: this.renderPolicy(input.policyName),
        rts: [input.rt],
        labels: {
          bogonPrefixList: input.bogonPrefixList,
          targetPrefixList: input.targetPrefixList,
        },
      });
      if (physical.state !== 'NORMAL') reasons.push('policy ja possui mitigacao');
    } else if (!this.nodes.has(input.bogonNode) && !this.nodes.has(input.mitigationNode)) {
      reasons.push('par ausente na policy');
    }
    return {
      ok: reasons.length === 0,
      mode: input.mode,
      deviceId: _device.id,
      deviceName: _device.id,
      deviceHost: '10.0.0.1',
      policyName: input.policyName,
      existingNodes: current,
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
      bogonPrefixList: input.bogonPrefixList,
      bogonPrefixListExists: true,
      targetPrefixList: input.targetPrefixList,
      targetPrefixListExists: true,
      rt: input.rt,
      sshReadBackOk: true,
      bogonNodeExists: this.nodes.has(input.bogonNode),
      bogonNodeMatches: this.nodes.has(input.bogonNode),
      mitigationNodeExists: this.nodes.has(input.mitigationNode),
      mitigationNodeMatches: this.nodes.has(input.mitigationNode),
      partial: false,
      readBackNodes: current,
      readBackSummary: reasons.length === 0 ? 'par livre' : reasons.join('; '),
      readBackExcerpt: '',
      checks: [],
      blockedReasons: reasons,
    };
  }

  async activate(_device: HostRecord, input: MitigationActivationInput): Promise<{ output: string }> {
    this.activateCalls += 1;
    this.nodes.add(input.bogonNode);
    this.nodes.add(input.mitigationNode);
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }> {
    this.removeCalls += 1;
    this.nodes.delete(input.bogonNode);
    this.nodes.delete(input.mitigationNode);
    return { output: 'ok' };
  }

  private renderPolicy(policyName: string): string {
    const lines: string[] = [];
    if (this.nodes.has(PAIR.bogonNode)) {
      lines.push(
        `route-policy ${policyName} deny node ${PAIR.bogonNode}`,
        ' if-match ip-prefix BOGONS',
      );
    }
    if (this.nodes.has(PAIR.mitigationNode)) {
      lines.push(
        `route-policy ${policyName} permit node ${PAIR.mitigationNode}`,
        ' if-match ip-prefix PREFIX8to24',
        ` apply extcommunity rt ${RT} additive`,
      );
    }
    lines.push(`route-policy ${policyName} permit node 10`);
    return lines.join('\n');
  }

  async readRoutePolicy(): Promise<string> {
    return this.renderPolicy(POLICY_V4);
  }
}

async function harness(profileCount: number) {
  const repository = new InMemoryMitigationRepository();
  const live = new DeviceTruthExecutor();
  const profileIds: string[] = [];
  for (let index = 0; index < profileCount; index += 1) {
    const profile = await repository.upsertProfile({
      deviceId: DEVICE_A,
      policyName: POLICY_V4,
      interfaceId: `if-${index + 1}`,
      addressFamily: 'IPV4',
      detectedBandwidthBps: BANDWIDTH,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(profile.id, [
      { ...JUSTNET_PEERS[index]!, primary: true },
    ]);
    await repository.upsertRuntime(profile.id, {
      state: 'NORMAL',
      plannedBogonNode: PAIR.bogonNode,
      plannedMitigationNode: PAIR.mitigationNode,
      plannedNode: PAIR.mitigationNode,
    });
    profileIds.push(profile.id);
  }

  const commands = new MitigationCommandService({
    repository,
    hosts: { getHost: async (id) => (id === DEVICE_A ? device(id) : null) },
    executor: new MockMitigationExecutor(),
    live,
    scopeLock: new InMemoryPolicyScopeLock(),
    expectedNodes: async () => BASELINE_NODES,
    now: () => NOW,
  });

  const traffic = new SequenceTrafficSource();
  const engine = new MitigationAutoEngine({
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE_A] },
    targets: {
      list: async () => {
        const records = await repository.listProfiles();
        return Promise.all(
          records.map(async (record, index) => {
            const runtime = await repository.getRuntime(record.id);
            return {
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
              peerAddresses: [JUSTNET_PEERS[index]!.peerAddress],
              triggerPercent: 90,
              recoveryPercent: 70,
              triggerSamples: 3,
              recoverySamples: 12,
            };
          }),
        );
      },
    },
    traffic,
    exclusions: { listPeerExclusions: (filter) => repository.listPeerExclusions(filter) },
    runtime: {
      get: (id) => repository.getRuntime(id),
      save: async (id, patch) => {
        await repository.upsertRuntime(id, patch);
      },
    },
    commands: { execute: (input) => commands.execute(input) },
    now: () => NOW,
  });

  const over = (BANDWIDTH * 95n) / 100n; // 9,5 Gbps > 90%
  const under = (BANDWIDTH * 50n) / 100n; // 5 Gbps < 70%

  const run = async (times: number, values: bigint[]) => {
    let last: Awaited<ReturnType<typeof engine.tick>> = [];
    for (let index = 0; index < times; index += 1) {
      values.forEach((value, position) => traffic.push(profileIds[position]!, value));
      last = await engine.tick();
    }
    return last;
  };

  return { repository, engine, traffic, live, commands, profileIds, over, under, run };
}

const stateOf = async (repository: InMemoryMitigationRepository, profileId: string) =>
  (await repository.getRuntime(profileId))?.state ?? null;

describe('AUD-AUTO-ALL: multi-ASN na mesma policy -IN (ASN nunca e bloqueio)', () => {
  it('1) DOIS ASNs distintos na mesma policy: UMA ativacao fisica e irmao sincronizado', async () => {
    const h = await harness(2);
    const [p1, p2] = h.profileIds as [string, string];

    const decisions = await h.run(3, [h.over, h.over]);

    // ASNs 271217 x 262663 diferem; a acao e da POLICY: uma unica escrita.
    expect(h.live.activateCalls).toBe(1);
    expect([...h.live.nodes].sort((a, b) => a - b)).toEqual([1, 2, 10, 999]);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
    const sibling = decisions.find((decision) => decision.profileId === p2);
    expect(sibling?.outcome).toBe('NO_ACTION');
    expect(sibling?.reason).toBe('ALREADY_MITIGATED');
  });

  it('2) QUATRO interfaces (3 ASNs, JUSTNET-like): UMA ativacao e os 4 runtimes sincronizados', async () => {
    const h = await harness(4);

    await h.run(3, [h.over, h.over, h.over, h.over]);

    expect(h.live.activateCalls).toBe(1);
    expect(h.live.removeCalls).toBe(0);
    for (const profileId of h.profileIds) {
      expect(await stateOf(h.repository, profileId)).toBe('MITIGATED');
    }
  });

  it('3) DOIS ataques simultaneos: ticks concorrentes produzem UMA unica ativacao', async () => {
    const h = await harness(4);
    for (let index = 0; index < 3; index += 1) {
      h.traffic.push(h.profileIds[0]!, h.over);
      h.traffic.push(h.profileIds[1]!, h.over);
      h.traffic.push(h.profileIds[2]!, h.over);
      h.traffic.push(h.profileIds[3]!, h.over);
    }

    const ticks = await Promise.all([h.engine.tick(), h.engine.tick(), h.engine.tick()]);
    const outcomes = ticks.flat().map((decision) => decision.outcome);

    expect(h.live.activateCalls).toBe(1);
    expect(outcomes.filter((outcome) => outcome === 'ACTIVATED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'FAILED')).toHaveLength(0);
  });

  it('4) RECUPERACAO de apenas UMA interface: mitigacao permanece, ZERO remove automatico', async () => {
    const h = await harness(4);
    await h.run(3, [h.over, h.over, h.over, h.over]);
    expect(h.live.activateCalls).toBe(1);

    // p1 recupera (12 amostras abaixo); os outros continuam em ataque.
    const recovery = await h.run(12, [h.under, h.over, h.over, h.over]);
    const recovered = recovery.find((decision) => decision.profileId === h.profileIds[0]);

    expect(recovered?.outcome).toBe('RECOVERY_PENDING');
    expect(recovered?.reason).toBe('AUTO_REMOVE_DISABLED');
    expect(h.live.removeCalls).toBe(0);
    for (const profileId of h.profileIds) {
      expect(await stateOf(h.repository, profileId)).toBe('MITIGATED');
    }
  });

  it('5) REMOVE manual por UM vinculo: escopo inteiro e sincronizado; segundo REMOVE e bloqueado', async () => {
    const h = await harness(4);
    await h.run(3, [h.over, h.over, h.over, h.over]);
    expect(h.live.activateCalls).toBe(1);

    // AUTO-ALL: a policy e a unidade BGP. Com OUTRO vinculo ativo no escopo, o
    // REMOVE sem confirmacao explicita NAO chega ao equipamento e devolve o
    // escopo afetado para o operador decidir.
    const blocked = await h.commands.execute({
      requestId: 'j5-remove-0',
      action: 'REMOVE',
      profileId: h.profileIds[0]!,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('SCOPE_CONFIRMATION_REQUIRED');
    expect(blocked.removalScope?.policy).toBe(POLICY_V4);
    expect(blocked.removalScope?.affected).toHaveLength(3);
    expect(blocked.removalScope?.affected.every((item) => item.runtimeState === 'MITIGATED')).toBe(
      true,
    );
    expect(h.live.removeCalls).toBe(0);
    for (const profileId of h.profileIds) {
      expect(await stateOf(h.repository, profileId)).toBe('MITIGATED');
    }

    const removal = await h.commands.execute({
      requestId: 'j5-remove-1',
      action: 'REMOVE',
      profileId: h.profileIds[0]!,
      acknowledgeScopeRemoval: true,
    });
    expect(removal.ok).toBe(true);
    expect(removal.status).toBe('REMOVED_VERIFIED');
    expect(removal.removalScope?.affected).toHaveLength(3);
    expect(h.live.removeCalls).toBe(1);
    for (const profileId of h.profileIds) {
      expect(await stateOf(h.repository, profileId)).toBe('NORMAL');
    }

    // Protecao de escopo: com o par ausente, novo REMOVE nao escreve de novo.
    const second = await h.commands.execute({
      requestId: 'j5-remove-2',
      action: 'REMOVE',
      profileId: h.profileIds[1]!,
    });
    expect(second.ok).toBe(false);
    expect(h.live.removeCalls).toBe(1);
  });

  it('6) LOCK e deduplicacao: ACTIVATE concorrente no mesmo escopo = UMA escrita', async () => {
    const h = await harness(2);

    const [first, second] = await Promise.all([
      h.commands.execute({ requestId: 'j6-a', action: 'ACTIVATE', profileId: h.profileIds[0]! }),
      h.commands.execute({ requestId: 'j6-b', action: 'ACTIVATE', profileId: h.profileIds[1]! }),
    ]);

    expect(h.live.activateCalls).toBe(1);
    const winners = [first, second].filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe('ACTIVATED_VERIFIED');
    for (const profileId of h.profileIds) {
      expect(await stateOf(h.repository, profileId)).toBe('MITIGATED');
    }
  });
});
