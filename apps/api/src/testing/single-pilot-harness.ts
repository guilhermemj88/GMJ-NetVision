import type { HostRecord } from '@gmj/shared';
import {
  AutoMitigationLifecycle,
  lifecycleConfig,
  type LifecycleTarget,
  type ScopeOwnership,
  scopeKey,
} from '../worker/mitigation/auto-lifecycle';
import {
  SINGLE_AUTO_PILOT as P,
  pilotEvidenceValid,
  singlePilotPhysicalScopeMatches,
} from '../worker/mitigation/single-pilot-trigger';
import { MemoryAutomationStore, type AutomationStore } from '../worker/mitigation/automation-store';
import { InMemoryMitigationRepository } from '../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { MitigationCommandService } from '../infrastructure/bgp/mitigation/mitigation-command-service';
import {
  HuaweiMitigationExecutor,
  type MitigationSshPort,
} from '../infrastructure/bgp/mitigation/huawei-mitigation-executor';
import { MockMitigationExecutor } from '../infrastructure/bgp/mitigation/mitigation-executor';
import { AutomationMitigationBaselineStore } from '../worker/mitigation/baseline-store';
import { testDurableBaselineStore } from '../infrastructure/bgp/mitigation/mitigation-test-support';
import { InMemoryPolicyScopeLock } from '../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { inspectPolicyMitigation } from '../infrastructure/bgp/mitigation/mitigation-policy-physical';
import { resolveAutoClientBinding } from '../worker/mitigation/auto-client-binding';
import {
  FastObservationSource,
  type FastBridgeSnapshot,
} from '../worker/mitigation/fast-observation-bridge';
import { deriveFastTraffic } from '../infrastructure/snmp/fast-traffic-rate';
import type { FastCounterReading } from '../infrastructure/snmp/fast-traffic-types';

/** Fake only at the transport boundary. Real executor/preflight/parser build the result. */
export class PilotFakeHuawei implements MitigationSshPort {
  active = false;
  partial = false;
  timeout = false;
  readFails = false;
  wrongRt = false;
  preexisting = false;
  prefixes = true;
  sharedBinding = false;
  writes: string[][] = [];
  afterWrite?: () => Promise<void>;
  config() {
    const sent = this.writes.at(-1) ?? [
      `route-policy ${P.policy} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${P.policy} permit node 2`,
      ' apply extcommunity rt 268568:660',
    ];
    let installed = sent.filter((line) => line !== 'system-view' && line !== 'commit');
    if (this.partial)
      installed = installed.slice(
        0,
        installed.findIndex((line) => line.includes(' permit node 2')),
      );
    if (this.wrongRt) installed = installed.map((line) => line.replace(P.rt, '64500:999'));
    return [
      ...(this.active ? installed : []),
      ...(this.preexisting
        ? [`route-policy ${P.policy} permit node 50`, ' if-match ip-prefix OPERATOR-ONLY']
        : []),
      `route-policy ${P.policy} permit node 10`,
      ' if-match ip-prefix AGLINK-BLOCO-TODO-23',
      ' apply local-preference 1100',
      ' apply extcommunity rt 268568:140 additive',
      `route-policy ${P.policy} deny node 1000`,
    ].join('\n');
  }
  async readMitigationConfiguration() {
    if (this.readFails) throw Error('synthetic SSH read timeout');
    return {
      routePolicyConfiguration: this.config(),
      prefixListConfiguration: this.prefixes
        ? 'ip ip-prefix BOGONS index 40 permit 10.0.0.0 8 greater-equal 8 less-equal 32\nip ip-prefix PREFIX8to24 index 10 permit 0.0.0.0 8 greater-equal 8 less-equal 24\nip ip-prefix AGLINK-BLOCO-TODO-23 index 10 permit 167.250.126.0 23 greater-equal 23 less-equal 24'
        : '',
      warnings: [],
    };
  }
  async readMitigationRoutePolicy() {
    if (this.readFails) throw Error('synthetic read timeout');
    return this.config();
  }
  async applyMitigationCommands(_host: HostRecord, commands: readonly string[]) {
    this.writes.push([...commands]);
    this.active = !commands.some((c) => c.startsWith('undo route-policy'));
    await this.afterWrite?.();
    if (this.timeout) throw Error('synthetic timeout after write');
    return { ok: true, output: 'simulated transport' };
  }
}

export async function createPilotHarness(store: AutomationStore = new MemoryAutomationStore()) {
  let now = Date.parse('2026-10-30T12:00:00Z');
  const repository = new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: P.deviceId,
    interfaceId: P.interfaceId,
    policyName: P.policy,
    addressFamily: 'IPV4',
    mode: 'AUTO',
    detectedBandwidthBps: P.bandwidthBps,
    bandwidthSource: 'DESCRIPTION',
  });
  repository.storeRef.profiles.delete(profile.id);
  profile.id = P.profileId;
  repository.storeRef.profiles.set(profile.id, profile);
  await repository.replaceProfilePeers(profile.id, [
    { peerAddress: '10.200.201.2', addressFamily: 'IPV4', primary: true },
  ]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedNode: 2,
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
  });
  const iface = {
    id: P.interfaceId,
    name: P.interfaceName,
    ifIndex: P.ifIndex,
    description: P.interfaceName,
    alias: 'AGLINK-IPV4_10GB',
    adminStatus: 'UP',
    operStatus: 'UP',
  };
  const host = {
    id: P.deviceId,
    hostname: P.hostname,
    displayName: P.hostname,
    interfaces: [iface],
    sshEnabled: true,
    ssh: { host: '192.0.2.254', port: 22, username: 'synthetic' },
  } as unknown as HostRecord;
  const target: LifecycleTarget = {
    profileId: P.profileId,
    deviceId: P.deviceId,
    interfaceId: P.interfaceId,
    policyName: P.policy,
    customer: P.customer,
    addressFamily: 'IPV4',
    direction: 'tx',
    enabled: true,
    mode: 'AUTO',
    snapshotAvailable: true,
    readiness: 'READY',
    prefixStatus: 'SAFE',
    blockedReason: null,
    runtimeState: 'NORMAL',
    mitigationExcluded: false,
    effectiveBandwidthBps: P.bandwidthBps,
    bogonNode: 1,
    mitigationNode: 2,
    sharedPolicy: false,
    peerAddresses: ['10.200.201.2'],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
    rt: P.rt,
    scopeMembers: 1,
    fast: true,
    otherFamilyAuto: false,
    clientBinding: resolveAutoClientBinding(
      {
        profileId: P.profileId,
        deviceId: P.deviceId,
        interfaceId: P.interfaceId,
        customer: P.customer,
        direction: 'tx',
        detectedBandwidthBps: P.bandwidthBps,
        bandwidthOverrideBps: null,
      },
      host,
    ),
  };
  const config = {
    ...lifecycleConfig({}),
    installation: 'IMPLANTAR',
    enabled: true,
    executionEnabled: true,
    profiles: [P.profileId] as string[],
    devices: [P.deviceId] as string[],
    cooldownMs: 60_000,
  };
  let reading: FastCounterReading = {
    deviceId: P.deviceId,
    interfaceId: P.interfaceId,
    ifIndex: P.ifIndex,
    interfaceName: P.interfaceName,
    speedBps: 300_000_000_000n,
    requestStartedAt: new Date(now),
    collectedAt: new Date(now),
    inOctets: 0n,
    outOctets: 0n,
    uptimeTicks: 100000n,
    discontinuityTicks: 0n,
    lastChangeTicks: 0n,
    adminStatus: 1,
    operStatus: 1,
  };
  const wireTarget = { ...reading, profiles: [] };
  let snapshot: FastBridgeSnapshot = {
    mapping: {
      id: P.interfaceId,
      deviceId: P.deviceId,
      ifIndex: P.ifIndex,
      name: P.interfaceName,
      speedBps: reading.speedBps,
      adminStatus: 'UP',
      operStatus: 'UP',
    },
    previous: null,
    current: deriveFastTraffic(wireTarget, reading, undefined, 'test-generation'),
    collectorAvailable: true,
  };
  const source = new FastObservationSource({
    config: {
      mode: 'SHADOW',
      profileIds: [P.profileId],
      enforceProfileIds: [],
      maxAgeMs: 30000,
      maxGapMs: 45000,
    },
    profile: () => ({
      profileId: P.profileId,
      deviceId: P.deviceId,
      interfaceId: P.interfaceId,
      direction: 'tx',
      revision: 'fixture-config',
    }),
    reader: { snapshot: async () => snapshot },
    now: () => new Date(now),
  });
  const ssh = new PilotFakeHuawei();
  // B6: a escrita real exige armazenamento DURAVEL do baseline. Com um store de
  // persistencia, o registro vai para o banco; sem ele, backend duravel de teste.
  const baselineStore =
    store instanceof MemoryAutomationStore
      ? testDurableBaselineStore()
      : new AutomationMitigationBaselineStore(store);
  const live = new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [P.deviceId] },
    // B6: escrita real exige armazenamento duravel do baseline. O harness usa o
    // store persistente recebido; sem ele, um backend duravel de teste.
    baseline: baselineStore,
  });
  let lifecycle: AutoMitigationLifecycle;
  let commands: MitigationCommandService;
  const physical = async () => {
    const state = inspectPolicyMitigation({
      policyName: P.policy,
      readBack: await live.readRoutePolicy(host, P.policy),
      rts: [P.rt],
    });
    return {
      state:
        state.recognized && state.state !== 'RECONCILIATION_REQUIRED'
          ? state.state
          : ('UNKNOWN' as const),
      bogon: state.pair?.bogonNode ?? null,
      mitigation: state.pair?.mitigationNode ?? null,
      rt: state.pair ? P.rt : null,
    };
  };
  const create = () => {
    commands = new MitigationCommandService({
      repository,
      hosts: { getHost: async () => host },
      live,
      executor: new MockMitigationExecutor(),
      scopeLock: new InMemoryPolicyScopeLock(),
      expectedNodes: async () => [10, 1000],
      now: () => new Date(now),
      autoExecutionEnabled: () => config.executionEnabled,
      autoEvidence: async (_id, e) => {
        const physical = await ssh.readMitigationConfiguration();
        const bgpConfiguration =
          `bgp 64500\n ipv4-family unicast\n  peer 10.200.201.2 route-policy ${P.policy} import` +
          (ssh.sharedBinding ? `\n  peer 192.0.2.2 route-policy ${P.policy} import` : '');
        return (
          singlePilotPhysicalScopeMatches({ ...physical, bgpConfiguration }) &&
          pilotEvidenceValid(
            await source.sampleWithId({
              profileId: P.profileId,
              deviceId: P.deviceId,
              interfaceId: P.interfaceId,
              bandwidthBps: P.bandwidthBps,
            }),
            e,
            now,
          )
        );
      },
      requireAutomaticAuthorization: true,
      autoWriteAuthorization: (i, pair) => lifecycle.authorize(i, pair),
      afterAutomaticCommand: (i, result, real) => lifecycle.completeActivation(i, result, real),
      manualCommands: {
        begin: (i, s) => lifecycle.beginManual(i, s.deviceId, s.policyName),
        authorize: (i) => lifecycle.authorizeManual(i),
        complete: (i, result, real) => lifecycle.completeManual(i, result, real),
      },
      onScopeRemoved: (s) => lifecycle.forgetProfiles(s.profileIds),
    });
    lifecycle = new AutoMitigationLifecycle({
      store,
      config: () => config,
      pilotTraffic: source,
      target: async (id) =>
        id === P.profileId
          ? { ...target, runtimeState: (await repository.getRuntime(id))?.state ?? null }
          : null,
      execute: (i) => commands.execute(i),
      physical,
      now: () => now,
    });
  };
  create();
  await lifecycle!.reconcile();
  return {
    repository,
    config,
    target,
    ssh,
    source,
    store,
    host,
    iface,
    get lifecycle() {
      return lifecycle!;
    },
    get commands() {
      return commands!;
    },
    physical,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    snapshot: () => snapshot,
    scope: () => store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(target))),
    restart: async () => {
      create();
      await lifecycle!.reconcile();
    },
    sample: (bps: bigint, gap = 10000) => {
      const previous = snapshot.current!;
      now += gap;
      reading = {
        ...reading,
        collectedAt: new Date(now),
        requestStartedAt: new Date(now - 1),
        outOctets: reading.outOctets + (bps * BigInt(gap)) / 8000n,
        inOctets: reading.inOctets + (100_000_000n * BigInt(gap)) / 8000n,
        uptimeTicks: reading.uptimeTicks + BigInt(gap / 10),
      };
      snapshot = {
        ...snapshot,
        previous,
        current: deriveFastTraffic(wireTarget, reading, previous, 'test-generation'),
      };
    },
  };
}
