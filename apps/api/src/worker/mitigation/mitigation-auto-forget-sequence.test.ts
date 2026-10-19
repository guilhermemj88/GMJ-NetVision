import { describe, expect, it } from 'vitest';
import type { MitigationTrafficSample, MitigationTrafficSource } from './mitigation-traffic-source';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';

// CONCORRENCIA COM O FAST ENFORCE.
//
// A retirada manual de uma policy compartilhada invalida a sequencia de
// amostras que autorizou a mitigacao. Sem isso, o proximo tick (10 s na fonte
// FAST) reativaria a policy com amostras colhidas ANTES da retirada.

const target: MitigationAutoTargetState = {
  profileId: 'p-3043',
  deviceId: 'host-bhnet',
  interfaceId: 'if-3043',
  policyName: 'PL-BHNET_IPv4-IN',
  customer: 'BHNET-CEASA',
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
  effectiveBandwidthBps: 300_000_000_000n,
  bogonNode: 1,
  mitigationNode: 2,
  sharedPolicy: true,
  peerAddresses: ['10.200.200.222'],
  triggerPercent: 90,
  recoveryPercent: 70,
  triggerSamples: 3,
  recoverySamples: 12,
};

function fixture() {
  let clock = 100_000;
  let row: MitigationTrafficSample | null = null;
  let activations = 0;
  let runtime: { state: string; triggerCounter: number; recoveryCounter: number } = {
    state: 'NORMAL',
    triggerCounter: 0,
    recoveryCounter: 0,
  };
  const traffic: MitigationTrafficSource = {
    sample: async () => row?.bps ?? null,
    sampleWithId: async () => row,
  };
  const engine = new MitigationAutoEngine({
    sampling: { maxAgeMs: 45_000, maxGapMs: 45_000 },
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: ['host-bhnet'] },
    executionControl: { enabled: true },
    targets: { list: async () => [target] },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async () => runtime as never,
      save: async (_id, patch) => {
        runtime = { ...runtime, ...(patch as object) } as typeof runtime;
      },
    },
    commands: {
      execute: async () => {
        activations += 1;
        return { ok: true, verified: true, status: 'ACTIVATED_VERIFIED' };
      },
    },
    now: () => new Date(clock),
  });
  return {
    engine,
    activations: () => activations,
    at: (at: number, bps: bigint = 280_000_000_000n) => {
      clock = at;
      row = {
        bps,
        sampleKey: String(at),
        occurredAt: new Date(at),
        rateStartAt: new Date(at - 10_000),
        continuityKey: 'bhnet:3043:tx',
      };
    },
  };
}

describe('retirada manual x FAST ENFORCE', () => {
  it('forgetProfiles exige sequencia NOVA de amostras antes de reativar', async () => {
    const f = fixture();

    f.at(110_000);
    expect((await f.engine.evaluate(target)).samplesOver).toBe(1);
    f.at(120_000);
    expect((await f.engine.evaluate(target)).samplesOver).toBe(2);

    // Operador retira a mitigacao (escopo fisico) -> motor esquece a sequencia.
    f.engine.forgetProfiles([target.profileId]);

    f.at(130_000);
    const afterRemoval = await f.engine.evaluate(target);
    expect(afterRemoval.samplesOver).toBe(1);
    expect(f.activations()).toBe(0);

    // Duas amostras novas ainda nao bastam (triggerSamples = 3).
    f.at(140_000);
    expect((await f.engine.evaluate(target)).samplesOver).toBe(2);
    f.at(150_000);
    expect((await f.engine.evaluate(target)).samplesOver).toBe(3);
    f.at(160_000);
    await f.engine.evaluate(target);
    expect(f.activations()).toBeGreaterThan(0);
  });

  it('a sequencia antiga nao vaza entre perfis do mesmo escopo', async () => {
    const f = fixture();
    f.at(110_000);
    await f.engine.evaluate(target);
    f.at(120_000);
    await f.engine.evaluate(target);

    // O escopo tem dois vinculos: o forgot e aplicado a TODOS eles.
    f.engine.forgetProfiles([target.profileId, 'p-3044']);
    f.at(130_000);
    const siblingTarget = { ...target, profileId: 'p-3044', interfaceId: 'if-3044' };
    const decision = await f.engine.evaluate(siblingTarget);
    expect(decision.samplesOver).toBe(1);
    expect(f.activations()).toBe(0);
  });
});
