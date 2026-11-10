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
} from '../worker/mitigation/single-pilot-trigger';
import { autoExpansionPhysicalScopeMatches } from '../worker/mitigation/auto-expansion-scope';
import { MemoryAutomationStore } from '../worker/mitigation/automation-store';
import { InMemoryMitigationRepository } from '../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { MitigationCommandService } from '../infrastructure/bgp/mitigation/mitigation-command-service';
import { HuaweiMitigationExecutor } from '../infrastructure/bgp/mitigation/huawei-mitigation-executor';
import { MockMitigationExecutor } from '../infrastructure/bgp/mitigation/mitigation-executor';
import { AutomationMitigationBaselineStore } from '../worker/mitigation/baseline-store';
import {
  InMemoryPolicyScopeLock,
  type PolicyScopeLock,
} from '../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { inspectPolicyMitigation } from '../infrastructure/bgp/mitigation/mitigation-policy-physical';
import { resolveAutoClientBinding } from '../worker/mitigation/auto-client-binding';
import {
  FastBridgeRoutingSource,
  fastBridgeConfig,
  type FastObservationSource,
} from '../worker/mitigation/fast-observation-bridge';
import { PriorityTrafficSource } from '../worker/mitigation/fast-traffic-source';
import { fastPollerConfig } from '../infrastructure/snmp/fast-traffic-poller';
import { deriveFastTraffic } from '../infrastructure/snmp/fast-traffic-rate';
import type {
  FastCounterReading,
  FastTrafficObservation,
  FastTrafficStore,
} from '../infrastructure/snmp/fast-traffic-types';
import { samplingWindowForProfile } from '../worker/mitigation/mitigation-sampling-policy';
import { MitigationAutoEngine } from '../worker/mitigation/mitigation-auto-engine';
import {
  engineLegacyExemptProfileIds,
  physicalEvidenceSource,
  usesExternalPilotRuntime,
} from '../worker/mitigation/auto-all-wiring';
import { PilotFakeHuawei } from './single-pilot-harness';

/** Latency injected at the SSH boundary, on the same virtual clock as the whole scenario. */
class SlowFakeHuawei extends PilotFakeHuawei {
  calls = 0;
  ops: string[] = [];
  /** Emulates HuaweiBgpSshService.withActivationReadScope: one paid snapshot, then free reads until the first write. */
  scope: { paid: boolean; closed: boolean } | null = null;
  paidOps: string[] = [];
  private async cost(kind: 'read' | 'write', name = '') {
    const scope = this.scope;
    if (kind === 'write' && scope) scope.closed = true;
    if (kind === 'read' && scope && !scope.closed) {
      if (scope.paid) return;
      scope.paid = true;
    }
    this.paidOps.push(`${kind}:${name}`);
    await this.delay();
  }
  constructor(private readonly delay: () => Promise<void>) {
    super();
  }
  mark(name: string) {
    this.ops.push(name);
  }
  /** routes.ts evidence closure reads the BGP configuration (one more equipment read). */
  async readBgp(bgpConfiguration: string) {
    this.calls += 1;
    this.ops.push('readBgpConfiguration');
    await this.cost('read', 'readBgpConfiguration');
    return { bgpConfiguration };
  }
  override async readMitigationConfiguration() {
    this.calls += 1;
    this.ops.push('readMitigationConfiguration');
    await this.cost('read', 'readMitigationConfiguration');
    return super.readMitigationConfiguration();
  }
  override async readMitigationRoutePolicy() {
    this.calls += 1;
    this.ops.push('readMitigationRoutePolicy');
    await this.cost('read', 'readMitigationRoutePolicy');
    return super.readMitigationRoutePolicy();
  }
  override async applyMitigationCommands(host: HostRecord, commands: readonly string[]) {
    this.calls += 1;
    this.ops.push('applyMitigationCommands');
    await this.cost('write', 'apply');
    return super.applyMitigationCommands(host, commands);
  }
}

class MemoryFastStore implements FastTrafficStore {
  private readonly rows = new Map<string, FastTrafficObservation>();
  async append(o: FastTrafficObservation) {
    const latest = this.rows.get(o.interfaceId);
    if (latest && latest.collectedAt >= o.collectedAt) return false;
    this.rows.set(o.interfaceId, o);
    return true;
  }
  async latest(interfaceId: string) {
    return this.rows.get(interfaceId) ?? null;
  }
}

export const OTHER = Object.freeze({
  profileId: 'profile-other-auto',
  interfaceId: 'if-other-auto',
  ifIndex: 300,
  interfaceName: 'Eth-Trunk1.4000',
  policy: 'PL-OTHER_IPv4-IN',
  customer: 'OTHER-IPV4',
  peer: '10.200.202.2',
});
export const LEGACY_EXEMPT = Object.freeze({
  profileId: 'profile-legacy-exempt',
  interfaceId: 'if-legacy-auto',
  ifIndex: 301,
  interfaceName: 'Eth-Trunk1.4001',
  policy: 'PL-LEGACY_IPv4-IN',
  customer: 'LEGACY-IPV4',
  peer: '10.200.203.2',
});

export interface AutoAllHarnessOptions {
  executionEnabled?: boolean;
  /** ms of virtual time consumed by EACH SSH operation (read/write). */
  sshLatencyMs?: number;
  allowlist?: string[];
  cadenceMs?: number;
  /** Wire the activation read scope (option B). Default: true, as in routes.ts. */
  useReadScope?: boolean;
  /** ms between the FAST sample and the engine tick that evaluates it (0..cadence). */
  decisionDelayMs?: number;
  /** M1-AUTO: ACTIVATE outside the tick, as wired in routes.ts. Default false (synchronous). */
  asyncExecution?: boolean;
  /** Policy lock factory (default: in-memory FIFO). Tests of busy semantics inject a try-lock. */
  scopeLock?: () => PolicyScopeLock;
}

/**
 * AUTO-ALL with the SAME wiring rules as routes.ts (auto-all-wiring.ts): embedded FAST telemetry,
 * the canonical engine as the only decision path, lifecycle.activate as the only physical gate.
 * The external bridge and the legacy InterfaceMetricSample stream are booby-trapped: any use throws.
 */
export async function createAutoAllHarness(options: AutoAllHarnessOptions = {}) {
  let now = Date.parse('2026-11-08T12:00:00Z');
  const executionEnabled = options.executionEnabled ?? true;
  const cadence = options.cadenceMs ?? 5000;
  const store = new MemoryAutomationStore();
  const repository = new InMemoryMitigationRepository();
  const used = { bridge: 0, legacy: 0 };

  const defs = [
    {
      id: P.profileId,
      ifId: P.interfaceId,
      ifIndex: P.ifIndex,
      ifName: P.interfaceName,
      policy: P.policy,
      customer: P.customer,
      peer: '10.200.201.2',
      alias: 'AGLINK-IPV4_10GB',
    },
    {
      id: OTHER.profileId,
      ifId: OTHER.interfaceId,
      ifIndex: OTHER.ifIndex,
      ifName: OTHER.interfaceName,
      policy: OTHER.policy,
      customer: OTHER.customer,
      peer: OTHER.peer,
      alias: 'OTHER-IPV4_10GB',
    },
    {
      id: LEGACY_EXEMPT.profileId,
      ifId: LEGACY_EXEMPT.interfaceId,
      ifIndex: LEGACY_EXEMPT.ifIndex,
      ifName: LEGACY_EXEMPT.interfaceName,
      policy: LEGACY_EXEMPT.policy,
      customer: LEGACY_EXEMPT.customer,
      peer: LEGACY_EXEMPT.peer,
      alias: 'LEGACY-IPV4_10GB',
    },
  ];
  for (const d of defs) {
    const profile = await repository.upsertProfile({
      deviceId: P.deviceId,
      interfaceId: d.ifId,
      policyName: d.policy,
      addressFamily: 'IPV4',
      mode: 'AUTO',
      detectedBandwidthBps: P.bandwidthBps,
      bandwidthSource: 'DESCRIPTION',
    });
    repository.storeRef.profiles.delete(profile.id);
    profile.id = d.id;
    repository.storeRef.profiles.set(profile.id, profile);
    await repository.replaceProfilePeers(profile.id, [
      { peerAddress: d.peer, addressFamily: 'IPV4', primary: true },
    ]);
    await repository.upsertRuntime(profile.id, {
      state: 'NORMAL',
      plannedNode: 2,
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
    });
  }
  const host = {
    id: P.deviceId,
    hostname: P.hostname,
    displayName: P.hostname,
    interfaces: defs.map((d) => ({
      id: d.ifId,
      name: d.ifName,
      ifIndex: d.ifIndex,
      description: d.ifName,
      alias: d.alias,
      adminStatus: 'UP',
      operStatus: 'UP',
    })),
    sshEnabled: true,
    ssh: { host: '192.0.2.254', port: 22, username: 'synthetic' },
  } as unknown as HostRecord;

  const allowlist = options.allowlist ?? [P.profileId];
  const env = {
    MITIGATION_FAST_POLL_MODE: 'ENFORCE',
    MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED: '1',
    MITIGATION_FAST_NORMAL_SECONDS: String(cadence / 1000),
    MITIGATION_FAST_SINGLE_OWNER: '1',
  };
  const fastConfig = fastPollerConfig(env);
  const bridgeCfg = fastBridgeConfig({ MITIGATION_FAST_BRIDGE_MODE: 'OFF' });
  const lcConfig = {
    ...lifecycleConfig({ ...env, MITIGATION_AUTO_EXPANSION_ENABLED: '1' }),
    installation: 'IMPLANTAR',
    enabled: true,
    expansionEnabled: true,
    executionEnabled,
    profiles: allowlist,
    devices: [P.deviceId],
    cooldownMs: 60_000,
  };
  const wiring = { autoAllEnforce: fastConfig.autoAllEnforce === true, lifecycleEnabled: true };

  const makeTarget = (d: (typeof defs)[number]): LifecycleTarget => ({
    profileId: d.id,
    deviceId: P.deviceId,
    interfaceId: d.ifId,
    policyName: d.policy,
    customer: d.customer,
    addressFamily: 'IPV4',
    direction: 'tx',
    directionSource: 'INTERFACE',
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
    peerAddresses: [d.peer],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
    rt: P.rt,
    scopeMembers: 1,
    // routes.ts: embedded AUTO-ALL profiles are FAST-routed without any bridge profile list.
    fast: true,
    otherFamilyAuto: false,
    clientBinding: resolveAutoClientBinding(
      {
        profileId: d.id,
        deviceId: P.deviceId,
        interfaceId: d.ifId,
        customer: d.customer,
        direction: 'tx',
        detectedBandwidthBps: P.bandwidthBps,
        bandwidthOverrideBps: null,
      },
      host,
    ),
  });
  const targets = new Map<string, LifecycleTarget>(defs.map((d) => [d.id, makeTarget(d)]));

  // ---- embedded FAST telemetry: real rate derivation, in-memory store -----------------------
  const fastStore = new MemoryFastStore();
  const readings = new Map<string, FastCounterReading>();
  const previous = new Map<string, FastTrafficObservation>();
  const feedOne = async (d: (typeof defs)[number], bps: bigint, gap: number) => {
    const before = readings.get(d.ifId);
    const reading: FastCounterReading = before
      ? {
          ...before,
          collectedAt: new Date(now),
          requestStartedAt: new Date(now - 1),
          outOctets: before.outOctets + (bps * BigInt(gap)) / 8000n,
          inOctets: before.inOctets + (100_000_000n * BigInt(gap)) / 8000n,
          uptimeTicks: before.uptimeTicks + BigInt(gap / 10),
        }
      : {
          deviceId: P.deviceId,
          interfaceId: d.ifId,
          ifIndex: d.ifIndex,
          interfaceName: d.ifName,
          speedBps: 300_000_000_000n,
          requestStartedAt: new Date(now - 1),
          collectedAt: new Date(now),
          inOctets: 0n,
          outOctets: 0n,
          uptimeTicks: 100000n,
          discontinuityTicks: 0n,
          lastChangeTicks: 0n,
          adminStatus: 1,
          operStatus: 1,
        };
    readings.set(d.ifId, reading);
    const observation = deriveFastTraffic(
      { ...reading, profiles: [] },
      reading,
      previous.get(d.ifId),
      'auto-all-generation',
    );
    previous.set(d.ifId, observation);
    await fastStore.append(observation);
  };

  const priority = new PriorityTrafficSource({
    config: fastConfig,
    store: fastStore,
    legacy: {
      sample: async () => {
        used.legacy += 1;
        throw Error('LEGACY_STREAM_FORBIDDEN');
      },
      sampleWithId: async () => {
        used.legacy += 1;
        throw Error('LEGACY_STREAM_FORBIDDEN');
      },
    },
    direction: () => 'tx',
    available: () => true,
    now: () => new Date(now),
  });
  const bridgeTrap = {
    sampleWithId: async () => {
      used.bridge += 1;
      throw Error('EXTERNAL_BRIDGE_FORBIDDEN');
    },
    sample: async () => {
      used.bridge += 1;
      throw Error('EXTERNAL_BRIDGE_FORBIDDEN');
    },
  } as unknown as FastObservationSource;
  const effectiveTraffic = new FastBridgeRoutingSource(bridgeCfg, bridgeTrap, priority);
  const evidenceSource =
    physicalEvidenceSource(wiring) === 'EXTERNAL_BRIDGE' ? bridgeTrap : effectiveTraffic;

  // The FAST poller keeps collecting while the engine waits on the equipment: time never
  // passes without the embedded collector producing its next samples.
  let currentBps: Record<string, bigint> = {};
  let lastFeedAt = now;
  const feedAll = async () => {
    for (const d of defs) await feedOne(d, currentBps[d.id] ?? 100_000_000n, cadence);
    lastFeedAt = now;
  };
  const advanceTime = async (ms: number) => {
    const target = now + ms;
    while (lastFeedAt + cadence <= target) {
      now = lastFeedAt + cadence;
      await feedAll();
    }
    now = target;
  };

  // ---- physical boundary (fake only at SSH) ---------------------------------------------------
  const ssh = new SlowFakeHuawei(() => advanceTime(options.sshLatencyMs ?? 0));
  const live = new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [P.deviceId] },
    // Same durable store as production (routes.ts): ownership lives beside scope/journal.
    baseline: new AutomationMitigationBaselineStore(store),
    // Verificacao fisica pos-escrita sem esperas reais (o relogio do cenario e virtual).
    physical: {
      timing: { maxAttempts: 3, intervalMs: 1, budgetMs: 1_000 },
      sleep: async () => undefined,
    },
  });
  const physical = async (t: Pick<LifecycleTarget, 'policyName' | 'rt'>) => {
    const state = inspectPolicyMitigation({
      policyName: t.policyName!,
      readBack: await live.readRoutePolicy(host, t.policyName!),
      rts: [t.rt],
    });
    return {
      state:
        state.recognized && state.state !== 'RECONCILIATION_REQUIRED'
          ? state.state
          : ('UNKNOWN' as const),
      bogon: state.pair?.bogonNode ?? null,
      mitigation: state.pair?.mitigationNode ?? null,
      rt: state.pair ? t.rt : null,
    };
  };

  const scopeCalls: string[] = [];
  let lifecycle: AutoMitigationLifecycle;
  let commands: MitigationCommandService;
  let engine: MitigationAutoEngine;
  const lifecycleTarget = async (id: string): Promise<LifecycleTarget | null> => {
    const t = targets.get(id);
    return t ? { ...t, runtimeState: (await repository.getRuntime(id))?.state ?? null } : null;
  };
  const create = () => {
    const scopeLock = options.scopeLock?.() ?? new InMemoryPolicyScopeLock();
    commands = new MitigationCommandService({
      repository,
      hosts: { getHost: async () => host },
      live,
      executor: new MockMitigationExecutor(),
      scopeLock,
      expectedNodes: async () => [10, 1000],
      now: () => new Date(now),
      autoExecutionEnabled: () => lcConfig.executionEnabled,
      // Same checks as the routes.ts evidence closure (expansion scope + FAST evidence).
      autoEvidence: async (id, e) => {
        const t = targets.get(id);
        if (!t) return false;
        ssh.mark('--evidence-closure-start--');
        // routes.ts order: BGP configuration first, then the mitigation configuration.
        const { bgpConfiguration } = await ssh.readBgp(
          `bgp 64500\n ipv4-family unicast\n  peer ${t.peerAddresses[0]} route-policy ${t.policyName} import`,
        );
        const physicalConfig = await ssh.readMitigationConfiguration();
        if (
          !autoExpansionPhysicalScopeMatches(
            { ...physicalConfig, bgpConfiguration },
            t.policyName!,
            [...t.peerAddresses],
          )
        )
          return false;
        ssh.mark('--evidence-final-sample--');
        const sample = await evidenceSource.sampleWithId({
          profileId: id,
          deviceId: t.deviceId,
          interfaceId: t.interfaceId,
          bandwidthBps: P.bandwidthBps,
        });
        return pilotEvidenceValid(
          sample,
          e,
          now,
          (P.bandwidthBps * BigInt(t.triggerPercent)) / 100n,
          { maxAgeMs: lcConfig.maxAgeMs, maxGapMs: lcConfig.maxGapMs },
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
      onScopeRemoved: (s) => {
        lifecycle.forgetProfiles(s.profileIds);
        engine.forgetProfiles(s.profileIds);
      },
    });
    lifecycle = new AutoMitigationLifecycle({
      scopeLock,
      readPolicy: async () => ssh.readMitigationRoutePolicy(),
      store,
      config: () => lcConfig,
      // AUTO-ALL: NO pilotTraffic (the external pilot runtime is not used).
      target: lifecycleTarget,
      execute: (i) => commands.execute(i),
      closeReadScope: () => {
        if (ssh.scope) ssh.scope.closed = true;
      },
      readScope: async (t, run) => {
        scopeCalls.push(t.profileId);
        if (options.useReadScope === false) return run();
        ssh.scope = { paid: false, closed: false };
        try {
          return await run();
        } finally {
          ssh.scope = null;
        }
      },
      physical: (t) => {
        ssh.mark('--lifecycle.physical--');
        return physical(t);
      },
      now: () => now,
    });
    engine = new MitigationAutoEngine({
      sampling: (t) =>
        samplingWindowForProfile(t.profileId, {
          legacyMaxAgeMs: 600_000,
          bridge: bridgeCfg,
          embedded: fastConfig,
        }),
      evaluationScope: 'OPERATIONAL',
      requireRuntimeRead: true,
      evaluationConcurrency: 2,
      ...(options.asyncExecution
        ? { asyncExecution: true, maxConcurrentExecutions: lcConfig.maxActive }
        : {}),
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [P.deviceId] },
      targets: {
        list: async () => Promise.all(defs.map((d) => lifecycleTarget(d.id).then((t) => t!))),
      },
      traffic: effectiveTraffic,
      exclusions: { listPeerExclusions: async () => [] },
      runtime: {
        get: (id) => repository.getRuntime(id),
        save: async (id, patch) => {
          await repository.upsertRuntime(id, patch);
        },
      },
      commands: {
        execute: async (input) => {
          const result = await lifecycle.activate(input);
          if (['AUTO_COOLDOWN_ACTIVE', 'AUTO_NEW_EPISODE_REQUIRED'].includes(result.status))
            engine.forgetProfiles([input.profileId]);
          return result;
        },
      },
      executionControl: {
        enabled: lcConfig.executionEnabled,
        allowedProfileIds: allowlist,
        // The routes.ts value: configured legacy exemption, nullified under AUTO-ALL.
        legacyExemptProfileIds: engineLegacyExemptProfileIds(wiring, [LEGACY_EXEMPT.profileId]),
      },
      now: () => new Date(now),
    });
  };
  create();
  await lifecycle!.reconcile();

  return {
    repository,
    store,
    ssh,
    host,
    used,
    wiring,
    fastConfig,
    lcConfig,
    get lifecycle() {
      return lifecycle!;
    },
    get commands() {
      return commands!;
    },
    get engine() {
      return engine!;
    },
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      lastFeedAt = Math.min(lastFeedAt, now);
    },
    scope: (id: string = P.profileId) =>
      store.transaction((tx) => tx.get<ScopeOwnership>(scopeKey(targets.get(id)!))),
    physical,
    restart: async () => {
      create();
      await lifecycle!.reconcile();
    },
    /** One FAST cycle: new samples for the given interfaces at `now` (all others stay quiet). */
    feed: async (bpsByProfile: Record<string, bigint>) => {
      currentBps = bpsByProfile;
      await feedAll();
    },
    /** FAST cadence step then ONE engine tick, exactly like the runtime timer would do. */
    cycle: async (bpsByProfile: Record<string, bigint>) => {
      currentBps = bpsByProfile;
      now = Math.max(now, lastFeedAt + cadence);
      await feedAll();
      await advanceTime(options.decisionDelayMs ?? 0);
      return engine!.tick();
    },
    scopeCalls,
    sshOps: () => ssh.calls,
    sshOpLog: () => [...ssh.ops],
    paidOps: () => [...ssh.paidOps],
    usesExternalPilotRuntime: usesExternalPilotRuntime(wiring),
  };
}
