import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  MitigationCommandService,
  type MitigationLiveExecutorPort,
} from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import {
  buildMitigationActivateCommands,
  buildMitigationRemovalCommands,
} from './mitigation-write-guard';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
import type {
  MitigationPreflightInput,
  MitigationPreflightResult,
} from './huawei-mitigation-executor';
import type { MitigationActivationInput, MitigationRemovalInput } from './mitigation-executor';
import type {
  MitigationNotification,
  NotificationPublisher,
  NotificationPublishResult,
} from './notification-publisher';

const DEVICE_ID = 'host-f1a';
const POLICY = 'PL-HORIZONTES_IPv4-IN';
const RT = '268568:660';
const FIXED_NOW = new Date('2026-09-29T22:00:00.000Z');

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

const GOOD_READBACK = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' if-match ip-prefix PREFIX8to24',
  ` apply extcommunity rt ${RT} additive`,
  `route-policy ${POLICY} permit node 11`,
].join('\n');

const NORMAL_READBACK = [`route-policy ${POLICY} permit node 11`].join('\n');

function preflightResult(overrides: Partial<MitigationPreflightResult> = {}): MitigationPreflightResult {
  return {
    ok: true,
    mode: 'ACTIVATE',
    deviceId: DEVICE_ID,
    deviceName: 'BHE-VTA-F1A-BGP-01',
    deviceHost: '10.200.1.1',
    policyName: POLICY,
    existingNodes: [11, 50],
    bogonNode: 1,
    mitigationNode: 2,
    bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
    bogonPrefixListExists: true,
    targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    targetPrefixListExists: true,
    rt: RT,
    sshReadBackOk: true,
    bogonNodeExists: false,
    bogonNodeMatches: false,
    mitigationNodeExists: false,
    mitigationNodeMatches: false,
    partial: false,
    readBackNodes: [11, 50],
    readBackSummary: 'par ausente (policy normal)',
    readBackExcerpt: 'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    checks: [],
    blockedReasons: [],
    ...overrides,
  };
}

class FakeLiveExecutor implements MitigationLiveExecutorPort {
  readonly applied: string[][] = [];
  removals: string[][] = [];
  preflightValue: MitigationPreflightResult = preflightResult();
  readBacks: string[] = [GOOD_READBACK, NORMAL_READBACK];
  activateError: Error | null = null;
  preflightCalls = 0;
  /** Par ATIVO que o equipamento mostraria (reconciliacao do REMOVE). */
  devicePair: { bogonNode: number; mitigationNode: number } | null = null;

  enabledFor(): boolean {
    return true;
  }

  async resolveActivePair(): Promise<{ bogonNode: number; mitigationNode: number } | null> {
    return this.devicePair;
  }

  async preflight(_device: HostRecord, input: MitigationPreflightInput) {
    this.preflightCalls += 1;
    // O executor real devolve sempre o modo pedido; o fake espelha isso.
    return { ...this.preflightValue, mode: input.mode };
  }

  async activate(_device: HostRecord, input: MitigationActivationInput): Promise<{ output: string }> {
    if (this.activateError) throw this.activateError;
    this.applied.push(buildMitigationActivateCommands(input));
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }> {
    if (this.activateError) throw this.activateError;
    this.removals.push(buildMitigationRemovalCommands(input));
    return { output: 'ok' };
  }

  async readRoutePolicy(): Promise<string> {
    return this.readBacks.shift() ?? '';
  }
}

async function harness(
  options: {
    live?: MitigationLiveExecutorPort;
    expectedNodes?: number[] | null;
    notifications?: NotificationPublisher;
    runtimePlan?: 'PAIR' | 'NONE';
  } = {},
) {
  const repository = new InMemoryMitigationRepository();
  const mock = new MockMitigationExecutor();
  mock.seedPolicy(POLICY, [11]);
  const profile = await repository.upsertProfile({
    deviceId: DEVICE_ID,
    policyName: POLICY,
    interfaceId: 'if-3011',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerAddress: '10.200.200.106', primary: true },
  ]);
  await repository.upsertRuntime(
    profile.id,
    options.runtimePlan === 'NONE'
      ? { state: 'NORMAL' }
      : { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 },
  );

  const commands = new MitigationCommandService({
    repository,
    hosts: { getHost: async () => device() },
    executor: mock,
    ...(options.live ? { live: options.live } : {}),
    ...(options.notifications ? { notifications: options.notifications } : {}),
    expectedNodes: async () =>
      options.expectedNodes === undefined ? [11, 50] : options.expectedNodes,
    now: () => FIXED_NOW,
  });
  return { repository, mock, commands, profileId: profile.id };
}

describe('escrita real de mitigacao - fail-closed', () => {
  it('sem executor real (MOCK) o ACTIVATE nao toca em nenhum equipamento', async () => {
    const result = await harness();
    const body = await result.commands.execute({
      requestId: 'mock-1',
      action: 'ACTIVATE',
      profileId: result.profileId,
    });
    expect(body.status).toBe('ACTIVATED_VERIFIED');
    expect(body.preflight).toBeUndefined();
    expect(result.mock.calls).toContain('commit');
  });

  it('SIMULATE_ACTIVATE real roda o preflight e NUNCA escreve', async () => {
    const live = new FakeLiveExecutor();
    const h = await harness({ live });
    const body = await h.commands.execute({
      requestId: 'sim-1',
      action: 'SIMULATE_ACTIVATE',
      profileId: h.profileId,
    });
    expect(body.status).toBe('WOULD_ACTIVATE');
    expect(body.preflight?.ok).toBe(true);
    expect(body.preflight?.existingNodes).toEqual([11, 50]);
    expect(live.applied).toHaveLength(0);
    expect(live.removals).toHaveLength(0);
    expect(h.mock.calls).toHaveLength(0);
  });

  it('preflight com node ocupado ABORTA antes de escrever', async () => {
    const live = new FakeLiveExecutor();
    live.preflightValue = preflightResult({
      ok: false,
      blockedReasons: ['mitigation_node_free: node 2 ja ocupado'],
    });
    const h = await harness({ live });
    const body = await h.commands.execute({
      requestId: 'block-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(body.ok).toBe(false);
    expect(body.status).toBe('REVALIDATION_FAILED');
    expect(body.safeError).toContain('Preflight read-only falhou');
    expect(live.applied).toHaveLength(0);
    expect(h.mock.calls).toHaveLength(0);
  });

  it('live_write=false: leitura liberada mas a escrita nao sai', async () => {
    const live = new FakeLiveExecutor();
    live.activateError = new Error('MITIGATION_WRITE_DISABLED: escrita real desabilitada');
    const h = await harness({ live });
    const body = await h.commands.execute({
      requestId: 'off-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(live.preflightCalls).toBe(1);
    expect(live.applied).toHaveLength(0);
    expect(body.status).toBe('REVALIDATION_FAILED');
    // O motivo real NAO pode ser engolido: o operador precisa saber o que houve.
    expect(body.safeError).toContain('MITIGATION_WRITE_DISABLED');
  });

  it('ACTIVATE real aplica os 7 comandos e confirma por read-back', async () => {
    const live = new FakeLiveExecutor();
    const h = await harness({ live });
    const body = await h.commands.execute({
      requestId: 'live-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(body.status).toBe('ACTIVATED_VERIFIED');
    expect(body.verified).toBe(true);
    expect(body.bogonNode).toBe(1);
    expect(body.mitigationNode).toBe(2);
    expect(body.preflight?.ok).toBe(true);
    expect(live.applied[0]).toEqual([
      'system-view',
      `route-policy ${POLICY} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${POLICY} permit node 2`,
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${RT} additive`,
      'commit',
    ]);
  });

  it('REMOVE real retira o par e confirma a ausencia', async () => {
    const live = new FakeLiveExecutor();
    live.readBacks = [NORMAL_READBACK];
    const h = await harness({ live });
    const body = await h.commands.execute({
      requestId: 'live-rem-1',
      action: 'REMOVE',
      profileId: h.profileId,
    });
    expect(body.status).toBe('REMOVED_VERIFIED');
    expect(body.verified).toBe(true);
    expect(live.removals[0]).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  it('read-back incorreto NAO vira verified', async () => {
    const live = new FakeLiveExecutor();
    live.readBacks = [
      [
        `route-policy ${POLICY} permit node 2`,
        ` apply extcommunity rt ${RT} additive`,
      ].join('\n'),
    ];
    const h = await harness({ live });
    const body = await h.commands.execute({
      requestId: 'bad-rb-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(body.verified).toBe(false);
    expect(body.status).toBe('REVALIDATION_FAILED');
    expect(body.safeError).toContain('PREFIX8to24');
  });

  it('sem snapshot de discovery o preflight bloqueia a escrita', async () => {
    const live = new FakeLiveExecutor();
    live.preflightValue = preflightResult({
      ok: false,
      blockedReasons: ['existing_nodes: sem snapshot do discovery para comparar existingNodes'],
    });
    const h = await harness({ live, expectedNodes: null });
    const body = await h.commands.execute({
      requestId: 'no-snap-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(body.ok).toBe(false);
    expect(live.applied).toHaveLength(0);
  });

  it('idempotencia preservada: repetir o requestId nao escreve de novo', async () => {
    const live = new FakeLiveExecutor();
    const h = await harness({ live });
    const first = await h.commands.execute({
      requestId: 'idem-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    const second = await h.commands.execute({
      requestId: 'idem-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(live.applied).toHaveLength(1);
    expect(live.preflightCalls).toBe(1);
  });
});

/** Publisher de teste: captura a notificacao canonica publicada pelo motor. */
class CapturePublisher implements NotificationPublisher {
  readonly published: MitigationNotification[] = [];
  async publish(notification: MitigationNotification): Promise<NotificationPublishResult> {
    this.published.push(notification);
    return { published: true, skipped: false };
  }
}

/**
 * Executor fake COM ESTADO: o par passa a existir depois do ACTIVATE e some
 * depois do REMOVE, exatamente como o equipamento real. Serve para provar que o
 * preflight de REMOVE aceita o par presente (bug corrigido nesta sessao).
 */
class StatefulLiveExecutor implements MitigationLiveExecutorPort {
  applied: string[][] = [];
  removals: string[][] = [];
  modes: string[] = [];
  private mitigated = false;

  enabledFor(): boolean {
    return true;
  }

  async preflight(_device: HostRecord, input: MitigationPreflightInput) {
    this.modes.push(input.mode);
    if (input.mode === 'ACTIVATE') {
      return this.mitigated
        ? preflightResult({
            mode: 'ACTIVATE',
            ok: false,
            blockedReasons: ['mitigation_node_free: node 2 ja ocupado'],
            bogonNodeExists: true,
            mitigationNodeExists: true,
          })
        : preflightResult({ mode: 'ACTIVATE' });
    }
    return this.mitigated
      ? preflightResult({
          mode: 'REMOVE',
          bogonNodeExists: true,
          bogonNodeMatches: true,
          mitigationNodeExists: true,
          mitigationNodeMatches: true,
        })
      : preflightResult({
          mode: 'REMOVE',
          ok: false,
          blockedReasons: [
            'bogon_node_present: node BOGONS 1 ausente',
            'mitigation_node_present: node de mitigacao 2 ausente',
          ],
        });
  }

  async resolveActivePair(): Promise<{ bogonNode: number; mitigationNode: number } | null> {
    return this.mitigated ? { bogonNode: 1, mitigationNode: 2 } : null;
  }

  async activate(_device: HostRecord, input: MitigationActivationInput): Promise<{ output: string }> {
    this.applied.push(buildMitigationActivateCommands(input));
    this.mitigated = true;
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }> {
    this.removals.push(buildMitigationRemovalCommands(input));
    this.mitigated = false;
    return { output: 'ok' };
  }

  async readRoutePolicy(): Promise<string> {
    return this.mitigated ? GOOD_READBACK : NORMAL_READBACK;
  }
}

describe('ciclo real ACTIVATE -> REMOVE (preflight por modo)', () => {
  it('8) ACTIVATE real e depois REMOVE passa o preflight (nao exige nodes livres)', async () => {
    const live = new StatefulLiveExecutor();
    const h = await harness({ live });

    const activate = await h.commands.execute({
      requestId: 'cyc-act',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(activate.status).toBe('ACTIVATED_VERIFIED');
    expect(activate.verified).toBe(true);
    expect(activate.preflight?.mode).toBe('ACTIVATE');

    const remove = await h.commands.execute({
      requestId: 'cyc-rem',
      action: 'REMOVE',
      profileId: h.profileId,
    });
    expect(remove.status).toBe('REMOVED_VERIFIED');
    expect(remove.verified).toBe(true);
    expect(remove.preflight?.mode).toBe('REMOVE');
    expect(remove.preflight?.ok).toBe(true);
    expect(remove.preflight?.bogonNodeMatches).toBe(true);
    expect(remove.preflight?.mitigationNodeMatches).toBe(true);

    expect(live.applied).toHaveLength(1);
    expect(live.removals).toHaveLength(1);
    expect(live.modes).toEqual(['ACTIVATE', 'REMOVE']);
  });

  it('REMOVE sem o par ativo e bloqueado sem remover nada', async () => {
    const live = new StatefulLiveExecutor();
    const h = await harness({ live });
    const remove = await h.commands.execute({
      requestId: 'cyc-rem-sem-par',
      action: 'REMOVE',
      profileId: h.profileId,
    });
    expect(remove.ok).toBe(false);
    expect(remove.status).toBe('REVALIDATION_FAILED');
    expect(remove.safeError).toContain('Preflight read-only falhou');
    expect(live.removals).toHaveLength(0);
  });

  it('SIMULATE_REMOVE prova o preflight de retirada sobre o par ativo', async () => {
    const live = new StatefulLiveExecutor();
    const h = await harness({ live });
    await h.commands.execute({ requestId: 'sim-rem-act', action: 'ACTIVATE', profileId: h.profileId });

    const sim = await h.commands.execute({
      requestId: 'sim-rem-1',
      action: 'SIMULATE_REMOVE',
      profileId: h.profileId,
    });
    expect(sim.status).toBe('WOULD_REMOVE');
    expect(sim.pairSource).toBe('DEVICE');
    expect(sim.preflight?.mode).toBe('REMOVE');
    expect(sim.preflight?.ok).toBe(true);
    expect(sim.commandPreview).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
    // Nada foi removido nem reaplicado.
    expect(live.removals).toHaveLength(0);
    expect(live.applied).toHaveLength(1);
  });
});

describe('notificacao: simulation reflete o caminho executado', () => {
  it('ACTIVATE real via Huawei publica simulation=false', async () => {
    const live = new StatefulLiveExecutor();
    const publisher = new CapturePublisher();
    const h = await harness({ live, notifications: publisher });
    await h.commands.execute({ requestId: 'n-live', action: 'ACTIVATE', profileId: h.profileId });
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.event).toBe('MITIGATION_VERIFIED');
    expect(publisher.published[0]?.simulation).toBe(false);
  });

  it('ACTIVATE no caminho MOCK segue simulation=true', async () => {
    const publisher = new CapturePublisher();
    const h = await harness({ notifications: publisher });
    await h.commands.execute({ requestId: 'n-mock', action: 'ACTIVATE', profileId: h.profileId });
    expect(publisher.published[0]?.simulation).toBe(true);
  });

  it('SIMULATE_ACTIVATE segue simulation=true', async () => {
    const live = new StatefulLiveExecutor();
    const publisher = new CapturePublisher();
    const h = await harness({ live, notifications: publisher });
    await h.commands.execute({ requestId: 'n-sim', action: 'SIMULATE_ACTIVATE', profileId: h.profileId });
    expect(publisher.published[0]?.simulation).toBe(true);
  });
});

describe('reconciliacao do REMOVE com o par ATIVO do equipamento', () => {
  it('sem plano no runtime, o REMOVE adota o par 1/2 lido do equipamento', async () => {
    const live = new FakeLiveExecutor();
    live.devicePair = { bogonNode: 1, mitigationNode: 2 };
    live.readBacks = [NORMAL_READBACK];
    const h = await harness({ live, runtimePlan: 'NONE' });

    const body = await h.commands.execute({
      requestId: 'recon-1',
      action: 'REMOVE',
      profileId: h.profileId,
    });

    expect(body.pairSource).toBe('DEVICE');
    expect(body.bogonNode).toBe(1);
    expect(body.mitigationNode).toBe(2);
    expect(body.preflight?.mode).toBe('REMOVE');
    expect(live.removals[0]).toEqual([
      'system-view',
      `undo route-policy ${POLICY} node 1`,
      `undo route-policy ${POLICY} node 2`,
      'commit',
    ]);
  });

  it('sem par ativo no equipamento e sem plano, o REMOVE e bloqueado sem escrever', async () => {
    const live = new FakeLiveExecutor();
    live.devicePair = null;
    const h = await harness({ live, runtimePlan: 'NONE' });
    const body = await h.commands.execute({
      requestId: 'recon-2',
      action: 'REMOVE',
      profileId: h.profileId,
    });
    expect(body.ok).toBe(false);
    expect(body.status).toBe('REVALIDATION_FAILED');
    expect(live.removals).toHaveLength(0);
  });

  it('ACTIVATE NUNCA adota o par do equipamento (so o planner/runtime)', async () => {
    const live = new FakeLiveExecutor();
    live.devicePair = { bogonNode: 1, mitigationNode: 2 };
    const h = await harness({ live, runtimePlan: 'NONE' });
    const body = await h.commands.execute({
      requestId: 'recon-3',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(body.ok).toBe(false);
    expect(body.status).toBe('REVALIDATION_FAILED');
    expect(live.applied).toHaveLength(0);
  });
});
