import { describe, expect, it } from 'vitest';
import type { MitigationTrafficSample, MitigationTrafficSource } from './mitigation-traffic-source';
import { InterfaceTrafficSource, RuntimeTrafficSource } from './mitigation-traffic-source';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import { PriorityTrafficSource } from './fast-traffic-source';
import { fastPollerConfig } from '../../infrastructure/snmp/fast-traffic-poller';

const target: MitigationAutoTargetState = {
  profileId: 'p',
  deviceId: 'd',
  interfaceId: 'i',
  policyName: 'policy',
  customer: 'BHNET',
  mode: 'AUTO',
  addressFamily: 'IPV4',
  direction: 'tx',
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
};

function fixture(patch: Partial<MitigationAutoTargetState> = {}, executionEnabled = true) {
  let clock = 100000;
  let row: MitigationTrafficSample | null = null;
  let calls = 0;
  let runtime: {
    state: 'NORMAL';
    triggerCounter: number;
    recoveryCounter: number;
    lastSampleAt?: Date | null;
  } | null = null;
  const t = { ...target, ...patch };
  const traffic: MitigationTrafficSource = {
    sample: async () => row?.bps ?? null,
    sampleWithId: async () => row,
  };
  const engine = new MitigationAutoEngine({
    sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: ['d'] },
    // Contrato de continuidade ate o comando: execucao ligada por padrao (o
    // kill switch tem testes proprios em mitigation-safety-gates-03.test.ts).
    executionControl: { enabled: executionEnabled },
    targets: { list: async () => [t] },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async () => runtime,
      save: async (_, p) => {
        runtime = {
          ...(runtime ?? { state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0 }),
          ...p,
        } as typeof runtime;
      },
    },
    commands: {
      execute: async () => {
        calls++;
        return { ok: true, verified: true, status: 'ACTIVATED_VERIFIED' };
      },
    },
    now: () => new Date(clock),
  });
  return {
    t,
    engine,
    calls: () => calls,
    set: (
      at: number,
      bps: bigint | null = 156_000_000_000n,
      extra: Partial<MitigationTrafficSample> = {},
    ) => {
      clock = at;
      row =
        bps === null
          ? null
          : {
              bps,
              sampleKey: String(at),
              occurredAt: new Date(at),
              rateStartAt: new Date(at - 10000),
              continuityKey: 'g',
              ...extra,
            };
    },
  };
}

describe('atomic traffic identity', () => {
  it('interface value and timestamp come from exactly one query', async () => {
    let calls = 0;
    const source = new InterfaceTrafficSource(
      {
        latestTraffic: async () => {
          calls++;
          return {
            interfaceId: 'i',
            timestamp: new Date(100000 + (calls - 1) * 10000),
            txBps: calls === 1 ? 156e9 : 0,
            rxBps: 0,
          };
        },
      },
      { direction: 'tx', maxAgeMs: 45000, now: () => new Date(110000) },
    );
    const s = await source.sampleWithId({ ...target, bandwidthBps: target.effectiveBandwidthBps });
    expect(calls).toBe(1);
    expect(s?.bps).toBe(156_000_000_000n);
    expect(s?.occurredAt?.getTime()).toBe(100000);
  });
  it('runtime identity also uses one snapshot', async () => {
    let calls = 0;
    const source = new RuntimeTrafficSource(
      {
        getRuntime: async () => {
          calls++;
          return {
            currentTrafficBps: 10n,
            lastSampleAt: new Date(100000),
          } as never;
        },
      },
      45000,
      () => new Date(100000),
    );
    expect((await source.sampleWithId({ ...target, bandwidthBps: null }))?.bps).toBe(10n);
    expect(calls).toBe(1);
  });
  it.each(['adminStatus', 'operStatus', 'currentOperStatus', 'usable', 'deviceId'])(
    'rejects latest inconsistent %s without fallback',
    async (key) => {
      const row = {
        interfaceId: 'i',
        timestamp: new Date(100000),
        txBps: 156e9,
        rxBps: 0,
        [key]: key === 'usable' ? false : key === 'deviceId' ? 'wrong' : 'DOWN',
      };
      const source = new InterfaceTrafficSource(
        { latestTraffic: async () => row },
        { direction: 'tx', maxAgeMs: 45000, now: () => new Date(100000) },
      );
      expect(await source.sampleWithId({ ...target, bandwidthBps: null })).toBeNull();
    },
  );
  it('OBSERVE routes only legacy; ENFORCE selected scope never falls back', async () => {
    let legacyCalls = 0;
    const deps = {
      config: { ...fastPollerConfig({}), mode: 'OBSERVE' as const, profileIds: ['p'] },
      legacy: {
        sampleWithId: async () => {
          legacyCalls++;
          return null;
        },
        sample: async () => null,
      },
      store: { latest: async () => null, append: async () => false },
      direction: () => 'tx' as const,
      available: () => false,
    };
    await new PriorityTrafficSource(deps).sampleWithId({ ...target, bandwidthBps: null });
    expect(legacyCalls).toBe(1);
    await new PriorityTrafficSource({
      ...deps,
      config: { ...deps.config, mode: 'ENFORCE' },
    }).sampleWithId({ ...target, bandwidthBps: null });
    expect(legacyCalls).toBe(1);
  });
  it('dynamic AUTO-ALL never falls back to legacy when its static profile list is empty', async () => {
    let legacyCalls = 0;
    const config = fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'ENFORCE',
      MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED: '1', MITIGATION_FAST_NORMAL_SECONDS: '5' });
    const source = new PriorityTrafficSource({ config,
      legacy: { sample: async () => null, sampleWithId: async () => { legacyCalls++; return null; } },
      store: { latest: async () => null, append: async () => false },
      direction: () => 'tx', available: () => false,
    });
    expect(await source.sampleWithId({ ...target, profileId: 'newly-discovered', bandwidthBps: null })).toBeNull();
    expect(legacyCalls).toBe(0);
  });
});

describe('explicit temporal continuity', () => {
  it('1/3, repeated sample, 2/3, 3/3 at ten second intervals', async () => {
    const f = fixture();
    f.set(100000);
    expect((await f.engine.evaluate(f.t)).samplesOver).toBe(1);
    for (let i = 0; i < 9; i++) expect((await f.engine.evaluate(f.t)).samplesOver).toBe(1);
    f.set(110000);
    expect((await f.engine.evaluate(f.t)).samplesOver).toBe(2);
    f.set(120000);
    const d = await f.engine.evaluate(f.t);
    expect(d.outcome).toBe('ACTIVATED');
    expect(d.confirmationMs).toBe(20000);
    expect(f.calls()).toBe(1);
    await f.engine.evaluate(f.t);
    expect(f.calls()).toBe(1);
  });
  it('exact threshold does not qualify; above qualifies; below breaks the sequence', async () => {
    const f = fixture();
    f.set(100000, 9_000_000_000n);
    // Limiar publicado é exclusivo (`>`): igual ao gatilho NÃO confirma.
    expect((await f.engine.evaluate(f.t)).samplesOver).toBe(0);
    f.set(110000, 9_000_000_001n);
    expect((await f.engine.evaluate(f.t)).samplesOver).toBe(1);
    f.set(120000, 8_999_999_999n);
    expect((await f.engine.evaluate(f.t)).samplesOver).toBe(0);
  });
  it.each(['missing', 'stale', 'future', 'long-rate-window', 'generation', 'gap'])(
    '%s breaks an attack sequence',
    async (condition) => {
      const f = fixture();
      f.set(100000);
      await f.engine.evaluate(f.t);
      if (condition === 'missing') {
        f.set(110000, null);
        await f.engine.evaluate(f.t);
        f.set(120000);
      }
      if (condition === 'stale') {
        f.set(160000, 156_000_000_000n, { occurredAt: new Date(100000) });
        await f.engine.evaluate(f.t);
        f.set(170000);
      }
      if (condition === 'future') {
        f.set(110000, 156_000_000_000n, { occurredAt: new Date(120000) });
        await f.engine.evaluate(f.t);
        f.set(130000);
      }
      if (condition === 'long-rate-window') {
        f.set(110000, 156_000_000_000n, { rateStartAt: new Date(0) });
        await f.engine.evaluate(f.t);
        f.set(120000);
      }
      if (condition === 'generation') f.set(110000, 156_000_000_000n, { continuityKey: 'restart' });
      if (condition === 'gap') f.set(160000);
      expect((await f.engine.evaluate(f.t)).samplesOver).toBe(1);
      expect(f.calls()).toBe(0);
    },
  );
  it('reordered sample does not count, nor regress persisted identity', async () => {
    const f = fixture();
    f.set(100000);
    await f.engine.evaluate(f.t);
    f.set(110000, 156_000_000_000n, { occurredAt: new Date(90000), rateStartAt: new Date(80000) });
    expect((await f.engine.evaluate(f.t)).samplesOver).toBe(1);
    expect(f.calls()).toBe(0);
    f.set(120000);
    expect((await f.engine.evaluate(f.t)).samplesOver).toBe(2);
  });
  it.each([
    [{ mode: 'ALERT_ONLY' }, 'ALERT_TRIGGERED'],
    [{ autoPromotedBySweep: true }, 'WOULD_ACTIVATE'],
    [{ readiness: 'NOT_READY' }, 'BLOCKED'],
    [{ mitigationExcluded: true }, 'BLOCKED'],
  ] as const)('preserves scope/mode guard %j', async (patch, outcome) => {
    // Perfil promovido: guarda do kill switch (MITIGATION_AUTO_EXECUTION_ENABLED=0).
    const f = fixture(patch, !('autoPromotedBySweep' in patch));
    for (const time of [100000, 110000, 120000]) {
      f.set(time);
      await f.engine.evaluate(f.t);
    }
    expect(f.engine.getLastVerifiedActivate()).toBeNull();
    expect(f.calls()).toBe(0);
    f.set(130000);
    expect((await f.engine.evaluate(f.t)).outcome).toBe(outcome);
  });
});

describe('BHNET real-history replay (no invented intermediate observations)', () => {
  it('does not trigger across the real 540/490s gaps and DOWN', async () => {
    const f = fixture();
    const observations = [
      ['2026-10-17T20:23:24.558Z', 386066181n, 0],
      ['2026-10-17T20:32:24.948Z', 156045452040n, 540390],
      ['2026-10-17T20:40:35.874Z', null, 490926], // historical high row is DOWN, rejected by source
      ['2026-10-17T20:44:34.140Z', null, 238266], // still DOWN; frozen counters do not imply recovery
    ] as const;
    for (const [at, bps, interval] of observations) {
      const time = Date.parse(at);
      f.set(time, bps, { rateStartAt: new Date(time - interval) });
      const d = await f.engine.evaluate(f.t);
      expect(d.samplesOver).toBe(0);
      expect(d.outcome).not.toBe('ACTIVATED');
    }
    expect(f.calls()).toBe(0);
  });
  it.each(['brief-spike', 'normal-again', 'snmp-error', 'admin-down', 'frozen'])(
    'hypothetical ten-second %s does not confirm',
    async (scenario) => {
      const f = fixture();
      f.set(100000);
      await f.engine.evaluate(f.t);
      f.set(110000, ['snmp-error', 'admin-down'].includes(scenario) ? null : 0n);
      await f.engine.evaluate(f.t);
      f.set(120000, 0n);
      await f.engine.evaluate(f.t);
      expect(f.calls()).toBe(0);
    },
  );
});
