import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FastObservationSource,
  FastBridgeRoutingSource,
  fastBridgeConfig,
  type FastBridgeSnapshot,
} from './fast-observation-bridge';
import { deriveFastTraffic } from '../../infrastructure/snmp/fast-traffic-rate';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import type { FastCounterReading } from '../../infrastructure/snmp/fast-traffic-types';
import { fastResponseScenario } from '../../testing/fast-response-scenario';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const epoch = Date.parse('2026-10-18T12:00:00Z');
const cfg = () => ({
  mode: 'ENFORCE' as const,
  profileIds: ['p'],
  enforceProfileIds: ['p'],
  maxAgeMs: 30000,
  maxGapMs: 45000,
});
const mapping = () => ({
  id: 'i',
  deviceId: 'd',
  ifIndex: 151,
  name: 'Eth-Trunk1.3024',
  adminStatus: 'UP',
  operStatus: 'UP',
  speedBps: 300_000_000_000n,
});
const reading = (n: number): FastCounterReading => ({
  deviceId: 'd',
  interfaceId: 'i',
  ifIndex: 151,
  interfaceName: 'Eth-Trunk1.3024',
  requestStartedAt: new Date(epoch + n * 10000 - 5),
  collectedAt: new Date(epoch + n * 10000),
  inOctets: BigInt(n) * 125_000_000n,
  outOctets: BigInt(n) * 12_500_000_000n,
  uptimeTicks: BigInt(100000 + n * 1000),
  discontinuityTicks: 0n,
  lastChangeTicks: 0n,
  adminStatus: 1,
  operStatus: 1,
  speedBps: 300_000_000_000n,
});
const observation = (n: number, gen = 'generation') =>
  deriveFastTraffic(
    {
      deviceId: 'd',
      interfaceId: 'i',
      ifIndex: 151,
      interfaceName: 'Eth-Trunk1.3024',
      speedBps: 300_000_000_000n,
      profiles: [],
    },
    reading(n),
    n ? reading(n - 1) : undefined,
    gen,
  );
const target = (over: Partial<MitigationAutoTargetState> = {}): MitigationAutoTargetState => ({
  profileId: 'p',
  deviceId: 'd',
  interfaceId: 'i',
  policyName: 'policy',
  customer: 'synthetic',
  mode: 'AUTO',
  direction: 'tx',
  configurationKey: 'c1',
  addressFamily: 'IPV4',
  autoPromotedBySweep: false,
  snapshotAvailable: true,
  readiness: 'READY',
  prefixStatus: 'SAFE',
  blockedReason: null,
  mitigationExcluded: false,
  runtimeState: 'NORMAL',
  effectiveBandwidthBps: 10_000_000_000n,
  bogonNode: 1,
  mitigationNode: 2,
  sharedPolicy: false,
  peerAddresses: [],
  triggerPercent: 90,
  recoveryPercent: 70,
  triggerSamples: 3,
  recoverySamples: 12,
  ...over,
});
function harness() {
  let now = epoch + 10000,
    revision = 'c1',
    direction: 'rx' | 'tx' | null = 'tx',
    unavailable = false;
  let snapshot: FastBridgeSnapshot = {
    mapping: mapping(),
    current: observation(1),
    previous: observation(0),
    collectorAvailable: true,
  };
  let persistedAt: Date | null = null;
  const commands = vi.fn(async () => ({ ok: true, status: 'ACTIVATED_VERIFIED', verified: true }));
  const source = new FastObservationSource({
    config: cfg(),
    profile: () => ({ profileId: 'p', deviceId: 'd', interfaceId: 'i', direction, revision }),
    now: () => new Date(now),
    reader: {
      snapshot: async () => {
        if (unavailable) throw Error('db unavailable');
        return snapshot;
      },
    },
  });
  const makeEngine = (mode: 'AUTO' | 'SIMULATION_ONLY' = 'AUTO', executionEnabled = true) =>
    new MitigationAutoEngine({
      sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
      globalMode: mode,
      requireRuntimeRead: true,
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: ['d'] },
      targets: { list: async () => [target()] },
      traffic: source,
      exclusions: { listPeerExclusions: async () => [] },
      runtime: {
        get: async () => ({
          state: 'NORMAL',
          triggerCounter: 2,
          recoveryCounter: 0,
          lastSampleAt: persistedAt,
        }),
        save: async (_, patch) => {
          if (patch.lastSampleAt) persistedAt = patch.lastSampleAt;
        },
      },
      commands: { execute: commands },
      now: () => new Date(now),
      // Contrato da PONTE (confirmacoes/continuidade ate o comando): exige a
      // execucao ligada. Com o kill switch desligado nenhum comando sairia
      // (coberto em mitigation-safety-gates-03.test.ts).
      executionControl: { enabled: executionEnabled },
    });
  return {
    source,
    commands,
    makeEngine,
    snapshot: () => snapshot,
    edit: (fn: (s: FastBridgeSnapshot) => void) => fn(snapshot),
    step: (n: number, gen = 'generation') => {
      now = epoch + n * 10000;
      snapshot = {
        mapping: mapping(),
        current: observation(n, gen),
        previous: observation(n - 1, gen),
        collectorAvailable: true,
      };
    },
    age: () => {
      now += 30001;
    },
    fail: () => {
      unavailable = true;
    },
    revision: (v: string) => {
      revision = v;
    },
    direction: (v: 'rx' | 'tx' | null) => {
      direction = v;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('external observation bridge contract and engine continuity', () => {
  it('exposes three confirmations and in-flight progress without claiming verified readback', async () => {
    const h = harness(),
      engine = h.makeEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.commands.mockImplementation(async () => {
      await gate;
      return { ok: true, status: 'ACTIVATED_VERIFIED', verified: true };
    });
    await engine.evaluate(target());
    h.step(2);
    await engine.evaluate(target());
    h.step(3);
    const pending = engine.evaluate(target());
    await vi.waitFor(() => expect(h.commands).toHaveBeenCalledTimes(1));
    expect(engine.isBusy('p')).toBe(true);
    expect(engine.getDecisions()[0]).toMatchObject({
      samplesOver: 3,
      commandStatus: 'IN_FLIGHT',
      verified: false,
    });
    release();
    expect((await pending).verified).toBe(true);
    expect(engine.isBusy('p')).toBe(false);
    expect(engine.getDecisions()[0]?.commandStatus).toBe('ACTIVATED_VERIFIED');
  });
  it('requires separate explicit enforcement authorization and refuses concurrent collectors', () => {
    expect(fastBridgeConfig({}).mode).toBe('OFF');
    expect(() =>
      fastBridgeConfig({
        MITIGATION_FAST_BRIDGE_MODE: 'ENFORCE',
        MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'p',
      }),
    ).toThrow();
    expect(() =>
      fastBridgeConfig({
        MITIGATION_FAST_BRIDGE_MODE: 'SHADOW',
        MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'p',
        MITIGATION_FAST_POLL_MODE: 'OBSERVE',
      }),
    ).toThrow();
  });
  it('recomputes HC deltas, binds config/direction, and routes exactly one source with no fallback', async () => {
    const h = harness(),
      legacy = { sample: vi.fn(async () => 1n), sampleWithId: vi.fn(async () => null) };
    expect((await h.source.sampleWithId({ ...target(), bandwidthBps: 10_000_000_000n }))?.bps).toBe(
      10_000_000_000n,
    );
    const routed = new FastBridgeRoutingSource(cfg(), h.source, legacy);
    h.fail();
    expect(await routed.sampleWithId({ ...target(), bandwidthBps: 1n })).toBeNull();
    expect(legacy.sampleWithId).not.toHaveBeenCalled();
  });
  it.each([
    'collector',
    'observationDb',
    'mapping',
    'ifIndex',
    'adminDown',
    'operDown',
    'stale',
    'invalidRate',
    'reset',
    'uptime',
    'generation',
    'interval',
    'previousDevice',
    'wrongConfig',
    'direction',
  ] as const)('%s invalidates the sample without zero substitution', async (kind) => {
    const h = harness();
    if (kind === 'observationDb') h.fail();
    else if (kind === 'stale') h.age();
    else if (kind === 'wrongConfig') h.revision('c2');
    else if (kind === 'direction') h.direction(null);
    else
      h.edit((s) => {
        if (kind === 'collector') s.collectorAvailable = false;
        if (kind === 'mapping') s.mapping = null;
        if (kind === 'ifIndex') s.mapping!.ifIndex++;
        if (kind === 'adminDown') s.mapping!.adminStatus = 'DOWN';
        if (kind === 'operDown') s.mapping!.operStatus = 'DOWN';
        if (kind === 'invalidRate') s.current!.txBps = -1;
        if (kind === 'reset') s.current!.outOctets = -1n;
        if (kind === 'uptime') s.current!.uptimeTicks = 1n;
        if (kind === 'generation') s.current!.generation = 'restarted';
        if (kind === 'interval') s.current!.intervalMs = 50000;
        if (kind === 'previousDevice') s.previous!.deviceId = 'other';
      });
    expect(await h.source.sampleWithId({ ...target(), bandwidthBps: 1n })).toBeNull();
    expect(h.source.status()[0]!.available).toBe(false);
  });
  it('needs three unique samples and never reuses one after API restart', async () => {
    const h = harness();
    let e = h.makeEngine();
    expect((await e.evaluate(target())).samplesOver).toBe(1);
    expect((await e.evaluate(target())).samplesOver).toBe(1);
    e = h.makeEngine();
    expect((await e.evaluate(target())).samplesOver).toBe(0);
    h.step(2);
    expect((await e.evaluate(target())).samplesOver).toBe(1);
    h.step(3);
    expect((await e.evaluate(target())).samplesOver).toBe(2);
    h.step(4);
    expect((await e.evaluate(target())).outcome).toBe('ACTIVATED');
    expect(h.commands).toHaveBeenCalledTimes(1);
  });
  it('resets suspicion after unavailable collection and observer generation change', async () => {
    const h = harness(),
      e = h.makeEngine();
    await e.evaluate(target());
    h.step(2);
    await e.evaluate(target());
    h.edit((s) => {
      s.collectorAvailable = false;
    });
    expect((await e.evaluate(target())).reason).toBe('TELEMETRY_UNAVAILABLE');
    h.step(3, 'restarted');
    expect((await e.evaluate(target())).samplesOver).toBe(1);
    expect(h.commands).not.toHaveBeenCalled();
  });
  it('resets after direction or configuration edit while preserving consumed identity', async () => {
    const h = harness(),
      e = h.makeEngine();
    await e.evaluate(target());
    h.step(2);
    await e.evaluate(target());
    h.revision('c2');
    h.step(3);
    expect((await e.evaluate(target({ configurationKey: 'c2' }))).samplesOver).toBe(1);
    expect(h.commands).not.toHaveBeenCalled();
  });
  it.each(['ALERT_ONLY', 'DISABLED', 'PROMOTED', 'SHARED', 'IPV6', 'SHADOW'] as const)(
    '%s retains execution guard with telemetry present',
    async (kind) => {
      const h = harness(),
        // PROMOTED = guarda do kill switch (MITIGATION_AUTO_EXECUTION_ENABLED=0).
        e = h.makeEngine(kind === 'SHADOW' ? 'SIMULATION_ONLY' : 'AUTO', kind !== 'PROMOTED');
      const t = target({
        ...(kind === 'ALERT_ONLY' ? { mode: 'ALERT_ONLY' } : {}),
        ...(kind === 'DISABLED' ? { mode: 'DISABLED' } : {}),
        ...(kind === 'PROMOTED' ? { autoPromotedBySweep: true } : {}),
        ...(kind === 'SHARED' ? { blockedReason: 'SHARED_POLICY' } : {}),
        ...(kind === 'IPV6' ? { addressFamily: 'IPV6' } : {}),
      });
      for (let n = 1; n <= 4; n++) {
        h.step(n);
        await e.evaluate(t);
      }
      expect(h.commands).not.toHaveBeenCalled();
    },
  );
  it.each([1, 4])(
    'complete bridge pipeline, %i profiles, synthetic preflight/execution/readback',
    async (count) => {
      vi.useFakeTimers();
      const start = epoch;
      vi.setSystemTime(start);
      const h = await fastResponseScenario({
        startAt: start,
        attackAt: start + 55000,
        protectedProfiles: count,
        externalBridge: true,
        databaseDelayMs: 25,
      });
      try {
        h.start();
        await vi.advanceTimersByTimeAsync(240000);
        const actions = h.decisions.filter((d) => d.outcome === 'ACTIVATED');
        expect(actions).toHaveLength(count);
        expect(actions.every((d) => d.verified && d.totalResponseMs! <= 60000)).toBe(true);
        const sorted = actions.map((d) => d.totalResponseMs!).sort((a, b) => a - b);
        const report = {
          realHuawei: false,
          externalBridge: true,
          profiles: count,
          p50Ms: sorted[Math.ceil(count * 0.5) - 1],
          p95Ms: sorted[Math.ceil(count * 0.95) - 1],
          maxMs: sorted.at(-1),
          actions: actions.map((d) => ({
            confirmationMs: d.confirmationMs,
            timingsMs: d.timingsMs,
            totalResponseMs: d.totalResponseMs,
          })),
          sourceReads: h.bridgeTraffic.status(),
        };
        mkdirSync(resolve('../../.artifacts'), { recursive: true });
        writeFileSync(
          resolve('../../.artifacts/fast-bridge-benchmark-' + count + '.json'),
          JSON.stringify(report, null, 2),
        );
      } finally {
        const stop = h.stop();
        await vi.advanceTimersByTimeAsync(5000);
        await stop;
      }
    },
  );
  it.each(['preflight', 'readback', 'snmp', 'down', 'stale', 'lateReadback'] as const)(
    'external bridge full pipeline: %s failure preserves fail-closed behavior',
    async (kind) => {
      vi.useFakeTimers();
      const start = epoch;
      vi.setSystemTime(start);
      const h = await fastResponseScenario({
        startAt: start,
        attackAt: start + 55000,
        externalBridge: true,
        ...(kind === 'preflight' ? { preflightFails: true } : {}),
        ...(kind === 'readback' ? { readbackFails: true } : {}),
        ...(kind === 'snmp' ? { unavailableHost: 0 } : {}),
        ...(kind === 'down' ? { downAt: start + 65000 } : {}),
        ...(kind === 'stale' ? { frozenAt: start + 61000 } : {}),
        ...(kind === 'lateReadback' ? { readbackMs: 45000 } : {}),
      });
      try {
        h.start();
        await vi.advanceTimersByTimeAsync(180000);
        const activations = h.decisions.filter((d) => d.outcome === 'ACTIVATED');
        if (kind === 'lateReadback') {
          expect(activations).toHaveLength(1);
          expect(activations[0]!.responseDeadlineExceeded).toBe(true);
        } else {
          expect(activations).toHaveLength(0);
          if (kind !== 'readback')
            expect(h.hardware.calls.filter((c) => c.startsWith('route-policy'))).toHaveLength(0);
        }
      } finally {
        const stop = h.stop();
        await vi.advanceTimersByTimeAsync(5000);
        await stop;
      }
    },
  );
});
