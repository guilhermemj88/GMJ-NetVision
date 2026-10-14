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
import { MitigationAutoEngine } from './mitigation-auto-engine';
import { SequenceTrafficSource } from './mitigation-traffic-source';

// AUDITORIA DO AUTO EM ROUTE-POLICY COMPARTILHADA (deviceId + policyName).
//
// Fakes FIEIS ao executor real: o preflight espelha huawei-mitigation-executor
// (nodes ocupados => ACTIVATE bloqueado; existingNodes precisa bater com o
// snapshot do discovery) e o "device" so muda por activate()/remove().

const DEVICE_A = 'host-f1a';
const DEVICE_B = 'host-outro';
const POLICY_V4 = 'PL-FLASH-TELECOM_IPv4-IN';
const POLICY_V6 = 'PL-FLASH-TELECOM_IPv6-IN';
const RT = '268568:660';
const BANDWIDTH = 10_000_000_000n;
const NOW = new Date('2026-10-12T15:00:00.000Z');
const BASELINE_NODES = [10, 999];
const PAIR = { bogonNode: 1, mitigationNode: 2 };

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

/** Executor live que carrega o estado REAL da policy no "equipamento". */
class DeviceTruthExecutor implements MitigationLiveExecutorPort {
  /** Nodes presentes na policy do equipamento (identidade fisica). */
  nodes = new Set<number>(BASELINE_NODES);
  activateCalls = 0;
  removeCalls = 0;
  preflightCalls = 0;
  /** ACTIVATE aplica a escrita e depois falha (timeout pos-escrita). */
  failAfterActivate = false;

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
    this.preflightCalls += 1;
    const reasons: string[] = [];
    const current = [...this.nodes].sort((a, b) => a - b);
    if (input.mode === 'ACTIVATE') {
      if (this.nodes.has(input.bogonNode)) reasons.push(`node ${input.bogonNode} ja ocupado`);
      if (this.nodes.has(input.mitigationNode)) {
        reasons.push(`node ${input.mitigationNode} ja ocupado`);
      }
      const expected = input.expectedExistingNodes;
      if (expected === null) {
        reasons.push('sem snapshot do discovery para comparar existingNodes');
      } else if (expected.join(',') !== current.join(',')) {
        reasons.push(`esperado [${expected.join(', ')}], lido [${current.join(', ')}]`);
      }
      // F3 (espelho do executor real): policy ja mitigada nao aceita um
      // SEGUNDO par - a prova e o read-back, nunca o runtime/plano.
      const physical = inspectPolicyMitigation({
        policyName: input.policyName,
        readBack: this.renderPolicy(input.policyName),
        rts: [input.rt],
        labels: {
          bogonPrefixList: input.bogonPrefixList,
          targetPrefixList: input.targetPrefixList,
        },
      });
      if (physical.state !== 'NORMAL') {
        reasons.push(`policy ja possui estrutura de mitigacao (${physical.detail})`);
      }
    } else {
      if (!this.nodes.has(input.bogonNode) && !this.nodes.has(input.mitigationNode)) {
        reasons.push('par ausente na policy');
      }
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
    if (this.failAfterActivate) {
      this.failAfterActivate = false;
      throw new Error('SSH timeout depois da escrita');
    }
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }> {
    this.removeCalls += 1;
    this.nodes.delete(input.bogonNode);
    this.nodes.delete(input.mitigationNode);
    return { output: 'ok' };
  }

  /** Read-back REAL do que esta na policy (mesma forma do executor). */
  private renderPolicy(policyName: string): string {
    const lines: string[] = [];
    if (this.nodes.has(PAIR.bogonNode)) {
      lines.push(`route-policy ${policyName} deny node ${PAIR.bogonNode}`, ' if-match ip-prefix BOGONS');
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

class ThrowingTrafficSource extends SequenceTrafficSource {
  throwNext = false;
  override async sampleWithId(input: Parameters<SequenceTrafficSource['sampleWithId']>[0]) {
    if (this.throwNext) throw new Error('telemetria indisponivel (db error)');
    return super.sampleWithId(input);
  }
}

interface HarnessOptions {
  policies?: string[];
  devices?: string[];
  runtimeStates?: string[];
  live?: DeviceTruthExecutor;
  repository?: InMemoryMitigationRepository;
}

async function harness(options: HarnessOptions = {}) {
  const repository = options.repository ?? new InMemoryMitigationRepository();
  const policies = options.policies ?? [POLICY_V4, POLICY_V4];
  const devices = options.devices ?? [DEVICE_A, DEVICE_A];
  const live = options.live ?? new DeviceTruthExecutor();
  const profileIds: string[] = [];
  for (let index = 0; index < policies.length; index += 1) {
    const state = options.runtimeStates?.[index] ?? 'NORMAL';
    const profile = await repository.upsertProfile({
      deviceId: devices[index]!,
      policyName: policies[index]!,
      interfaceId: `if-${index + 1}`,
      addressFamily: 'IPV4',
      detectedBandwidthBps: BANDWIDTH,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(profile.id, [
      { peerId: `peer-${index}`, peerAddress: `10.200.201.${20 + index}`, primary: true },
    ]);
    await repository.upsertRuntime(profile.id, {
      state: state as 'NORMAL',
      plannedBogonNode: PAIR.bogonNode,
      plannedMitigationNode: PAIR.mitigationNode,
      plannedNode: PAIR.mitigationNode,
    });
    profileIds.push(profile.id);
  }

  const commands = new MitigationCommandService({
    repository,
    hosts: {
      getHost: async (id) => (id === DEVICE_A || id === DEVICE_B ? device(id) : null),
    },
    executor: new MockMitigationExecutor(),
    live,
    // Snapshot do discovery: a policy estava NORMAL quando foi descoberta.
    expectedNodes: async () => BASELINE_NODES,
    now: () => NOW,
  });

  const traffic = new ThrowingTrafficSource();
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
              peerAddresses: [`10.200.201.${20 + index}`],
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

  const over = (BANDWIDTH * 95n) / 100n;
  const under = (BANDWIDTH * 50n) / 100n;

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

describe('AUTO x route-policy compartilhada (deviceId + policyName)', () => {
  it('1) os dois profiles precisam mitigar: UMA ativacao fisica e nenhuma tentativa duplicada', async () => {
    const h = await harness();
    const [p1, p2] = h.profileIds as [string, string];

    const decisions = await h.run(3, [h.over, h.over]);

    expect(h.live.activateCalls).toBe(1);
    expect([...h.live.nodes].sort((a, b) => a - b)).toEqual([1, 2, 10, 999].sort((a, b) => a - b));
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
    const sibling = decisions.find((decision) => decision.profileId === p2);
    // O irmao NAO pode gastar um segundo comando (nem preflight): o runtime
    // sincronizado pelo primeiro ja o torna MITIGATED no mesmo ciclo.
    expect(sibling?.outcome).toBe('NO_ACTION');
    expect(sibling?.reason).toBe('ALREADY_MITIGATED');
  });

  it('2) ticks concorrentes com dois profiles do mesmo escopo: ainda UMA ativacao', async () => {
    const h = await harness();
    const [p1, p2] = h.profileIds as [string, string];
    for (let index = 0; index < 3; index += 1) {
      h.traffic.push(p1, h.over);
      h.traffic.push(p2, h.over);
    }

    const ticks = await Promise.all([h.engine.tick(), h.engine.tick(), h.engine.tick()]);

    expect(h.live.activateCalls).toBe(1);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
    const outcomes = ticks.flat().map((decision) => decision.outcome);
    expect(outcomes.filter((outcome) => outcome === 'ACTIVATED')).toHaveLength(1);
  });

  it('3) um precisa mitigar e o outro esta normal: ativa e sincroniza os dois', async () => {
    const h = await harness();
    const [p1, p2] = h.profileIds as [string, string];

    await h.run(3, [h.over, h.under]);

    expect(h.live.activateCalls).toBe(1);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
  });

  it('4) recuperado + irmao ainda precisando: NUNCA remove (AUTO_REMOVE_DISABLED)', async () => {
    const h = await harness({ runtimeStates: ['MITIGATED', 'MITIGATED'] });
    h.live.nodes = new Set([1, 2, 10, 999]);

    const decisions = await h.run(12, [h.under, h.over]);

    expect(h.live.removeCalls).toBe(0);
    const recovered = decisions.find((decision) => decision.profileId === h.profileIds[0]);
    expect(recovered?.reason).toBe('AUTO_REMOVE_DISABLED');
    expect(recovered?.outcome).toBe('RECOVERY_PENDING');
    // A policy fisica continua mitigada: nenhum node saiu.
    expect([...h.live.nodes].sort((a, b) => a - b)).toEqual([1, 2, 10, 999].sort((a, b) => a - b));
  });

  it('5) recuperado + desconhecido (RECONCILIATION_REQUIRED): NUNCA remove', async () => {
    const h = await harness({ runtimeStates: ['MITIGATED', 'RECONCILIATION_REQUIRED'] });
    h.live.nodes = new Set([1, 2, 10, 999]);

    await h.run(12, [h.under, h.under]);

    expect(h.live.removeCalls).toBe(0);
    expect(await stateOf(h.repository, h.profileIds[1]!)).toBe('RECONCILIATION_REQUIRED');
  });

  it('6) recuperado + recuperado: retirada automatica NAO existe (segue manual)', async () => {
    const h = await harness({ runtimeStates: ['MITIGATED', 'MITIGATED'] });
    h.live.nodes = new Set([1, 2, 10, 999]);

    const decisions = await h.run(12, [h.under, h.under]);

    expect(h.live.removeCalls).toBe(0);
    expect(decisions.every((decision) => decision.reason === 'AUTO_REMOVE_DISABLED')).toBe(true);
  });

  it('7) estado DESCONHECIDO nao impede ativacao necessaria (preflight decide)', async () => {
    const h = await harness({ runtimeStates: ['RECONCILIATION_REQUIRED', 'NORMAL'] });

    await h.run(3, [h.over, h.under]);

    // O preflight leu o equipamento (par ausente) e a ativacao foi aplicada.
    expect(h.live.activateCalls).toBe(1);
    expect(await stateOf(h.repository, h.profileIds[0]!)).toBe('MITIGATED');
  });

  it('8) mesma policyName em OUTRO device: escopo nao vaza', async () => {
    const h = await harness({
      policies: [POLICY_V4, POLICY_V4],
      devices: [DEVICE_A, DEVICE_B],
    });
    const [pA, pB] = h.profileIds as [string, string];

    const decisions = await h.run(3, [h.over, h.over]);

    expect(h.live.activateCalls).toBe(1);
    expect(await stateOf(h.repository, pA)).toBe('MITIGATED');
    // O escopo do device B NAO foi sincronizado (nunca MITIGATED).
    expect(await stateOf(h.repository, pB)).not.toBe('MITIGATED');
    const blocked = decisions.find((decision) => decision.profileId === pB);
    expect(blocked?.reason).toBe('DEVICE_NOT_ALLOWED');
  });

  it('9) policies distintas (v4/v6) no MESMO device: independentes', async () => {
    const h = await harness({ policies: [POLICY_V4, POLICY_V6] });
    const [p4, p6] = h.profileIds as [string, string];

    // v4 precisa mitigar; v6 esta tranquilo (abaixo do threshold).
    await h.run(3, [h.over, h.under]);

    // Outro escopo (outra policy): o ACTIVATE do v4 nao toca o runtime do v6.
    expect(await stateOf(h.repository, p4)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p6)).not.toBe('MITIGATED');
  });

  it('10) falha/timeout de telemetria: nenhum comando e decisao visivel', async () => {
    const h = await harness();
    h.traffic.throwNext = true;

    const decisions = await h.engine.tick();

    expect(h.live.activateCalls).toBe(0);
    expect(h.live.removeCalls).toBe(0);
    expect(decisions[0]?.outcome).toBe('FAILED');
  });

  it('11) escrita aplicada + falha depois: escopo RECONCILIATION_REQUIRED, zero remove', async () => {
    const h = await harness();
    h.live.failAfterActivate = true;

    await h.run(3, [h.over, h.over]);

    expect(h.live.activateCalls).toBe(1);
    expect(h.live.removeCalls).toBe(0);
    expect(await stateOf(h.repository, h.profileIds[0]!)).toBe('RECONCILIATION_REQUIRED');
    expect(await stateOf(h.repository, h.profileIds[1]!)).toBe('RECONCILIATION_REQUIRED');
  });

  it('12) reinicio do worker com o escopo ja mitigado: ALREADY_MITIGATED', async () => {
    const repository = new InMemoryMitigationRepository();
    const first = await harness({ repository, runtimeStates: ['MITIGATED', 'MITIGATED'] });
    // "Reinicio": novo motor, MESMO repositorio persistido.
    const second = await harness({
      repository,
      live: first.live,
      runtimeStates: ['MITIGATED', 'MITIGATED'],
    });
    (second as { profileIds: string[] }).profileIds = first.profileIds;

    const decisions = await second.run(3, [second.over, second.over]);

    expect(first.live.activateCalls).toBe(0);
    expect(decisions.every((decision) => decision.reason === 'ALREADY_MITIGATED')).toBe(true);
  });

  it('13) profile NOVO no escopo ja mitigado: AUTO nao tenta um segundo par (SCOPE_ALREADY_MITIGATED)', async () => {
    const h = await harness({ policies: [POLICY_V4], devices: [DEVICE_A] });
    const [p1] = h.profileIds as [string];
    await h.run(3, [h.over]); // P1 ativa; policy passa a ter os nodes.
    expect(h.live.activateCalls).toBe(1);
    const preflightsAfterActivation = h.live.preflightCalls;

    // Novo profile descoberto DEPOIS da mitigacao (runtime NORMAL no banco).
    // O planner REAL nunca repete o par ocupado: o plano dele e 3/4.
    const extra = await h.repository.upsertProfile({
      deviceId: DEVICE_A,
      policyName: POLICY_V4,
      interfaceId: 'if-novo',
      addressFamily: 'IPV4',
      detectedBandwidthBps: BANDWIDTH,
      bandwidthSource: 'DESCRIPTION',
    });
    await h.repository.replaceProfilePeers(extra.id, [
      { peerId: 'peer-novo', peerAddress: '10.200.201.99', primary: true },
    ]);
    await h.repository.upsertRuntime(extra.id, {
      state: 'NORMAL',
      plannedBogonNode: 3,
      plannedMitigationNode: 4,
      plannedNode: 4,
    });
    const ids = h.profileIds as string[];
    ids.push(extra.id);

    let decisions: Awaited<ReturnType<typeof h.engine.tick>> = [];
    for (let index = 0; index < 3; index += 1) {
      h.traffic.push(p1, h.over);
      h.traffic.push(extra.id, h.over);
      decisions = await h.engine.tick();
    }

    // F3: o irmao MITIGATED do MESMO escopo (device+policy) interrompe o AUTO
    // ANTES de qualquer preflight/escrita - nenhum segundo par e instalado e a
    // tentativa nao se repete caro a cada tick.
    expect(h.live.activateCalls).toBe(1);
    expect(h.live.preflightCalls).toBe(preflightsAfterActivation);
    const novo = decisions.find((decision) => decision.profileId === extra.id);
    expect(novo?.outcome).toBe('NO_ACTION');
    expect(novo?.reason).toBe('SCOPE_ALREADY_MITIGATED');
    // O novo profile nunca fica MITIGATED por engano (segue "quer mitigar").
    expect(await stateOf(h.repository, extra.id)).not.toBe('MITIGATED');
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
  });

  it('13b) F3 no FISICO: ACTIVATE manual de profile novo (plano 3/4) e bloqueado pelo read-back', async () => {
    const h = await harness({ policies: [POLICY_V4], devices: [DEVICE_A] });
    const [p1] = h.profileIds as [string];
    await h.run(3, [h.over]); // policy fisica com o par 1/2 (o "novo" plano evita 1/2)
    expect(h.live.activateCalls).toBe(1);

    const extra = await h.repository.upsertProfile({
      deviceId: DEVICE_A,
      policyName: POLICY_V4,
      interfaceId: 'if-novo',
      addressFamily: 'IPV4',
      detectedBandwidthBps: BANDWIDTH,
      bandwidthSource: 'DESCRIPTION',
    });
    await h.repository.replaceProfilePeers(extra.id, [
      { peerId: 'peer-novo', peerAddress: '10.200.201.99', primary: true },
    ]);
    await h.repository.upsertRuntime(extra.id, {
      state: 'NORMAL',
      plannedBogonNode: 3,
      plannedMitigationNode: 4,
      plannedNode: 4,
    });

    // Comando MANUAL usa o MESMO servico: o preflight fisico (read-back) tem
    // de bloquear - os nodes 3/4 estao livres e o snapshot bate, entao SO a
    // checagem F3 pode estar barrando a escrita.
    const manual = await h.commands.execute({
      requestId: 'manual-novo',
      action: 'ACTIVATE',
      profileId: extra.id,
    });

    expect(manual.status).toBe('REVALIDATION_FAILED');
    expect(manual.verified).toBe(false);
    expect(manual.safeError ?? '').toContain('estrutura de mitigacao');
    expect(h.live.activateCalls).toBe(1);
    expect(await stateOf(h.repository, extra.id)).toBe('NORMAL');
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(h.live.nodes.has(3)).toBe(false);
    expect(h.live.nodes.has(4)).toBe(false);
  });

  it('14) dois REMOVE manuais no mesmo escopo: uma retirada fisica e runtime consistente', async () => {
    const h = await harness({ runtimeStates: ['MITIGATED', 'MITIGATED'] });
    h.live.nodes = new Set([1, 2, 10, 999]);
    const [p1, p2] = h.profileIds as [string, string];

    const results = await Promise.all([
      h.commands.execute({
        requestId: 'remove-1',
        action: 'REMOVE',
        profileId: p1,
        acknowledgeScopeRemoval: true,
      }),
      h.commands.execute({
        requestId: 'remove-2',
        action: 'REMOVE',
        profileId: p2,
        acknowledgeScopeRemoval: true,
      }),
    ]);

    // Sem lock por escopo no caminho MANUAL, as duas leituras do par ativo
    // acontecem antes da primeira retirada: DUAS tentativas de REMOVE podem
    // partir (o equipamento e idempotente: o par sai uma vez). O que NAO pode
    // acontecer e runtime inconsistente nem estado MITIGATED falso.
    expect(h.live.removeCalls).toBeLessThanOrEqual(2);
    expect(h.live.nodes.has(1)).toBe(false);
    expect(h.live.nodes.has(2)).toBe(false);
    expect(await stateOf(h.repository, p1)).toBe('NORMAL');
    expect(await stateOf(h.repository, p2)).toBe('NORMAL');
    expect(results.some((result) => result.ok)).toBe(true);
  });

  it('14b) REMOVE sem confirmacao de escopo e bloqueado quando o irmao esta ativo', async () => {
    const h = await harness({ runtimeStates: ['MITIGATED', 'MITIGATED'] });
    h.live.nodes = new Set([1, 2]);
    const [p1, p2] = h.profileIds as [string, string];

    const blocked = await h.commands.execute({
      requestId: 'remove-sem-ack',
      action: 'REMOVE',
      profileId: p1,
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('SCOPE_CONFIRMATION_REQUIRED');
    expect(blocked.verified).toBe(false);
    expect(blocked.removalScope?.affected.map((item) => item.profileId)).toEqual([p2]);
    expect(blocked.commandPreview).toHaveLength(0);
    expect(h.live.removeCalls).toBe(0);
    expect(h.live.nodes.has(1)).toBe(true);
    expect(await stateOf(h.repository, p1)).toBe('MITIGATED');
    expect(await stateOf(h.repository, p2)).toBe('MITIGATED');
  });
});
