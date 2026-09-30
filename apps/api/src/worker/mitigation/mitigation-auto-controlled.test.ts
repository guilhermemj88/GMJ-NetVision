import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from '../../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import {
  MitigationCommandService,
  type MitigationLiveExecutorPort,
} from '../../infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from '../../infrastructure/bgp/mitigation/mitigation-executor';
import type {
  MitigationPreflightInput,
  MitigationPreflightResult,
} from '../../infrastructure/bgp/mitigation/huawei-mitigation-executor';
import { MitigationAutoEngine } from './mitigation-auto-engine';
import { SequenceTrafficSource } from './mitigation-traffic-source';

// TESTE CONTROLADO SEM ESCRITA (janela pré-produção do AUTO).
//
// Configuração do ambiente (documentada, não aplicada em produção):
//   MITIGATION_MODE=AUTO
//   MITIGATION_EXECUTOR=HUAWEI
//   MITIGATION_LIVE_WRITE_ENABLED=false
//   MITIGATION_ALLOWED_DEVICE_IDS=host-377c554a-8d1e-47c4-baa4-f258693b4d91 (F1A)
//   BHNET-CEASA em AUTO; demais profiles ALERT_ONLY/DISABLED
//   telemetria INJETADA no teste (89% / 90% / 91%), nunca tráfego real.
//
// Esperado: 89% e 90% => NO_ACTION; 91% com <3 samples => SAMPLES_INSUFFICIENT;
// 91% com 3 samples => WOULD_ACTIVATE / LIVE_WRITE_DISABLED, com ZERO escrita.

const F1A = 'host-377c554a-8d1e-47c4-baa4-f258693b4d91';
const BANDWIDTH = 10_000_000_000n; // 10 Gbps contratado (descrição da interface)
const ALERT_PROFILE_IFACE = 'if-outro';

function host(): HostRecord {
  return {
    id: F1A,
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
  } as unknown as HostRecord;
}

class CountingLiveExecutor implements MitigationLiveExecutorPort {
  preflightCalls = 0;
  activateCalls = 0;
  removeCalls = 0;
  readRoutePolicyCalls = 0;
  enabledFor(): boolean {
    return true;
  }
  async resolveActivePair() {
    return { bogonNode: 1, mitigationNode: 2 };
  }
  async preflight(_d: HostRecord, input: MitigationPreflightInput): Promise<MitigationPreflightResult> {
    this.preflightCalls += 1;
    return {
      ok: true,
      mode: input.mode,
      deviceId: F1A,
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
  async activate() {
    this.activateCalls += 1;
    return { output: 'nao deveria ocorrer' };
  }
  async remove() {
    this.removeCalls += 1;
    return { output: 'ok' };
  }
  async readRoutePolicy() {
    this.readRoutePolicyCalls += 1;
    return 'route-policy PL-BHNET_IPv4-IN permit node 10';
  }
}

async function scenario(mode: 'AUTO' | 'ALERT_ONLY') {
  const repository = new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: F1A,
    policyName: mode === 'AUTO' ? 'PL-BHNET_IPv4-IN' : 'PL-OUTRO_IPv4-IN',
    interfaceId: mode === 'AUTO' ? 'if-bhnet' : ALERT_PROFILE_IFACE,
    addressFamily: 'IPV4',
    detectedBandwidthBps: BANDWIDTH,
    bandwidthSource: 'DESCRIPTION',
    mode,
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerId: 'peer-1', peerAddress: '10.200.200.222', primary: true },
  ]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });

  const live = new CountingLiveExecutor();
  const commands = new MitigationCommandService({
    repository,
    hosts: { getHost: async () => host() },
    executor: new MockMitigationExecutor(),
    live,
  });
  const traffic = new SequenceTrafficSource();
  const engine = new MitigationAutoEngine({
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: false, allowedDeviceIds: [F1A] },
    targets: {
      list: async () => [
        {
          profileId: profile.id,
          deviceId: F1A,
          interfaceId: mode === 'AUTO' ? 'if-bhnet' : ALERT_PROFILE_IFACE,
          customer: mode === 'AUTO' ? 'BHNET-CEASA' : 'OUTRO-CLIENTE',
          mode,
          readiness: 'READY',
          prefixStatus: 'SAFE',
          blockedReason: null,
          mitigationExcluded: false,
          runtimeState: 'NORMAL',
          effectiveBandwidthBps: BANDWIDTH,
          bogonNode: 1,
          mitigationNode: 2,
          sharedPolicy: false,
          peerAddresses: ['10.200.200.222'],
          triggerPercent: 90,
          recoveryPercent: 70,
          triggerSamples: 3,
          recoverySamples: 12,
        },
      ],
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
  });

  const runAt = async (percent: number, times: number) => {
    const value = (BANDWIDTH * BigInt(Math.round(percent * 100))) / 10000n;
    let last: Awaited<ReturnType<typeof engine.tick>> = [];
    for (let i = 0; i < times; i += 1) {
      traffic.push(profile.id, value);
      last = await engine.tick();
    }
    return last[0]!;
  };

  return { repository, profileId: profile.id, live, engine, runAt };
}

describe('teste controlado do AUTO sem escrita (LIVE_WRITE=false)', () => {
  it('89% com 3 samples => NO_ACTION', async () => {
    const s = await scenario('AUTO');
    const decision = await s.runAt(89, 3);
    expect(decision.outcome).toBe('NO_ACTION');
    expect(decision.reason).toBe('THRESHOLD_NOT_EXCEEDED');
  });

  it('90% exato com 3 samples => NO_ACTION', async () => {
    const s = await scenario('AUTO');
    const decision = await s.runAt(90, 3);
    expect(decision.outcome).toBe('NO_ACTION');
    expect(decision.reason).toBe('THRESHOLD_NOT_EXCEEDED');
  });

  it('91% com 2 samples => SAMPLES_INSUFFICIENT', async () => {
    const s = await scenario('AUTO');
    const decision = await s.runAt(91, 2);
    expect(decision.outcome).toBe('TRIGGER_PENDING');
    expect(decision.reason).toBe('SAMPLES_INSUFFICIENT');
  });

  it('91% com 3 samples => WOULD_ACTIVATE / LIVE_WRITE_DISABLED e ZERO escrita', async () => {
    const s = await scenario('AUTO');
    const decision = await s.runAt(91, 3);
    expect(decision.outcome).toBe('WOULD_ACTIVATE');
    expect(decision.reason).toBe('LIVE_WRITE_DISABLED');
    expect(s.live.activateCalls).toBe(0);
    expect(s.live.preflightCalls).toBe(0);
    expect(s.live.readRoutePolicyCalls).toBe(0);
    expect(s.live.removeCalls).toBe(0);
  });

  it('profile ALERT_ONLY cruzando threshold => ALERT_TRIGGERED e ZERO escrita', async () => {
    const s = await scenario('ALERT_ONLY');
    const decision = await s.runAt(95, 3);
    expect(decision.outcome).toBe('ALERT_TRIGGERED');
    expect(s.live.activateCalls).toBe(0);
    expect(s.live.preflightCalls).toBe(0);
    expect(s.live.readRoutePolicyCalls).toBe(0);
  });
});