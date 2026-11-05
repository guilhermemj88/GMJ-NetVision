import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FastGrowthNotifications } from './fast-growth-notifications';
import { buildDetectionAlertNotification } from './mitigation-detection-alert';
import { FastTrafficPoller, fastPollerConfig } from '../infrastructure/snmp/fast-traffic-poller';
import type {
  FastTrafficObservation,
  FastTrafficTarget,
} from '../infrastructure/snmp/fast-traffic-types';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';
import type { GrowthWebhookBlock } from '../infrastructure/bgp/mitigation/mitigation-webhook';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
} from '../infrastructure/media/n8n-media-transport';
import {
  MitigationAutoEngine,
  type MitigationAutoDecision,
} from '../worker/mitigation/mitigation-auto-engine';
import {
  AutoMitigationLifecycle,
  scopeKey,
  targetRevision,
  type LifecycleTarget,
} from '../worker/mitigation/auto-lifecycle';
import type { MitigationActionResult } from '../infrastructure/bgp/mitigation/mitigation-command-service';
import { MemoryAutomationStore } from '../worker/mitigation/automation-store';
import {
  DurableMitigationOutbox,
  decodeNotification,
  type OutboxEntry,
} from '../worker/mitigation/durable-mitigation-outbox';
import { PriorityTrafficSource } from '../worker/mitigation/fast-traffic-source';
import { FastObservationSource } from '../worker/mitigation/fast-observation-bridge';

const T0 = Date.parse('2026-11-05T12:00:00Z');
let latestAt = T0;
beforeEach(() => {
  latestAt = T0;
});
const BW = 1_000_000_000n;
const target = (profileId = 'customer-a', interfaceId = 'interface-a'): FastTrafficTarget => ({
  deviceId: 'offline-device',
  interfaceId,
  interfaceName: interfaceId,
  ifIndex: 100,
  speedBps: 10n * BW,
  profiles: [
    {
      profileId,
      direction: 'tx',
      bandwidthBps: BW,
      thresholdBps: (BW * 95n) / 100n,
      triggerPercent: 95,
      recoveryThresholdBps: (BW * 70n) / 100n,
      recoverySamples: 3,
    },
  ],
});
function observation(
  t: FastTrafficTarget,
  at: number,
  txPct: number,
  rxPct = 10,
): FastTrafficObservation {
  latestAt = Math.max(latestAt, at);
  return {
    deviceId: t.deviceId,
    interfaceId: t.interfaceId,
    interfaceName: t.interfaceName,
    ifIndex: t.ifIndex,
    speedBps: t.speedBps,
    id: String(at),
    generation: 'same-collector',
    requestStartedAt: new Date(at),
    collectedAt: new Date(at),
    previousCollectedAt: new Date(at - 5000),
    intervalMs: 5000,
    inOctets: 1n,
    outOctets: 1n,
    uptimeTicks: BigInt(at),
    discontinuityTicks: 0n,
    lastChangeTicks: 0n,
    adminStatus: 1,
    operStatus: 1,
    quality: 'VALID',
    rxBps: (Number(BW) * rxPct) / 100,
    txBps: (Number(BW) * txPct) / 100,
  };
}
function notification(profileId = 'customer-a', at = latestAt): MitigationNotification {
  return {
    event: 'MITIGATION_DETECTION_BLOCKED',
    eventId: 'original-event-id',
    profileId,
    occurredAt: new Date(at).toISOString(),
    episodeId: 'original-episode',
    simulation: true,
    verified: false,
    customer: 'OFFLINE',
    device: 'OFFLINE',
    interfaceName: 'interface-a',
    peer: null,
    affectedPeers: [],
    detectedBandwidthBps: null,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: BW,
    trafficBps: BW,
    thresholdBps: (BW * 95n) / 100n,
    policy: 'OFFLINE',
    node: 2,
    rt: '64500:660',
  };
}
const block = (n: MitigationNotification) => n.growth as GrowthWebhookBlock | undefined;
function feed(g: FastGrowthNotifications, t: FastTrafficTarget, values: number[], start = T0) {
  let at = start;
  for (const pct of values) {
    g.record(t, observation(t, at, pct));
    at += 5000;
  }
  return at;
}

describe('FAST Growth sidecar, informational only', () => {
  it('a collected profile still on the LEGACY route is not enriched', () => {
    const g = new FastGrowthNotifications(15000, () => false),
      t = target();
    feed(g, t, [...Array<number>(7).fill(20), 95]);
    const n = notification();
    expect(g.enrich(n)).toBe(n);
  });
  it.each([
    [20, 'BRUSCO', 75],
    [80, 'MODERADO', 15],
  ] as const)(
    'freezes %s -> 95 at the first crossing, even before AUTO confirmation',
    (before, classification, delta) => {
      const g = new FastGrowthNotifications(15000),
        t = target();
      const at = feed(g, t, [...Array<number>(12).fill(before), 95]);
      const original = notification();
      const frozen = block(g.enrich(original))!;
      expect(frozen).toMatchObject({
        baselineAverage5mPct: before,
        currentUtilizationPct: 95,
        deltaPercentagePoints: delta,
        growthClassification: classification,
        thresholdPct: 95,
        thresholdReachedAt: new Date(at - 5000).toISOString(),
        trafficDirection: 'tx',
      });
      feed(g, t, [99, 100, 110], at);
      expect(block(g.enrich(original))).toEqual(frozen);
      const { growth: _, ...rest } = g.enrich(original);
      expect(rest).toEqual(original);
      expect(original.growth).toBeUndefined();
    },
  );
  it('classifies gradual growth and bounds the rolling history to 5 minutes', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    feed(
      g,
      t,
      Array.from({ length: 76 }, (_, i) => 20 + i),
    );
    const result = block(g.enrich(notification()))!;
    expect(result.growthClassification).toBe('GRADUAL_OU_ESTAVEL');
    expect(result.delta30sPercentagePoints).toBe(6);
    expect(result.samples5m).toBe(59);
    expect(result.baselineAverage5mPct).toBe(65);
  });
  it('insufficient history still reports the measured current rate as INDETERMINADO', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    feed(g, t, [95]);
    expect(block(g.enrich(notification()))).toMatchObject({
      growthClassification: 'INDETERMINADO',
      currentUtilizationPct: 95,
      baselineAverage5mPct: null,
      deltaPercentagePoints: null,
    });
  });
  it('uses a configured threshold other than 95, not a hardcoded percentage', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    t.profiles[0]!.thresholdBps = (BW * 82n) / 100n;
    t.profiles[0]!.triggerPercent = 82;
    feed(g, t, [...Array<number>(7).fill(20), 82]);
    expect(block(g.enrich(notification()))).toMatchObject({
      thresholdPct: 82,
      currentUtilizationPct: 82,
    });
  });
  it('positive configured recovery closes only the snapshot, then starts an independent episode', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    let at = feed(g, t, [...Array<number>(7).fill(20), 95]);
    const first = block(g.enrich(notification()))!;
    at = feed(g, t, [60, 60], at);
    expect(block(g.enrich(notification()))).toEqual(first);
    at = feed(g, t, [60], at);
    expect(g.enrich(notification())).toEqual(notification());
    feed(g, t, [...Array<number>(12).fill(60), 96], at);
    const second = block(g.enrich(notification()))!;
    expect(second.thresholdReachedAt).not.toBe(first.thresholdReachedAt);
    expect(second.currentUtilizationPct).toBe(96);
    expect(second.baselineAverage5mPct).not.toBe(first.baselineAverage5mPct);
  });
  it('isolates customer/profile, interface and RX/TX, including shared physical counters', () => {
    const g = new FastGrowthNotifications(15000),
      a = target(),
      b = target('customer-b');
    b.profiles[0]!.bandwidthBps = BW * 2n;
    b.profiles[0]!.thresholdBps = (BW * 2n * 95n) / 100n;
    g.refresh([a, b]);
    feed(g, a, [...Array<number>(7).fill(20), 95]);
    feed(g, b, [...Array<number>(7).fill(20), 48]);
    expect(block(g.enrich(notification()))).toBeDefined();
    expect(block(g.enrich(notification('customer-b')))).toBeUndefined();
    expect(block(g.enrich({ ...notification(), direction: 'rx' }))).toBeUndefined();
    const c = target('customer-c', 'interface-c');
    feed(g, c, [95]);
    expect(block(g.enrich(notification('customer-c')))?.growthClassification).toBe('INDETERMINADO');
  });
  it('SNMP failures/gaps are not zeros, do not recover a frozen episode, and break baseline continuity', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    let at = feed(g, t, Array<number>(7).fill(20));
    g.unavailable(t);
    at = feed(g, t, [95], at + 30000);
    const first = block(g.enrich(notification()))!;
    expect(first.growthClassification).toBe('INDETERMINADO');
    expect(first.baselineAverage5mPct).toBeNull();
    feed(g, t, [60, 60], at);
    g.unavailable(t);
    feed(g, t, [60], at + 30000);
    expect(block(g.enrich(notification()))).toMatchObject({
      growthClassification: 'INDETERMINADO',
      thresholdReachedAt: null,
    });
    g.record(t, { ...observation(t, at + 40000, 0), quality: 'SNMP_ERROR' });
    expect(block(g.enrich(notification()))).toMatchObject({
      growthClassification: 'INDETERMINADO',
      thresholdReachedAt: null,
    });
  });
  it('invalid rates, out-of-order duplicates, remapping and removal cannot contaminate another episode', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    feed(g, t, [...Array<number>(7).fill(20), 95]);
    const first = block(g.enrich(notification()))!;
    g.record(t, observation(t, T0, 99));
    expect(block(g.enrich(notification()))).toEqual(first);
    const moved = { ...t, ifIndex: 200 };
    g.refresh([moved]);
    g.record(moved, observation(moved, T0 + 60000, Number.NaN));
    expect(g.enrich(notification())).toEqual(notification());
    g.refresh([]);
    expect(g.enrich(notification())).toEqual(notification());
  });
  it('does not manufacture events or overwrite explicit Growth; legacy/removal/test notifications are unchanged', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    feed(g, t, [...Array<number>(7).fill(20), 95]);
    for (const event of [
      'MITIGATION_REMOVED_VERIFIED',
      'MITIGATION_TEST',
      'MITIGATION_ENDED',
    ] as const) {
      const n = { ...notification(), event };
      expect(g.enrich(n)).toBe(n);
    }
    const legacy = notification('not-fast');
    expect(g.enrich(legacy)).toBe(legacy);
    const explicit = { ...notification(), growth: { message: 'existing explicit snapshot' } };
    expect(g.enrich(explicit)).toBe(explicit);
    expect(block(g.enrich(notification()))?.mitigationStatus).toBe('SIMULACAO');
    expect(
      block(g.enrich({ ...notification(), event: 'MITIGATION_FAILED', simulation: false }))
        ?.mitigationStatus,
    ).toBe('DESCONHECIDA');
    expect(
      block(
        g.enrich({
          ...notification(),
          event: 'MITIGATION_VERIFIED',
          simulation: false,
          verified: true,
        }),
      )?.mitigationStatus,
    ).toBe('APLICADA');
  });
});

async function pipeline(
  options: { growth?: boolean; enabled?: boolean; failObserver?: boolean } = {},
) {
  let now = T0,
    txPct = 20,
    inOctets = 0n,
    outOctets = 0n,
    failSnmp = false,
    rejectWrite = false;
  const t = target(),
    g = new FastGrowthNotifications(15000);
  const rows: FastTrafficObservation[] = [];
  const config = fastPollerConfig({
    MITIGATION_FAST_POLL_MODE: 'ENFORCE',
    MITIGATION_FAST_PROFILE_IDS: 'customer-a',
    MITIGATION_FAST_NORMAL_SECONDS: '5',
  });
  const reader = {
    read: vi.fn(async () => {
      if (failSnmp) throw Error('synthetic SNMP timeout');
      return [{ ...observation(t, now, txPct), inOctets, outOctets, uptimeTicks: BigInt(now) }];
    }),
  };
  const store = {
    latest: async () => rows.at(-1) ?? null,
    append: async (o: FastTrafficObservation) => {
      if (rejectWrite) return false;
      rows.push(o);
      return true;
    },
  };
  const poller = new FastTrafficPoller({
    config,
    listTargets: async () => [t],
    reader,
    store,
    now: () => new Date(now),
    ...(options.growth === false
      ? {}
      : {
          observer: options.failObserver
            ? {
                record: () => {
                  throw Error('informational failure');
                },
                unavailable: () => {
                  throw Error('failure');
                },
                refresh: () => {
                  throw Error('failure');
                },
              }
            : g,
        }),
  });
  const traffic = new PriorityTrafficSource({
    config,
    store,
    direction: () => 'tx',
    available: (id) => poller.isAvailable(id),
    legacy: { sample: async () => null, sampleWithId: async () => null },
    now: () => new Date(now),
  });
  const state: {
    state: 'NORMAL';
    triggerCounter: number;
    recoveryCounter: number;
    lastSampleAt: Date | null;
  } = {
    state: 'NORMAL',
    triggerCounter: 0,
    recoveryCounter: 0,
    lastSampleAt: null,
  };
  const targetState: LifecycleTarget = {
    profileId: 'customer-a',
    deviceId: t.deviceId,
    interfaceId: t.interfaceId,
    customer: 'OFFLINE CUSTOMER',
    mode: 'AUTO',
    addressFamily: 'IPV4',
    direction: 'tx',
    directionSource: 'PROFILE',
    policyName: 'PL-OFFLINE',
    enabled: true,
    snapshotAvailable: true,
    readiness: 'READY',
    prefixStatus: 'SAFE',
    blockedReason: null,
    mitigationExcluded: false,
    runtimeState: 'NORMAL',
    effectiveBandwidthBps: BW,
    bogonNode: 1,
    mitigationNode: 2,
    sharedPolicy: false,
    peerAddresses: ['192.0.2.1'],
    triggerPercent: 95,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 3,
    rt: '64500:660',
    scopeMembers: 1,
    fast: true,
    otherFamilyAuto: false,
    clientBinding: null,
  };
  const automation = new MemoryAutomationStore();
  const lifecycle = new AutoMitigationLifecycle({
    store: automation,
    now: () => now,
    config: () => ({
      installation: 'OFFLINE',
      enabled: false,
      executionEnabled: false,
      removeEnabled: false,
      profiles: [],
      devices: [],
      maxActive: 1,
      cooldownMs: 600000,
      maxAgeMs: 15000,
      maxGapMs: 15000,
    }),
    target: async () => targetState,
    execute: async () => {
      throw Error('No executor allowed in this test');
    },
    physical: async () => {
      throw Error('No equipment allowed in this test');
    },
    ...(options.growth === false
      ? {}
      : {
          enrichNotification: (
            n: MitigationNotification,
            direction?: 'rx' | 'tx' | null,
            confirmedAtMs?: number | null,
          ) => g.enrich(n, direction, confirmedAtMs),
        }),
  });
  const commands = {
    execute: vi.fn(async () => ({ ok: true, verified: true, status: 'ACTIVATED_VERIFIED' })),
  };
  const engine = new MitigationAutoEngine({
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [t.deviceId] },
    executionControl: { enabled: options.enabled ?? false },
    targets: { list: async () => [targetState] },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async () => state,
      save: async (_, patch) => {
        Object.assign(state, patch);
      },
    },
    commands,
    sampling: { maxAgeMs: 15000, maxGapMs: 15000 },
    now: () => new Date(now),
    onBlockedActivation: (d) =>
      lifecycle.detection(d, async (stable) =>
        buildDetectionAlertNotification({
          decision: stable,
          deviceName: 'OFFLINE DEVICE',
          interfaceName: t.interfaceName,
        }),
      ),
  });
  const decisions: MitigationAutoDecision[] = [];
  async function step(pct: number) {
    now += 5000;
    txPct = pct;
    outOctets += (BigInt(Math.round((Number(BW) * pct) / 100)) * 5000n) / 8000n;
    inOctets += (((BW * 10n) / 100n) * 5000n) / 8000n;
    await poller.runDue();
    await poller.drain();
    const next = await engine.tick();
    await engine.settleDetectionAlerts();
    for (const d of next) await lifecycle.observe(d);
    decisions.push(...next);
  }
  return {
    t,
    g,
    rows,
    reader,
    poller,
    engine,
    lifecycle,
    automation,
    commands,
    decisions,
    targetState,
    traffic,
    step,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    fail: (v: boolean) => {
      failSnmp = v;
    },
    reject: (v: boolean) => {
      rejectWrite = v;
    },
  };
}

describe('real FAST -> confirmation -> lifecycle outbox -> local HTTP', () => {
  it.each([false, true])(
    'confirmed activation uses TX and its own snapshot, delayed past recovery/new episode=%s',
    async (delayed) => {
      const h = await pipeline();
      h.t.profiles[0]!.direction = 'rx';
      h.targetState.direction = 'rx';
      h.targetState.activationDirection = 'tx';
      feed(h.g, h.t, [...Array<number>(7).fill(20), 95], T0 - 40000);
      const operation = 'auto-activate-offline-confirmed',
        scope = scopeKey(h.targetState);
      await h.automation.transaction(async (tx) => {
        await tx.put(operation, 'command', 'STARTED', {
          id: operation,
          scope,
          origin: 'AUTO',
          action: 'ACTIVATE',
          state: 'STARTED',
        });
        await tx.put(scope, 'scope', 'ACTIVATING', {
          key: scope,
          operationId: operation,
          phase: 'ACTIVATING',
          revision: targetRevision(h.targetState),
          lastSample: T0 - 5000,
          target: { bogon: 1, mitigation: 2, rt: '64500:660' },
        });
      });
      try {
        if (delayed) {
          feed(h.g, h.t, [60, 60, 60, 99], T0);
          h.advance(60000);
        }
        // Already-confirmed fake result. No executor or device is called by completeActivation.
        await h.lifecycle.completeActivation(
          {
            requestId: operation,
            profileId: 'customer-a',
            action: 'ACTIVATE',
            autoOperationId: operation,
          },
          {
            ok: true,
            status: 'ACTIVATED_VERIFIED',
            verified: true,
            bogonNode: 1,
            mitigationNode: 2,
            rt: '64500:660',
            customer: 'OFFLINE',
            device: 'OFFLINE',
            interface: 'interface-a',
          } as MitigationActionResult,
          true,
        );
        const rows = await h.automation.transaction((tx) => tx.list<OutboxEntry>('outbox'));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.payload).toMatchObject({
          event: 'MITIGATION_VERIFIED',
          eventId: operation,
          growth: {
            trafficDirection: 'tx',
            mitigationStatus: 'APLICADA',
            currentUtilizationPct: 95,
          },
        });
        expect(h.commands.execute).not.toHaveBeenCalled();
      } finally {
        await h.poller.stop();
      }
    },
  );
  it('transmits the real application event; preserves the frozen snapshot across recovery, retry and outbox restart', async () => {
    const h = await pipeline();
    const received: Record<string, unknown>[] = [];
    let ack = false;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      received.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ delivered: ack }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('address');
    const transport = new N8nMediaTransport({
      requireAcknowledgement: true,
      media: {
        resolveOutbound: async () => ({
          integrationId: 'offline',
          source: 'DATABASE',
          enabled: true,
          url: `http://127.0.0.1:${address.port}/webhook/offline`,
          token: null,
        }),
        recordOutboundAttempt: async () => {},
        recordOutboundDelivery: async () => {},
      },
      send: createFetchWebhookSender({ timeoutMs: 1000 }),
    });
    try {
      for (const pct of [...Array<number>(13).fill(20), 95, 96, 97, 98]) await h.step(pct);
      const entries = await h.automation.transaction((tx) => tx.list<OutboxEntry>('outbox'));
      expect(entries).toHaveLength(1);
      const n = decodeNotification(entries[0]!.payload);
      expect(n.event).toBe('MITIGATION_DETECTION_BLOCKED');
      expect(n.simulation).toBe(true);
      expect(n.verified).toBe(false);
      expect(block(n)).toMatchObject({
        currentUtilizationPct: 95,
        baselineAverage5mPct: 20,
        growthClassification: 'BRUSCO',
        thresholdPct: 95,
      });
      const q = new DurableMitigationOutbox(h.automation, transport, h.now);
      await q.drain();
      for (const pct of Array<number>(7).fill(20)) await h.step(pct);
      expect(h.g.enrich(notification('customer-a', h.now()))).toEqual(
        notification('customer-a', h.now()),
      );
      ack = true;
      await new DurableMitigationOutbox(h.automation, transport, h.now).drain();
      expect(received).toHaveLength(2);
      expect(received[0]).toEqual(received[1]);
      expect(received[0]!.eventId).toBe(n.eventId);
      expect(received[0]!.profileId).toBe(n.profileId);
      expect(received[0]!.growth).toEqual(n.growth);
      expect(h.commands.execute).not.toHaveBeenCalled();
      expect(h.reader.read).toHaveBeenCalledTimes(24); // One read per scheduled sample, no Growth GET.
      expect(
        (await h.automation.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]!.state,
      ).toBe('SENT');
      if (process.env.FAST_GROWTH_EVIDENCE_PATH)
        await writeFile(
          process.env.FAST_GROWTH_EVIDENCE_PATH,
          JSON.stringify(
            {
              synthetic: true,
              loopbackOnly: true,
              source:
                'FastTrafficPoller -> MitigationAutoEngine -> AutoMitigationLifecycle.detection -> DurableMitigationOutbox -> N8nMediaTransport',
              received,
              snmpReaderCalls: h.reader.read.mock.calls.length,
              commandCalls: h.commands.execute.mock.calls.length,
            },
            null,
            2,
          ) + '\n',
        );
    } finally {
      await h.poller.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([false, true])(
    'AUTO decisions and confirmation counts identical with Growth off/on/broken, execution enabled=%s',
    async (enabled) => {
      const all = [];
      for (const options of [
        { growth: false },
        { growth: true },
        { growth: true, failObserver: true },
      ]) {
        const h = await pipeline({ ...options, enabled });
        try {
          for (const pct of [...Array<number>(8).fill(20), 95, 96, 97, 98, 20, 20, 20])
            await h.step(pct);
          all.push({
            decisions: h.decisions.map((d) => ({
              outcome: d.outcome,
              reason: d.reason,
              samplesOver: d.samplesOver,
              samplesBelow: d.samplesBelow,
              requiredSamples: d.requiredSamples,
              trafficBps: d.trafficBps,
              thresholdBps: d.thresholdBps,
              verified: d.verified,
            })),
            commands: h.commands.execute.mock.calls.length,
            reads: h.reader.read.mock.calls.length,
          });
        } finally {
          await h.poller.stop();
        }
      }
      expect(all[1]).toEqual(all[0]);
      expect(all[2]).toEqual(all[0]);
      expect(all[0]!.commands).toBe(enabled ? 1 : 0);
    },
  );
  it('rejecting persistence and SNMP failures cannot freeze a false Growth crossing', async () => {
    const h = await pipeline();
    try {
      for (let i = 0; i < 8; i++) await h.step(20);
      h.reject(true);
      await h.step(95);
      h.reject(false);
      expect(block(h.g.enrich(notification()))).toBeUndefined();
      h.fail(true);
      await h.step(95);
      h.fail(false);
      await h.step(95); // New counter baseline, not a rate.
      expect(block(h.g.enrich(notification()))).toBeUndefined();
      await h.step(95);
      expect(block(h.g.enrich(notification()))?.growthClassification).toBe('INDETERMINADO');
      expect(h.commands.execute).not.toHaveBeenCalled();
    } finally {
      await h.poller.stop();
    }
  });
  it('external FAST bridge observes only its already-validated rows, with no additional reader call', async () => {
    const h = await pipeline({ growth: false });
    const g = new FastGrowthNotifications(15000);
    const reader = {
      snapshot: vi.fn(async () => ({
        mapping: {
          id: h.t.interfaceId,
          deviceId: h.t.deviceId,
          name: h.t.interfaceName,
          ifIndex: h.t.ifIndex,
          adminStatus: 'UP',
          operStatus: 'UP',
          speedBps: h.t.speedBps,
        },
        current: h.rows.at(-1) ?? null,
        previous: h.rows.at(-2) ?? null,
        collectorAvailable: h.poller.isAvailable(h.t.interfaceId),
      })),
    };
    const profile = {
      profileId: 'customer-a',
      deviceId: h.t.deviceId,
      interfaceId: h.t.interfaceId,
      direction: 'tx' as const,
      revision: 'fixture',
      growth: h.t.profiles[0]!,
    };
    const source = new FastObservationSource({
      config: {
        mode: 'ENFORCE',
        profileIds: ['customer-a'],
        enforceProfileIds: ['customer-a'],
        maxAgeMs: 15000,
        maxGapMs: 15000,
      },
      reader,
      profile: () => profile,
      observer: (p, row) => g.recordBridge(p, row),
      now: () => new Date(h.now()),
    });
    try {
      for (const pct of [...Array<number>(13).fill(20), 95]) {
        await h.step(pct);
        await source.sampleWithId({
          profileId: 'customer-a',
          deviceId: h.t.deviceId,
          interfaceId: h.t.interfaceId,
          bandwidthBps: BW,
        });
      }
      expect(block(g.enrich(notification()))).toMatchObject({
        growthClassification: 'BRUSCO',
        currentUtilizationPct: 95,
      });
      expect(reader.snapshot).toHaveBeenCalledTimes(14);
      expect(h.reader.read).toHaveBeenCalledTimes(14);
    } finally {
      await h.poller.stop();
    }
  });
});
