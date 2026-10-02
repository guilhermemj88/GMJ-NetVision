import { describe, expect, it } from 'vitest';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { BgpMitigationService } from './mitigation-service';
import type { MitigationDiscoveryResult } from './mitigation-discovery-service';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from '../../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../../worker/mitigation/mitigation-traffic-source';

// REIDRATACAO DOS SNAPSHOTS DE DISCOVERY APOS RESTART.
// O cache de discovery e em memoria: sem reidratacao a UI perde cliente/interface/
// prefixos e tudo vira NOT_READY ate alguem clicar em "Descobrir clientes".

const DEVICE = 'device-1';
const POLICY = 'PL-HORIZONTES_IPv4-IN';

function row(over: Record<string, unknown> = {}) {
  return {
    profileId: 'profile-1',
    policyName: POLICY,
    addressFamily: 'IPV4',
    sharedPolicy: false,
    sharedPolicyTargets: [],
    autoBlockedReason: null,
    customer: 'HORIZONTE_IP',
    interfaceId: 'if-1',
    interfaceName: 'Eth-Trunk1.3011',
    interfaceDescriptionRaw: 'HORIZONTE_IP_40GB',
    detectedBandwidthBps: 40_000_000_000n,
    effectiveBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    peerAddresses: ['10.200.200.106'],
    prefixCount: 3,
    prefixLimit: 100,
    prefixStatus: 'SAFE',
    existingNodes: [11, 50],
    mitigationNodes: [],
    bogonNodes: [],
    bogonPrefixList: 'BOGONS',
    targetPrefixList: 'PREFIX8to24',
    firstNormalNode: 11,
    plannedNode: 2,
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    readiness: 'READY',
    blockedReason: null,
    ...over,
  };
}

function discoveryStub(profiles: unknown[], scannedPeers = 108, fail = false) {
  const calls = { discoverMitigationProfiles: 0 };
  const result: MitigationDiscoveryResult = {
    deviceId: DEVICE,
    scannedPeers,
    candidateInterfaces: profiles.length,
    ignoredNoBandwidth: 0,
    createdProfiles: 0,
    updatedProfiles: profiles.length,
    blockedProfiles: 0,
    outOfScopeProfiles: [],
    ambiguousPeers: [],
    warnings: [],
    profiles: profiles as never,
  };
  return {
    calls,
    discovery: {
      async discoverMitigationProfiles() {
        calls.discoverMitigationProfiles += 1;
        if (fail) throw new Error('ssh readback falhou');
        return result;
      },
      async discoverFromBgpOutcome() {
        calls.discoverMitigationProfiles += 1;
        if (fail) throw new Error('ssh readback falhou');
        return result;
      },
    },
  };
}

function serviceFor(
  repository: InMemoryMitigationRepository,
  discovery: unknown,
  hosts = { getHost: async () => ({ id: DEVICE, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01', sshEnabled: true }) },
) {
  return new BgpMitigationService({
    repository,
    discovery: discovery as never,
    hosts: hosts as never,
    schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
    repositoryKind: 'DATABASE',
  });
}

async function seed(): Promise<InMemoryMitigationRepository> {
  const repository = new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: DEVICE,
    policyName: POLICY,
    interfaceId: 'if-1',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    mode: 'AUTO',
    bandwidthOverrideBps: 10_000_000_000n,
    mitigationExcluded: true,
    mitigationExclusionReason: 'UPLINK',
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerId: 'peer-1', peerAddress: '10.200.200.106', primary: true },
  ]);
  return repository;
}

describe('reidratacao dos snapshots de discovery', () => {
  it('A) sem cache o profile aparece como NOT_READY/sem cliente (o bug)', async () => {
    const repository = await seed();
    const service = serviceFor(repository, discoveryStub([]).discovery);
    const dto = await service.getProfile('profile-1');
    expect(dto?.readiness).toBe('NOT_READY');
    expect(dto?.snapshotAvailable).toBe(false);
    expect(dto?.customer).toBeNull();
    expect(dto?.prefixStatus).toBe('UNKNOWN');
    expect(dto?.existingNodes).toEqual([]);
    expect(service.snapshotHydration().state).toBe('PENDING');
  });

  it('B) rehydration restaura cliente/interface/prefixos/readiness', async () => {
    const repository = await seed();
    const stub = discoveryStub([row()]);
    const service = serviceFor(repository, stub.discovery);
    const summary = await service.rehydrateSnapshots();
    expect(summary).toEqual({ devices: 1, succeeded: 1, failed: 0 });
    const dto = await service.getProfile('profile-1');
    expect(dto?.customer).toBe('HORIZONTE_IP');
    expect(dto?.interfaceName).toBe('Eth-Trunk1.3011');
    expect(dto?.prefixStatus).toBe('SAFE');
    expect(dto?.existingNodes).toEqual([11, 50]);
    expect(dto?.readiness).toBe('READY');
    expect(dto?.snapshotAvailable).toBe(true);
    expect(service.snapshotHydration().state).toBe('READY');
  });

  it('D) rehydration preserva mode/exclusao/override (nada administrado e sobrescrito)', async () => {
    const repository = await seed();
    const service = serviceFor(repository, discoveryStub([row()]).discovery);
    await service.rehydrateSnapshots();
    const record = await repository.getProfile('profile-1');
    expect(record?.mode).toBe('AUTO');
    expect(record?.mitigationExcluded).toBe(true);
    expect(record?.mitigationExclusionReason).toBe('UPLINK');
    expect(record?.bandwidthOverrideBps).toBe(10_000_000_000n);
  });

  it('E) falha de SSH => DEGRADED, API viva, fail-closed (AUTO continua bloqueado)', async () => {
    const repository = await seed();
    const service = serviceFor(repository, discoveryStub([], 0, true).discovery);
    const summary = await service.rehydrateSnapshots();
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(service.snapshotHydration().state).toBe('DEGRADED');
    expect(service.snapshotHydration().lastError).toBeTruthy();
    const dto = await service.getProfile('profile-1');
    expect(dto?.readiness).toBe('NOT_READY');
    expect(dto?.snapshotAvailable).toBe(false);
  });

  it('F) varios profiles do MESMO device => uma unica leitura de discovery', async () => {
    const repository = await seed();
    await repository.upsertProfile({
      deviceId: DEVICE,
      policyName: 'PL-BHNET_IPv4-IN',
      interfaceId: 'if-2',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    const stub = discoveryStub([row()]);
    const service = serviceFor(repository, stub.discovery);
    const summary = await service.rehydrateSnapshots();
    expect(summary.devices).toBe(1);
    expect(stub.calls.discoverMitigationProfiles).toBe(1);
  });
});
// ---------------------------------------------------------------------------
// HARNESS DE RESTART: sem snapshot o motor e fail-closed; a hydration devolve o
// estado real sem clique manual.
// ---------------------------------------------------------------------------
describe('harness de restart: snapshot explicito no motor', () => {
  type ProfileDto = NonNullable<Awaited<ReturnType<BgpMitigationService['getProfile']>>>;

  function targetFromDto(
    dto: ProfileDto,
    over: Partial<MitigationAutoTargetState> = {},
  ): MitigationAutoTargetState {
    return {
      profileId: dto.id,
      deviceId: dto.deviceId,
      interfaceId: dto.interfaceId,
      customer: dto.customer,
      mode: dto.mode,
      snapshotAvailable: dto.snapshotAvailable,
      readiness: dto.readiness,
      prefixStatus: dto.prefixStatus,
      blockedReason: dto.blockedReason,
      mitigationExcluded: dto.mitigationExcluded === true,
      runtimeState: 'NORMAL',
      effectiveBandwidthBps: 10_000_000_000n,
      bogonNode: dto.plannedBogonNode ?? 1,
      mitigationNode: dto.plannedMitigationNode ?? 2,
      sharedPolicy: dto.sharedPolicy,
      peerAddresses: dto.peerAddresses,
      triggerPercent: 90,
      recoveryPercent: 70,
      triggerSamples: 3,
      recoverySamples: 12,
      ...over,
    };
  }

  // Fonte que EXPLODE se chamada: prova que o gate de snapshot barra antes de
  // qualquer telemetria/executor.
  const throwingTraffic = {
    async sample(): Promise<bigint | null> {
      throw new Error('telemetria nao deveria ser chamada');
    },
    async sampleWithId(): Promise<never> {
      throw new Error('telemetria nao deveria ser chamada');
    },
  };

  function engineFor(target: MitigationAutoTargetState, traffic: unknown) {
    return new MitigationAutoEngine({
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
      targets: { list: async () => [target] },
      traffic: traffic as never,
      exclusions: { listPeerExclusions: async () => [] },
      runtime: { get: async () => null, save: async () => {} },
      commands: {
        execute: async () => {
          throw new Error('executor nao deveria ser chamado');
        },
      },
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    });
  }

  it('A/C) pos-restart sem snapshot: AUTO e ALERT_ONLY => SNAPSHOT_UNAVAILABLE, zero executor', async () => {
    const repository = await seed();
    const service = serviceFor(repository, discoveryStub([row()]).discovery);
    const dto = await service.getProfile('profile-1');
    expect(dto?.snapshotAvailable).toBe(false);
    expect(dto?.readiness).toBe('NOT_READY');

    for (const mode of ['AUTO', 'ALERT_ONLY'] as const) {
      const engine = engineFor(targetFromDto(dto!, { mode }), throwingTraffic);
      const [decision] = await engine.tick();
      expect(decision!.outcome).toBe('BLOCKED');
      expect(decision!.reason).toBe('SNAPSHOT_UNAVAILABLE');
    }
  });

  it('D) hydration conclui: snapshotAvailable=true e o target volta ao estado real', async () => {
    const repository = await seed();
    const service = serviceFor(repository, discoveryStub([row()]).discovery);
    await service.rehydrateSnapshots();
    const dto = await service.getProfile('profile-1');
    expect(dto?.snapshotAvailable).toBe(true);
    expect(dto?.readiness).toBe('READY');
    expect(dto?.customer).toBe('HORIZONTE_IP');

    // Ja passa do gate de snapshot: com trafego abaixo do threshold o motor
    // registra NO_ACTION em vez de SNAPSHOT_UNAVAILABLE.
    const traffic = new SequenceTrafficSource();
    traffic.push(dto!.id, 1_000_000_000n);
    // A exclusao administrativa do seed continua bloqueando ANTES do threshold:
    // provamos aqui que o gate de snapshot ja passou.
    const excluded = engineFor(targetFromDto(dto!), traffic);
    const [blocked] = await excluded.tick();
    expect(blocked!.reason).toBe('MITIGATION_EXCLUDED');
    expect(blocked!.reason).not.toBe('SNAPSHOT_UNAVAILABLE');

    const traffic2 = new SequenceTrafficSource();
    traffic2.push(dto!.id, 1_000_000_000n);
    const engine = engineFor(targetFromDto(dto!, { mitigationExcluded: false }), traffic2);
    const [decision] = await engine.tick();
    expect(decision!.reason).toBe('THRESHOLD_NOT_EXCEEDED');
    expect(decision!.reason).not.toBe('SNAPSHOT_UNAVAILABLE');
  });

  it('E) hydration DEGRADED => snapshotAvailable=false (fail-closed, sem clique manual)', async () => {
    const repository = await seed();
    const service = serviceFor(repository, discoveryStub([], 0, true).discovery);
    await service.rehydrateSnapshots();
    expect(service.snapshotHydration().state).toBe('DEGRADED');
    const dto = await service.getProfile('profile-1');
    expect(dto?.snapshotAvailable).toBe(false);

    const engine = engineFor(targetFromDto(dto!, { mode: 'AUTO' }), throwingTraffic);
    const [decision] = await engine.tick();
    expect(decision!.reason).toBe('SNAPSHOT_UNAVAILABLE');
  });
});
