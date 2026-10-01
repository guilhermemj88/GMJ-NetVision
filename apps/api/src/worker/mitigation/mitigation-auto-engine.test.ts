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
import type { MitigationNotification } from '../../infrastructure/bgp/mitigation/notification-publisher';
import { mitigationConfigFromEnv } from '../../infrastructure/bgp/mitigation/mitigation-config';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import { SequenceTrafficSource } from './mitigation-traffic-source';

// Testes do MOTOR AUTO real do GMJ NetVision.
//
// O caminho de escrita é o CANÔNICO (MitigationCommandService + executor HUAWEI
// falso). Nenhum teste aqui envia comando a equipamento.

const DEVICE = 'device-1';
const POLICY = 'PL-BHNET_IPv4-IN';
const PEER = '10.200.200.222';
const BANDWIDTH = 10_000_000_000n;
const NOW = new Date('2026-10-01T00:00:00.000Z');

function host(): HostRecord {
  return {
    id: DEVICE,
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
  } as unknown as HostRecord;
}

const READBACK_ACTIVE = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' if-match ip-prefix PREFIX8to24',
  ' apply extcommunity rt 268568:660 additive',
  `route-policy ${POLICY} permit node 10`,
].join('\n');

class CountingLiveExecutor implements MitigationLiveExecutorPort {
  preflightCalls = 0;
  activateCalls = 0;
  removeCalls = 0;
  readRoutePolicyCalls = 0;
  failNextActivate = false;
  devicePair: { bogonNode: number; mitigationNode: number } | null = {
    bogonNode: 1,
    mitigationNode: 2,
  };

  enabledFor(): boolean {
    return true;
  }

  async resolveActivePair() {
    return this.devicePair;
  }

  async preflight(
    _device: HostRecord,
    input: MitigationPreflightInput,
  ): Promise<MitigationPreflightResult> {
    this.preflightCalls += 1;
    return {
      ok: true,
      mode: input.mode,
      deviceId: DEVICE,
      deviceName: 'BHE-VTA-F1A-BGP-01',
      deviceHost: '10.0.0.1',
      policyName: input.policyName,
      existingNodes: [10, 100],
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
      readBackNodes: [10, 100],
      readBackSummary: 'par livre',
      readBackExcerpt: '',
      checks: [],
      blockedReasons: [],
    };
  }

  async activate(_device: HostRecord, _input: MitigationActivationInput): Promise<{ output: string }> {
    this.activateCalls += 1;
    if (this.failNextActivate) {
      this.failNextActivate = false;
      throw new Error('ssh timeout');
    }
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, _input: MitigationRemovalInput): Promise<{ output: string }> {
    this.removeCalls += 1;
    this.devicePair = null;
    return { output: 'ok' };
  }

  async readRoutePolicy(): Promise<string> {
    this.readRoutePolicyCalls += 1;
    return this.devicePair ? READBACK_ACTIVE : `route-policy ${POLICY} permit node 10`;
  }
}

function targetState(profileId: string, over: Partial<MitigationAutoTargetState> = {}): MitigationAutoTargetState {
  return {
    profileId,
    deviceId: DEVICE,
    interfaceId: 'if-1',
    customer: 'BHNET-CEASA',
    mode: 'AUTO',
    readiness: 'READY',
    prefixStatus: 'SAFE',
    blockedReason: null,
    mitigationExcluded: false,
    runtimeState: 'NORMAL',
    effectiveBandwidthBps: BANDWIDTH,
    bogonNode: 1,
    mitigationNode: 2,
    sharedPolicy: false,
    peerAddresses: [PEER],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
    ...over,
  };
}

interface HarnessOptions {
  /** Reutiliza o MESMO store (simula restart com runtime persistido). */
  repository?: InMemoryMitigationRepository;
  globalMode?: 'SIMULATION_ONLY' | 'AUTO';
  executor?: 'MOCK' | 'HUAWEI';
  liveWrite?: boolean;
  allowlist?: string[];
  target?: Partial<MitigationAutoTargetState>;
}

async function harness(options: HarnessOptions = {}) {
  const repository = options.repository ?? new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: DEVICE,
    policyName: POLICY,
    interfaceId: 'if-1',
    addressFamily: 'IPV4',
    detectedBandwidthBps: BANDWIDTH,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerId: 'peer-1', peerAddress: PEER, primary: true },
  ]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });

  const live = new CountingLiveExecutor();
  const notified: string[] = [];
  const commands = new MitigationCommandService({
    repository,
    hosts: { getHost: async () => host() },
    executor: new MockMitigationExecutor(),
    live,
    notifications: {
      publish: async (notification: MitigationNotification) => {
        notified.push(notification.event);
        return { published: true, skipped: false };
      },
    },
    now: () => NOW,
  });

  const traffic = new SequenceTrafficSource();
  const engine = new MitigationAutoEngine({
    globalMode: options.globalMode ?? 'AUTO',
    execution: {
      executor: options.executor ?? 'HUAWEI',
      liveWrite: options.liveWrite ?? true,
      allowedDeviceIds: options.allowlist ?? [DEVICE],
    },
    targets: { list: async () => [targetState(profile.id, options.target)] },
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

  /** Roda N ciclos do motor (1 amostra por ciclo) e devolve o ULTIMO resultado. */
  const run = async (times: number, value: bigint) => {
    let last: Awaited<ReturnType<typeof engine.tick>> = [];
    for (let i = 0; i < times; i += 1) {
      traffic.push(profile.id, value);
      last = await engine.tick();
    }
    return last;
  };
  const over = (BANDWIDTH * 95n) / 100n;
  const exact = (BANDWIDTH * 90n) / 100n;
  const under = (BANDWIDTH * 50n) / 100n;

  return { repository, profileId: profile.id, live, engine, traffic, notified, commands, run, over, exact, under };
}

describe('motor AUTO real (GMJ NetVision)', () => {
  it('1) default continua SIMULATION_ONLY (fail-closed)', () => {
    expect(mitigationConfigFromEnv({}).mode).toBe('SIMULATION_ONLY');
    expect(mitigationConfigFromEnv({ MITIGATION_MODE: 'auto' }).mode).toBe('AUTO');
    expect(mitigationConfigFromEnv({ MITIGATION_MODE: 'QUALQUER' }).mode).toBe('SIMULATION_ONLY');
  });

  it('2) AUTO sem LIVE_WRITE => WOULD_ACTIVATE e nenhuma escrita', async () => {
    const h = await harness({ liveWrite: false });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('WOULD_ACTIVATE');
    expect(decision[0]!.reason).toBe('LIVE_WRITE_DISABLED');
    expect(h.live.activateCalls).toBe(0);
    expect(h.live.preflightCalls).toBe(0);
  });

  it('3) AUTO sem HUAWEI (executor MOCK) => nao escreve', async () => {
    const h = await harness({ executor: 'MOCK' });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('WOULD_ACTIVATE');
    expect(decision[0]!.reason).toBe('EXECUTOR_NOT_HUAWEI');
    expect(h.live.activateCalls).toBe(0);
  });

  it('4) AUTO fora da allowlist => nao escreve', async () => {
    const h = await harness({ allowlist: ['outro-device'] });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('WOULD_ACTIVATE');
    expect(decision[0]!.reason).toBe('DEVICE_NOT_ALLOWED');
    expect(h.live.activateCalls).toBe(0);
  });

  it('5) profile ALERT_ONLY acima do threshold => ALERT_TRIGGERED (zero escrita)', async () => {
    const h = await harness({ target: { mode: 'ALERT_ONLY' } });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('ALERT_TRIGGERED');
    expect(decision[0]!.reason).toBeNull();
    expect(h.live.activateCalls).toBe(0);
    expect(h.live.preflightCalls).toBe(0);
  });

  it('5b) ALERT_ONLY abaixo do threshold => NO_ACTION', async () => {
    const h = await harness({ target: { mode: 'ALERT_ONLY' } });
    const decision = await h.run(3, h.under);
    expect(decision[0]!.outcome).toBe('NO_ACTION');
    expect(decision[0]!.reason).toBe('THRESHOLD_NOT_EXCEEDED');
  });

  it('5c) ALERT_ONLY acima do threshold com 2 samples => TRIGGER_PENDING', async () => {
    const h = await harness({ target: { mode: 'ALERT_ONLY' } });
    const decision = await h.run(2, h.over);
    expect(decision[0]!.outcome).toBe('TRIGGER_PENDING');
    expect(decision[0]!.reason).toBe('SAMPLES_INSUFFICIENT');
    expect(h.live.activateCalls).toBe(0);
  });

  it('6) profile DISABLED => bloqueado', async () => {
    const h = await harness({ target: { mode: 'DISABLED' } });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.reason).toBe('PROFILE_DISABLED');
    expect(h.live.activateCalls).toBe(0);
  });

  it('7) threshold abaixo => NO_ACTION', async () => {
    const h = await harness();
    const decision = await h.run(3, h.under);
    expect(decision[0]!.outcome).toBe('NO_ACTION');
    expect(decision[0]!.reason).toBe('THRESHOLD_NOT_EXCEEDED');
    expect(h.live.activateCalls).toBe(0);
  });

  it('8) 90% exato => NO_ACTION (nao escreve)', async () => {
    const h = await harness();
    const decision = await h.run(3, h.exact);
    expect(decision[0]!.outcome).toBe('NO_ACTION');
    expect(decision[0]!.reason).toBe('THRESHOLD_NOT_EXCEEDED');
    expect(h.live.activateCalls).toBe(0);
  });

  it('9) >90% com menos de 3 samples => TRIGGER_PENDING', async () => {
    const h = await harness();
    const decision = await h.run(2, h.over);
    expect(decision[0]!.outcome).toBe('TRIGGER_PENDING');
    expect(decision[0]!.reason).toBe('SAMPLES_INSUFFICIENT');
    expect(h.live.activateCalls).toBe(0);
  });

  it('9b) CRITICO: a MESMA amostra lida em 3 ticks NAO conta como 3 samples', async () => {
    const h = await harness();
    // amostra colada (mesma identidade de InterfaceMetricSample) em 3 ticks
    h.traffic.setSticky(h.profileId, h.over, 'amostra-123');
    await h.engine.tick();
    await h.engine.tick();
    const decision = await h.engine.tick();
    expect(decision[0]!.outcome).toBe('TRIGGER_PENDING');
    expect(decision[0]!.reason).toBe('SAMPLES_INSUFFICIENT');
    expect(decision[0]!.samplesOver).toBe(1);
    expect(h.live.activateCalls).toBe(0);
  });

  it('9c) 3 samples DISTINTOS (timestamps diferentes) => ACTIVATED', async () => {
    const h = await harness();
    const decision = await h.run(3, h.over);
    expect(decision[0]!.samplesOver).toBe(3);
    expect(decision[0]!.outcome).toBe('ACTIVATED');
  });

  it('9d) target NOT_READY (sem snapshot de discovery) => BLOCKED, zero escrita', async () => {
    const h = await harness({ target: { readiness: 'NOT_READY', prefixStatus: 'UNKNOWN' } });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('BLOCKED');
    expect(decision[0]!.reason).toBe('TARGET_NOT_READY');
    expect(h.live.activateCalls).toBe(0);
    expect(h.live.preflightCalls).toBe(0);
  });

  it('H1) UMA amostra >90% lida em 10 ticks => samplesOver=1, TRIGGER_PENDING, ACTIVATE=0', async () => {
    const h = await harness();
    h.traffic.setSticky(h.profileId, h.over, 'sample-1');
    let last = await h.engine.tick();
    for (let i = 0; i < 9; i += 1) last = await h.engine.tick();
    expect(last[0]!.samplesOver).toBe(1);
    expect(last[0]!.outcome).toBe('TRIGGER_PENDING');
    expect(last[0]!.reason).toBe('SAMPLES_INSUFFICIENT');
    expect(h.live.activateCalls).toBe(0);
  });

  it('H2) DUAS amostras distintas >90% => samplesOver=2 e nao ativa', async () => {
    const h = await harness();
    h.traffic.push(h.profileId, h.over, 's1');
    await h.engine.tick();
    h.traffic.push(h.profileId, h.over, 's2');
    const decision = await h.engine.tick();
    expect(decision[0]!.samplesOver).toBe(2);
    expect(h.live.activateCalls).toBe(0);
  });

  it('H4) restart entre samples: a MESMA amostra nao conta de novo (identidade persistida)', async () => {
    const h = await harness();
    const key1 = '2026-09-30T23:00:00.000Z';
    h.traffic.setSticky(h.profileId, h.over, key1, new Date(key1));
    const first = await h.engine.tick();
    expect(first[0]!.samplesOver).toBe(1);

    // "restart": novo motor, MESMO repositorio (runtime persistido).
    const h2 = await harness({ repository: h.repository });
    h2.traffic.setSticky(h.profileId, h.over, key1, new Date(key1));
    const afterRestart = await h2.engine.tick();
    expect(afterRestart[0]!.samplesOver).toBe(1);

    const key2 = '2026-09-30T23:05:00.000Z';
    h2.traffic.push(h.profileId, h.over, key2, new Date(key2));
    const second = await h2.engine.tick();
    expect(second[0]!.samplesOver).toBe(2);
  });

  it('H5) timestamp mais ANTIGO (telemetria atrasada) NAO conta como nova amostra', async () => {
    const h = await harness();
    const t2 = '2026-09-30T23:10:00.000Z';
    h.traffic.push(h.profileId, h.over, t2, new Date(t2));
    const first = await h.engine.tick();
    expect(first[0]!.samplesOver).toBe(1);

    // chega T1 < T2 (reordenacao/atraso): nao incrementa
    const t1 = '2026-09-30T23:00:00.000Z';
    h.traffic.push(h.profileId, h.over, t1, new Date(t1));
    const stale = await h.engine.tick();
    expect(stale[0]!.samplesOver).toBe(1);
    expect(h.live.activateCalls).toBe(0);

    // T3 > T2: incrementa exatamente 1 vez
    const t3 = '2026-09-30T23:15:00.000Z';
    h.traffic.push(h.profileId, h.over, t3, new Date(t3));
    const fresh = await h.engine.tick();
    expect(fresh[0]!.samplesOver).toBe(2);
  });

  it('10) >90% com 3 samples e gates verdes => ACTIVATED', async () => {
    const h = await harness();
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('ACTIVATED');
    expect(decision[0]!.commandStatus).toBe('ACTIVATED_VERIFIED');
    expect(decision[0]!.verified).toBe(true);
  });

  it('11) ACTIVATE passa pelo MitigationCommandService (preflight + read-back)', async () => {
    const h = await harness();
    await h.run(3, h.over);
    expect(h.live.preflightCalls).toBe(1);
    expect(h.live.activateCalls).toBe(1);
    expect(h.live.readRoutePolicyCalls).toBe(1);
  });

  it('12) ACTIVATED_VERIFIED muda o runtime para MITIGATED', async () => {
    const h = await harness();
    await h.run(3, h.over);
    const runtime = await h.repository.getRuntime(h.profileId);
    expect(runtime?.state).toBe('MITIGATED');
  });

  it('13) notificacao MITIGATION_VERIFIED publicada com simulation=false', async () => {
    const h = await harness();
    await h.run(3, h.over);
    expect(h.notified).toContain('MITIGATION_VERIFIED');
  });

  it('14) peer excluido => bloqueado sem escrita', async () => {
    const h = await harness();
    await h.repository.setPeerExclusion({
      peerId: 'peer-1',
      deviceId: DEVICE,
      peerAddress: PEER,
      addressFamily: 'IPV4',
      interfaceId: 'if-1',
      excluded: true,
      reason: 'TRANSIT',
    });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('BLOCKED');
    expect(decision[0]!.reason).toBe('PEER_MITIGATION_EXCLUDED');
    expect(h.live.activateCalls).toBe(0);
    expect(h.live.preflightCalls).toBe(0);
  });

  it('15) profile excluido => bloqueado sem escrita', async () => {
    const h = await harness({ target: { mitigationExcluded: true } });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.reason).toBe('MITIGATION_EXCLUDED');
    expect(h.live.activateCalls).toBe(0);
  });

  it('16) sharedPolicy nao bloqueia (aviso) e a decisao registra', async () => {
    const h = await harness({ target: { sharedPolicy: true } });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.sharedPolicy).toBe(true);
    expect(decision[0]!.outcome).toBe('ACTIVATED');
  });

  it('17) ticks concorrentes nao duplicam ACTIVATE', async () => {
    const h = await harness();
    h.traffic.push(h.profileId, h.over);
    h.traffic.push(h.profileId, h.over);
    h.traffic.push(h.profileId, h.over);
    const [a, b, c] = await Promise.all([h.engine.tick(), h.engine.tick(), h.engine.tick()]);
    const outcomes = [...a, ...b, ...c].map((d) => d.outcome);
    expect(h.live.activateCalls).toBe(1);
    expect(outcomes.filter((outcome) => outcome === 'ACTIVATED')).toHaveLength(1);
  });

  it('18) timeout no ACTIVATE => sem retry cego (novo ciclo faz read-back antes)', async () => {
    const h = await harness();
    h.live.failNextActivate = true;
    const first = await h.run(3, h.over);
    expect(first[0]!.outcome).toBe('FAILED');
    expect(h.live.activateCalls).toBe(1);
    expect(h.engine.isBusy(h.profileId)).toBe(false);

    const second = await h.run(3, h.over);
    expect(second[0]!.outcome).toBe('ACTIVATED');
    expect(h.live.preflightCalls).toBe(2); // read-back do caminho canonico antes da 2a escrita
    expect(h.live.activateCalls).toBe(2);
  });

  it('19) MITIGATED nao ativa novamente', async () => {
    const h = await harness({ target: { runtimeState: 'MITIGATED' } });
    const decision = await h.run(3, h.over);
    expect(decision[0]!.outcome).toBe('NO_ACTION');
    expect(decision[0]!.reason).toBe('ALREADY_MITIGATED');
    expect(h.live.activateCalls).toBe(0);
  });

  it('20) trafego em queda nao dispara REMOVE automatico', async () => {
    const h = await harness({ target: { runtimeState: 'MITIGATED' } });
    const decision = await h.run(12, h.under);
    expect(decision[0]!.outcome).toBe('RECOVERY_PENDING');
    expect(decision[0]!.reason).toBe('AUTO_REMOVE_DISABLED');
    expect(h.live.removeCalls).toBe(0);
  });

  it('21) REMOVE manual continua funcionando (n8n/UI) e o AUTO nao remove', async () => {
    const h = await harness();
    const removed = await h.commands.execute({
      requestId: 'manual-remove-1',
      action: 'REMOVE',
      profileId: h.profileId,
    });
    expect(removed.ok).toBe(true);
    expect(removed.status).toBe('REMOVED_VERIFIED');
    expect(h.live.removeCalls).toBe(1);
    expect(h.live.activateCalls).toBe(0);
  });
});