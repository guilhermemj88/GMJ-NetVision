/** Development-only deterministic lab. No sockets, operational credentials or real Huawei. */
import { createPilotHarness } from './single-pilot-harness';
import { MemoryAutomationStore } from '../worker/mitigation/automation-store';
import { FastTrafficPoller, fastPollerConfig } from '../infrastructure/snmp/fast-traffic-poller';
import { FastObservationSource } from '../worker/mitigation/fast-observation-bridge';
import type {
  FastTrafficObservation,
  FastTrafficStore,
  FastTrafficTarget,
} from '../infrastructure/snmp/fast-traffic-types';
import type { MitigationAutoDecision } from '../worker/mitigation/mitigation-auto-engine';
import type {
  MitigationCommandInput,
  MitigationCommandResult,
} from '../infrastructure/bgp/mitigation/mitigation-command-service';
import { SINGLE_AUTO_PILOT as P } from '../worker/mitigation/single-pilot-trigger';

export const COUNTER64_BASE = 1n << 63n;

/** Integral at the time of the GET, independent of whether previous GETs succeeded. */
export function offeredOctets(
  atMs: number,
  attackAtMs: number | null,
  attackEndsAtMs = Infinity,
): bigint {
  const attackedMs =
    attackAtMs === null ? 0 : Math.max(0, Math.min(atMs, attackEndsAtMs) - attackAtMs);
  return (
    COUNTER64_BASE +
    (3_000_000_000n * BigInt(atMs - attackedMs) + 10_000_000_000n * BigInt(attackedMs)) / 8000n
  );
}

export async function fastLifecycleScenario(options: {
  cadenceSeconds: number;
  seed: number;
  timeoutRate?: number;
  attack?: boolean;
  attackDirection?: 'rx' | 'tx';
  databaseDelayMs?: number;
  executionEnabled?: boolean;
  /** Test-only override exercises an accelerated scheduler if configured; no product flag added. */
  suspectIntervalMs?: number;
  horizonPeriods?: number;
  attackDurationMs?: number;
  observationStore?: FastTrafficStore;
}) {
  let seed = options.seed >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const config = fastPollerConfig({
    MITIGATION_FAST_POLL_MODE: 'OBSERVE',
    MITIGATION_FAST_PROFILE_IDS: P.profileId,
    MITIGATION_FAST_NORMAL_SECONDS: String(options.cadenceSeconds),
  });
  if (options.suspectIntervalMs !== undefined) config.suspectIntervalMs = options.suspectIntervalMs;
  const h = await createPilotHarness(new MemoryAutomationStore(), {
    cadenceSeconds: options.cadenceSeconds,
    traffic: { sampleWithId: (target) => source.sampleWithId(target) },
  });
  h.config.executionEnabled = options.executionEnabled ?? true;
  const startedAt = h.now(),
    attackAt = options.attack === false ? null : Math.round(random() * config.normalIntervalMs);
  const attackEnds =
    attackAt === null ? Infinity : attackAt + (options.attackDurationMs ?? Infinity);
  const observations: FastTrafficObservation[] = [],
    timeouts: number[] = [],
    decisions: MitigationAutoDecision[] = [];
  const commands: Array<{
    input: MitigationCommandInput;
    startedAt: number;
    verifiedAt: number;
    result: MitigationCommandResult;
  }> = [];
  const target: FastTrafficTarget = {
    deviceId: P.deviceId,
    interfaceId: P.interfaceId,
    interfaceName: P.interfaceName,
    ifIndex: P.ifIndex,
    speedBps: 300_000_000_000n,
    profiles: [
      {
        profileId: P.profileId,
        direction: 'tx',
        bandwidthBps: P.bandwidthBps,
        thresholdBps: P.thresholdBps,
      },
    ],
  };
  const command = h.commands.execute.bind(h.commands);
  h.commands.execute = async (input) => {
    const at = h.now();
    const result = await command(input);
    commands.push({ input, startedAt: at, verifiedAt: h.now(), result });
    return result;
  };
  const readConfig = h.ssh.readMitigationConfiguration.bind(h.ssh),
    readPolicy = h.ssh.readMitigationRoutePolicy.bind(h.ssh);
  h.ssh.readMitigationConfiguration = async () => {
    h.advance(15);
    return readConfig();
  };
  h.ssh.readMitigationRoutePolicy = async () => {
    h.advance(10);
    return readPolicy();
  };
  h.ssh.afterWrite = async () => {
    h.advance(100);
  };
  const source: FastObservationSource = new FastObservationSource({
    config: {
      mode: 'SHADOW',
      profileIds: [P.profileId],
      enforceProfileIds: [],
      maxAgeMs: h.config.maxAgeMs,
      maxGapMs: h.config.maxGapMs,
    },
    profile: () => ({
      profileId: P.profileId,
      deviceId: P.deviceId,
      interfaceId: P.interfaceId,
      direction: 'tx',
      revision: 'fixture-config',
    }),
    reader: {
      snapshot: async () => ({
        mapping: {
          id: P.interfaceId,
          deviceId: P.deviceId,
          name: P.interfaceName,
          ifIndex: P.ifIndex,
          speedBps: target.speedBps,
          adminStatus: 'UP',
          operStatus: 'UP',
        },
        current: observations.at(-1) ?? null,
        previous: observations.at(-2) ?? null,
        collectorAvailable: poller.isAvailable(P.interfaceId),
      }),
    },
    now: () => new Date(h.now()),
  });
  const poller: FastTrafficPoller = new FastTrafficPoller({
    config,
    listTargets: async () => [target],
    now: () => new Date(h.now()),
    reader: {
      read: async () => {
        const requestStartedAt = new Date(h.now());
        if (random() < (options.timeoutRate ?? 0)) {
          h.advance(config.timeoutMs);
          timeouts.push(h.now() - startedAt);
          throw Error('synthetic SNMP timeout');
        }
        h.advance(Math.round(20 + random() * 280));
        const elapsed = h.now() - startedAt;
        const attack = offeredOctets(elapsed, attackAt, attackEnds),
          normal = offeredOctets(elapsed, null);
        return [
          {
            deviceId: P.deviceId,
            interfaceId: P.interfaceId,
            ifIndex: P.ifIndex,
            interfaceName: P.interfaceName,
            requestStartedAt,
            collectedAt: new Date(h.now()),
            inOctets: options.attackDirection === 'rx' ? attack : normal,
            outOctets: options.attackDirection === 'rx' ? normal : attack,
            uptimeTicks: 100_000n + BigInt(Math.floor(elapsed / 10)),
            discontinuityTicks: 0n,
            lastChangeTicks: 0n,
            adminStatus: 1,
            operStatus: 1,
            speedBps: target.speedBps,
          },
        ];
      },
    },
    store: {
      latest: async () => observations.at(-1) ?? null,
      append: async (observation) => {
        h.advance(options.databaseDelayMs ?? 2);
        if (observations.at(-1) && observations.at(-1)!.collectedAt >= observation.collectedAt)
          return false;
        if (options.observationStore && !(await options.observationStore.append(observation)))
          return false;
        observations.push(observation);
        return true;
      },
    },
  });
  let nextDecisionAt = startedAt;
  try {
    while (h.now() - startedAt < config.normalIntervalMs * (options.horizonPeriods ?? 18)) {
      await poller.runDue();
      await poller.drain();
      if (h.now() >= nextDecisionAt) {
        decisions.push(...(await h.lifecycle.tickPilot()));
        nextDecisionAt = startedAt + (Math.floor((h.now() - startedAt) / 5000) + 1) * 5000;
      }
      h.advance(250);
    }
    const first = observations.find(
      (o) => o.quality === 'VALID' && BigInt(Math.round(o.txBps ?? 0)) > P.thresholdBps,
    );
    const activation = commands.find((c) => c.input.action === 'ACTIVATE' && c.result.verified);
    const thirdAt = activation ? Date.parse(activation.input.autoEvidence!.sampleAt) : null;
    return {
      synthetic: true,
      physicalHuawei: false,
      clock: 'deterministic',
      cadenceMs: config.normalIntervalMs,
      suspectIntervalMs: config.suspectIntervalMs,
      startedAt,
      attackAtMs: attackAt,
      timeoutRate: options.timeoutRate ?? 0,
      timeouts,
      observations,
      decisions,
      commands,
      confirmationSamples: activation?.input.autoEvidence?.samplesOver ?? 0,
      firstAbnormalMs:
        first && attackAt !== null ? +first.collectedAt - startedAt - attackAt : null,
      confirmationMs: thirdAt !== null && attackAt !== null ? thirdAt - startedAt - attackAt : null,
      decisionDelayMs: activation && thirdAt !== null ? activation.startedAt - thirdAt : null,
      commandMs: activation ? activation.verifiedAt - activation.startedAt : null,
      timingsMs: activation?.result.timingsMs ?? null,
      totalVerifiedSinceAttackMs:
        activation && attackAt !== null ? activation.verifiedAt - startedAt - attackAt : null,
      falsePositive:
        options.attack === false && commands.some((c) => c.input.action === 'ACTIVATE'),
      pollerStatus: poller.status(),
      scope: await h.scope(),
    };
  } finally {
    await poller.stop();
  }
}
