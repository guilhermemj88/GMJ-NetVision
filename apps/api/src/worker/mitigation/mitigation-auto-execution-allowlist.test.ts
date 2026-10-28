import { describe, expect, it, vi } from 'vitest';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import type { MitigationTrafficSample, MitigationTrafficSource } from './mitigation-traffic-source';

// AUTO-ALL: gate de execucao POR PERFIL (allowlist) ? fail-closed, sem escrita real.
// Nenhum teste abre socket ou toca Huawei: o executor e um spy.

const D='dev-1', BW=10_000_000_000n, NOW=new Date('2026-10-21T15:00:00Z');

class Q implements MitigationTrafficSource {
  private f: MitigationTrafficSample[] = [];
  push(bps: bigint, key: string, at: Date = NOW) { this.f.push({ bps, sampleKey: key, occurredAt: at }); }
  async sample() { return this.f[0]?.bps ?? null; }
  async sampleWithId() { return this.f[0] ?? null; }
  take() { this.f.shift(); }
}

function target(over: Partial<MitigationAutoTargetState> = {}): MitigationAutoTargetState {
  return {
    profileId: 'p-manual', deviceId: D, policyName: 'PL-X', interfaceId: 'if-1', customer: 'X',
    mode: 'AUTO', direction: 'tx', directionSource: 'PROFILE', snapshotAvailable: true,
    readiness: 'READY', prefixStatus: 'SAFE', blockedReason: null, mitigationExcluded: false,
    runtimeState: 'NORMAL', effectiveBandwidthBps: BW, bogonNode: 1, mitigationNode: 2,
    sharedPolicy: false, peerAddresses: ['10.0.0.1'], triggerPercent: 90, recoveryPercent: 70,
    triggerSamples: 3, recoverySamples: 12, ...over,
  };
}

function harness(opts: {
  t: MitigationAutoTargetState;
  executionControl?: { enabled: boolean; allowedProfileIds?: string[]; legacyExemptProfileIds?: string[] };
}) {
  const traffic = new Q();
  // Cada tick = um ciclo SNMP novo (10 s): amostras temporalmente distintas.
  const clock = { value: new Date(NOW) };
  const execute = vi.fn(async () => ({ ok: true, verified: true, status: 'ACTIVATED_VERIFIED' as const }));
  const engine = new MitigationAutoEngine({
    sampling: { maxAgeMs: 30_000, maxGapMs: 45_000 },
    evaluationScope: 'OPERATIONAL',
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [D] },
    ...(opts.executionControl ? { executionControl: opts.executionControl } : {}),
    requireRuntimeRead: false,
    targets: { list: async () => [opts.t] },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: { get: async () => ({ state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0, lastSampleAt: null }),
               save: async () => undefined },
    commands: { execute },
    now: () => clock.value,
  });
  const over = (BW * 95n) / 100n;
  const run = async (keys: string[]) => {
    let last: Awaited<ReturnType<typeof engine.tick>> = [];
    for (const k of keys) {
      clock.value = new Date(clock.value.getTime() + 10_000);
      traffic.push(over, k, clock.value);
      last = await engine.tick();
      traffic.take();
    }
    return last[0]!;
  };
  return { run, execute };
}

const THREE = ['s1', 's2', 's3'];

describe('gate de execucao por perfil (allowlist)', () => {
  it('AUTO manual FORA da allowlist => WOULD_ACTIVATE/AUTO_EXECUTION_NOT_AUTHORIZED, zero comando', async () => {
    const h = harness({ t: target(), executionControl: { enabled: true, allowedProfileIds: ['outro'] } });
    const d = await h.run(THREE);
    expect(d).toMatchObject({ outcome: 'WOULD_ACTIVATE', reason: 'AUTO_EXECUTION_NOT_AUTHORIZED' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('AUTO manual DENTRO da allowlist e execucao ligada => ACTIVATED (caminho canonico)', async () => {
    const h = harness({ t: target(), executionControl: { enabled: true, allowedProfileIds: ['p-manual'] } });
    const d = await h.run(THREE);
    expect(d).toMatchObject({ outcome: 'ACTIVATED', commandStatus: 'ACTIVATED_VERIFIED' });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('perfil isento (legado) ignora a allowlist', async () => {
    const h = harness({
      t: target({ profileId: 'bhnet-3043' }),
      executionControl: { enabled: true, allowedProfileIds: ['outro'], legacyExemptProfileIds: ['bhnet-3043'] },
    });
    const d = await h.run(THREE);
    expect(d.outcome).toBe('ACTIVATED');
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('sem allowlist (vazio) o gate por perfil nao restringe ninguem', async () => {
    // Kill switch LIGADO: sem allowlist o gate por perfil e inerte. O estado
    // DESLIGADO e coberto por `mitigation-auto-execution-control.test.ts`.
    const h = harness({ t: target(), executionControl: { enabled: true, allowedProfileIds: [] } });
    const d = await h.run(THREE);
    expect(d.outcome).toBe('ACTIVATED');
  });

  it('sweep-promoted com EXECUTION=0 continua pausado mesmo dentro da allowlist', async () => {
    const h = harness({
      t: target({ profileId: 'p-sweep', autoPromotedBySweep: true }),
      executionControl: { enabled: false, allowedProfileIds: ['p-sweep'] },
    });
    const d = await h.run(THREE);
    expect(d).toMatchObject({ outcome: 'WOULD_ACTIVATE', reason: 'AUTO_EXECUTION_DISABLED' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('ALERT_ONLY nunca passa pelo gate de execucao (ALERT_TRIGGERED, zero comando)', async () => {
    const h = harness({ t: target({ mode: 'ALERT_ONLY' }), executionControl: { enabled: true, allowedProfileIds: [] } });
    const d = await h.run(THREE);
    expect(d.outcome).toBe('ALERT_TRIGGERED');
    expect(h.execute).not.toHaveBeenCalled();
  });
});
