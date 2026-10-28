/** Isolated harness. All transport and executors below are synthetic; no credentials or sockets. */
import type { HostRecord, NetworkInterface } from '@gmj/shared';
import { InMemoryMitigationRepository } from '../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import type {
  MitigationProfileRecord,
  MitigationRepository,
} from '../infrastructure/bgp/mitigation/mitigation-repository';
import { MitigationCommandService } from '../infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from '../infrastructure/bgp/mitigation/mitigation-executor';
import {
  InMemoryPolicyScopeLock,
  type PolicyScopeLock,
} from '../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { FastSnmpReader, FAST_OIDS } from '../infrastructure/snmp/fast-snmp-reader';
import { FastTrafficPoller, fastPollerConfig } from '../infrastructure/snmp/fast-traffic-poller';
import { listFastTrafficTargets } from '../infrastructure/snmp/fast-traffic-targets';
import type {
  FastTrafficObservation,
  FastTrafficStore,
} from '../infrastructure/snmp/fast-traffic-types';
import { PriorityTrafficSource } from '../worker/mitigation/fast-traffic-source';
import {
  FastObservationSource,
  type FastBridgeReader,
  type FastBridgeProfile,
} from '../worker/mitigation/fast-observation-bridge';
import type { MitigationTrafficSource } from '../worker/mitigation/mitigation-traffic-source';
import {
  MitigationAutoEngine,
  type MitigationAutoDecision,
  type MitigationAutoTargetState,
} from '../worker/mitigation/mitigation-auto-engine';
import { MitigationAutoRuntime } from '../worker/mitigation/mitigation-auto-runtime';
import { legacySamplingWindow } from '../worker/mitigation/mitigation-sampling-policy';
import type { SnmpVarBind } from '../domain/ports';
import { SnmpPoller } from '../infrastructure/snmp/snmp-poller';
import { SnmpClientImpl } from '../infrastructure/snmp/snmp-client-impl';
import type { SnmpService } from '../infrastructure/snmp/snmp-service';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fastResponseScenario(options: {
  protectedProfiles?: number;
  startAt: number;
  attackAt: number;
  attackEndsAt?: number;
  preflightMs?: number;
  executionMs?: number;
  readbackMs?: number;
  preflightFails?: boolean;
  readbackFails?: boolean;
  unavailableHost?: number;
  intermittent?: boolean;
  downAt?: number;
  frozenAt?: number;
  databaseDelayMs?: number;
  wirePort?: number;
  externalBridge?: boolean;
  bridgeReader?: FastBridgeReader;
  observationStore?: FastTrafficStore;
  repository?: MitigationRepository;
  scopeLock?: PolicyScopeLock;
  /** Kill switch da execucao automatica (default: ligado, como o cenario de escrita). */
  autoExecutionEnabled?: boolean;
  beforeProfiles?: (hosts: HostRecord[], interfaces: NetworkInterface[]) => Promise<void>;
  /** Janela da fonte roteada para o motor (default: contrato LEGACY de 600 s). */
  sampling?: (target: MitigationAutoTargetState) => { maxAgeMs: number; maxGapMs: number | null };
  /** Escopo do motor: operacional (default) ou hipotético. */
  evaluationScope?: 'OPERATIONAL' | 'SHADOW';
  requireRuntimeRead?: boolean | ((target: MitigationAutoTargetState) => boolean);
}) {
  const repository = options.repository ?? new InMemoryMitigationRepository();
  const hardware = new MockMitigationExecutor();
  const interfaces = Array.from(
    { length: 2379 },
    (_, i) =>
      ({
        id: `synthetic-if-${i}`,
        deviceId: `synthetic-device-${i % 18}`,
        ifIndex: i + 1,
        name: `Eth-Trunk1.${i + 1}`,
        adminStatus: 'UP',
        operStatus: 'UP',
        speedBps: 300_000_000_000,
      }) as NetworkInterface,
  );
  const hosts = Array.from(
    { length: 18 },
    (_, i) =>
      ({
        id: `synthetic-device-${i}`,
        name: `synthetic-${i}`,
        hostname: `synthetic-${i}`,
        displayName: `synthetic-${i}`,
        interfaces: interfaces.filter((n) => n.deviceId === `synthetic-device-${i}`),
        snmpEnabled: true,
        sshEnabled: true,
        snmp: {
          version: 'SNMP_V2C',
          host: `synthetic-${i}`,
          port: 1161,
          credentialConfigured: true,
        },
      }) as HostRecord,
  );
  const hostPort = {
    getHost: async (id: string) => hosts.find((h) => h.id === id) ?? null,
    getDecryptedSnmpCredentials: async () => ({ community: 'synthetic-only' }),
  };
  if (options.wirePort)
    for (const h of hosts) {
      h.snmp!.host = '127.0.0.1';
      h.snmp!.port = options.wirePort;
    }
  const profiles: MitigationProfileRecord[] = [];
  await options.beforeProfiles?.(hosts, interfaces);
  for (let i = 0; i < (options.protectedProfiles ?? 1); i++) {
    const profile = await repository.upsertProfile({
      deviceId: hosts[i]!.id,
      interfaceId: interfaces[i]!.id,
      policyName: `SYNTHETIC-BHNET-${i}`,
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      mode: 'AUTO',
      triggerSamples: 3,
    });
    await repository.setProfileAutoTrafficDirection(profile.id, 'TX');
    await repository.upsertRuntime(profile.id, {
      state: 'NORMAL',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
    });
    profiles.push(profile);
    hardware.seedPolicy(profile.policyName, [10, 100]);
  }
  // Unconfigured and IPv6 targets must never enter the fast collector's scope.
  for (let i = 0; i < 32; i++)
    await repository.upsertProfile({
      deviceId: hosts[i % 18]!.id,
      interfaceId: interfaces[i]!.id,
      policyName: `UNCONFIGURED-${i}`,
      addressFamily: 'IPV4',
      mode: 'ALERT_ONLY',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
  const selectedIds = profiles.map((p) => p.id);
  const config = { ...fastPollerConfig({}), mode: 'ENFORCE' as const, profileIds: selectedIds };
  const observations: FastTrafficObservation[] = [];
  const memoryStore: FastTrafficStore = {
    append: async (o) => {
      if (options.databaseDelayMs) await sleep(options.databaseDelayMs);
      const prior = observations.filter((p) => p.interfaceId === o.interfaceId).at(-1);
      if (prior && prior.collectedAt >= o.collectedAt) return false;
      observations.push(o);
      return true;
    },
    latest: async (id) => observations.filter((o) => o.interfaceId === id).at(-1) ?? null,
  };
  const store: FastTrafficStore = options.observationStore
    ? {
        append: async (o) => {
          const accepted = await options.observationStore!.append(o);
          if (accepted) observations.push(o);
          return accepted;
        },
        latest: (id) => options.observationStore!.latest(id),
      }
    : memoryStore;
  const calls = new Map<string, number>();
  const counts: number[] = [];
  const reader = new FastSnmpReader(
    hostPort,
    options.wirePort
      ? new SnmpClientImpl(1000, 0)
      : {
          walk: async () => {
            throw new Error('NO_WALK_ALLOWED');
          },
          get: async (host, oids): Promise<SnmpVarBind[]> => {
            const n = Number(host.split('-').at(-1));
            calls.set(host, (calls.get(host) ?? 0) + 1);
            counts.push(oids.length);
            await sleep(n === 2 ? 900 : 150 + n * 25);
            if (
              options.unavailableHost === n ||
              (options.intermittent && calls.get(host)! % 4 === 0)
            )
              throw new Error('Synthetic SNMP timeout');
            const time = Math.min(Date.now(), options.frozenAt ?? Infinity);
            const end = Math.min(time, options.attackEndsAt ?? Infinity);
            const highMs = Math.max(0, end - options.attackAt);
            const normalMs = time - options.startAt - highMs;
            const out =
              1_000_000_000_000n + BigInt(normalMs) * 125000n + BigInt(highMs) * 19_500_000n;
            return oids.map((oid) => {
              const root = oid.slice(0, oid.lastIndexOf('.'));
              const index = Number(oid.split('.').at(-1));
              let value: string | number = '0';
              if (oid === FAST_OIDS.uptime)
                value = String(100000 + Math.floor((Date.now() - options.startAt) / 10));
              else if (root === FAST_OIDS.name)
                value = interfaces.find((i) => i.ifIndex === index)!.name;
              else if (root === FAST_OIDS.in) value = '1000000000000';
              else if (root === FAST_OIDS.out) value = String(out);
              else if (root === FAST_OIDS.highSpeed) value = '300000';
              else if (root === FAST_OIDS.admin || root === FAST_OIDS.oper)
                value = Date.now() >= (options.downAt ?? Infinity) ? '2' : '1';
              return { oid, value };
            });
          },
        },
  );
  const poller = new FastTrafficPoller({
    config,
    reader,
    store,
    listTargets: () =>
      listFastTrafficTargets({
        profileIds: selectedIds,
        allowedDeviceIds: hosts.map((h) => h.id),
        listProfiles: () => repository.listProfiles(),
        hosts: hostPort,
        direction: (p) => (p.autoTrafficDirection === 'TX' ? 'tx' : null),
      }),
  });
  const priorityTraffic = new PriorityTrafficSource({
    config,
    store,
    available: (id) => poller.isAvailable(id),
    direction: () => 'tx',
    legacy: {
      sample: async () => {
        throw new Error('NO_LEGACY_FALLBACK');
      },
      sampleWithId: async () => {
        throw new Error('NO_LEGACY_FALLBACK');
      },
    },
  });
  const bridgeProfiles = new Map<string, FastBridgeProfile>(
    profiles.map((p) => [
      p.id,
      {
        profileId: p.id,
        deviceId: p.deviceId,
        interfaceId: p.interfaceId,
        direction: 'tx',
        revision: 'isolated-configuration',
      },
    ]),
  );
  const bridgeTraffic = new FastObservationSource({
    config: {
      mode: 'ENFORCE',
      profileIds: selectedIds,
      enforceProfileIds: selectedIds,
      maxAgeMs: 30000,
      maxGapMs: 45000,
    },
    profile: (id) => bridgeProfiles.get(id) ?? null,
    reader: options.bridgeReader ?? {
      snapshot: async (id) => {
        const i = interfaces.find((i) => i.id === id)!;
        const rows = observations.filter((o) => o.interfaceId === id);
        return {
          mapping: {
            id,
            deviceId: i.deviceId,
            ifIndex: i.ifIndex,
            name: i.name,
            adminStatus: i.adminStatus,
            operStatus: i.operStatus,
            speedBps: BigInt(i.speedBps!),
          },
          current: rows.at(-1) ?? null,
          previous: rows.at(-2) ?? null,
          collectorAvailable: poller.isAvailable(id),
        };
      },
    },
  });
  const traffic: MitigationTrafficSource = options.externalBridge ? bridgeTraffic : priorityTraffic;
  const commandResults: Array<{ at: number; profileId: string; timings: unknown }> = [];
  const commands = new MitigationCommandService({
    repository,
    hosts: hostPort,
    executor: hardware,
    scopeLock: options.scopeLock ?? new InMemoryPolicyScopeLock(),
    autoExecutionEnabled: () => options.autoExecutionEnabled ?? true,
    expectedNodes: async () => [10, 100],
    autoEvidence: async (id, evidence) => {
      const p = profiles.find((p) => p.id === id)!;
      const sample = await traffic.sampleWithId({
        profileId: id,
        deviceId: p.deviceId,
        interfaceId: p.interfaceId,
        bandwidthBps: p.detectedBandwidthBps,
      });
      return (
        sample !== null &&
        sample.continuityKey === evidence?.continuityKey &&
        sample.bps >= 9_000_000_000n
      );
    },
    live: {
      enabledFor: () => true,
      resolveActivePair: async () => null,
      preflight: async (_host, input) => {
        await sleep(options.preflightMs ?? 3000);
        return {
          ok: !options.preflightFails,
          blockedReasons: options.preflightFails ? ['Synthetic preflight failed'] : [],
          mode: input.mode,
          existingNodes: [10, 100],
        } as never;
      },
      activate: async (_host, input) => {
        await sleep(options.executionMs ?? 4000);
        return hardware.activate(input);
      },
      remove: async () => {
        throw new Error('NO_AUTOMATIC_REMOVE');
      },
      readRoutePolicy: async (_host, policy) => {
        await sleep(options.readbackMs ?? 2000);
        return options.readbackFails ? 'invalid readback' : hardware.readRoutePolicy(policy);
      },
    },
  });
  const decisions: MitigationAutoDecision[] = [];
  const engine = new MitigationAutoEngine({
    globalMode: 'AUTO',
    evaluationConcurrency: 2,
    evaluationScope: options.evaluationScope ?? 'OPERATIONAL',
    executionControl: { enabled: options.autoExecutionEnabled ?? true },
    // Sem fallback no motor: o harness declara a janela da fonte explicitamente.
    sampling: options.sampling ?? legacySamplingWindow(600_000),
    ...(options.requireRuntimeRead !== undefined
      ? { requireRuntimeRead: options.requireRuntimeRead }
      : {}),
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: hosts.map((h) => h.id) },
    targets: {
      list: async () =>
        Promise.all(
          profiles.map(
            async (p) =>
              ({
                profileId: p.id,
                deviceId: p.deviceId,
                interfaceId: p.interfaceId,
                policyName: p.policyName,
                customer: 'Synthetic BHNET',
                mode: p.mode,
                direction: 'tx',
                addressFamily: 'IPV4',
                autoPromotedBySweep: false,
                snapshotAvailable: true,
                readiness: 'READY',
                prefixStatus: 'SAFE',
                blockedReason: null,
                mitigationExcluded: false,
                runtimeState: (await repository.getRuntime(p.id))?.state ?? 'NORMAL',
                effectiveBandwidthBps: p.detectedBandwidthBps,
                bogonNode: 1,
                mitigationNode: 2,
                sharedPolicy: false,
                peerAddresses: [],
                triggerPercent: 90,
                recoveryPercent: 70,
                triggerSamples: 3,
                recoverySamples: 12,
              }) satisfies MitigationAutoTargetState,
          ),
        ),
    },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: (id) => repository.getRuntime(id),
      save: async (id, p) => {
        await repository.upsertRuntime(id, p);
      },
    },
    commands: {
      execute: async (input) => {
        const r = await commands.execute({ ...input, origin: 'AUTO' });
        commandResults.push({ at: Date.now(), profileId: input.profileId, timings: r.timingsMs });
        return r;
      },
    },
    debugLogger: (_, meta) => {
      if (meta?.profileId) decisions.push(meta as unknown as MitigationAutoDecision);
    },
  });
  const runtime = new MitigationAutoRuntime({ engine, intervalMs: 5000 });
  // Actual conventional scheduler is deliberately stalled on slow synthetic hosts.
  let conventionalCalls = 0;
  const general = new SnmpPoller(
    { listHosts: async () => hosts } as never,
    {
      pollHost: async () => {
        conventionalCalls++;
        await sleep(30000);
      },
    } as unknown as SnmpService,
    60000,
  );

  return {
    poller,
    runtime,
    engine,
    repository,
    hardware,
    observations,
    bridgeTraffic,
    decisions,
    commandResults,
    calls,
    counts,
    hosts,
    interfaces,
    profiles,
    general,
    conventionalCalls: () => conventionalCalls,
    start: () => {
      general.start();
      poller.start();
      runtime.start();
    },
    stop: async () => {
      runtime.stop();
      general.stop();
      await poller.stop();
    },
  };
}
