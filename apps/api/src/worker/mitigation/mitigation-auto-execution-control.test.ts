import { describe, expect, it } from 'vitest';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import type {
  MitigationDirectionsSample,
  MitigationTrafficSource,
} from './mitigation-traffic-source';
import type { MitigationState } from '../../infrastructure/bgp/mitigation/mitigation-types';

// AUTO-ALL (correcoes pre-deploy): CONTROLE DE EXECUCAO separado da AUTORIZACAO.
//
// Cenario central: 18 perfis promovidos pelo sweep (`autoPromotedBySweep=true`).
// Com `MITIGATION_AUTO_EXECUTION_ENABLED=0` (executionControl.enabled=false) o
// motor NAO inicia NOVAS ativacoes desses perfis; o AUTO manual/legado
// (BHNET-3043, proveniencia false) continua atuando e mitigacao ativa permanece.

const DEVICE = 'device-1';
const BW = 10_000_000_000n;
const OVER = (BW * 95n) / 100n;

function target(
  profileId: string,
  over: Partial<MitigationAutoTargetState> = {},
): MitigationAutoTargetState {
  return {
    profileId,
    deviceId: DEVICE,
    policyName: `PL-${profileId}-IN`,
    interfaceId: 'if-1',
    customer: profileId,
    mode: 'AUTO',
    addressFamily: 'IPV4',
    direction: 'tx',
    directionSource: 'PROFILE',
    autoPromotedBySweep: true,
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
    peerAddresses: ['10.200.200.1'],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
    ...over,
  };
}

function harness(options: {
  targets: MitigationAutoTargetState[];
  executionEnabled?: boolean;
  runtimeStates?: Record<string, MitigationState>;
  counters?: Record<string, { triggerCounter: number; recoveryCounter: number }>;
  baseHour?: number;
}) {
  const executed: string[] = [];
  const runtimeStates = new Map<string, MitigationState>(
    Object.entries(options.runtimeStates ?? {}),
  );
  const persisted = new Map<string, { triggerCounter: number; recoveryCounter: number }>(
    Object.entries(options.counters ?? {}),
  );
  let tick = 0;
  const nextSample = (bps: bigint) => {
    tick += 1;
    const at = new Date(Date.UTC(2026, 9, 14, options.baseHour ?? 12, 0, tick * 10));
    return { bps, sampleKey: at.toISOString(), occurredAt: at };
  };
  const traffic: MitigationTrafficSource = {
    async sample() {
      return OVER;
    },
    async sampleWithId() {
      return nextSample(OVER);
    },
    async sampleDirectionsWithId(): Promise<MitigationDirectionsSample> {
      const tx = nextSample(OVER);
      return {
        sampleKey: tx.sampleKey,
        occurredAt: tx.occurredAt,
        rx: nextSample((BW * 10n) / 100n),
        tx,
      };
    },
  };
  const engine = new MitigationAutoEngine({
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
    targets: { list: async () => options.targets },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async (profileId) => {
        const counters = persisted.get(profileId) ?? { triggerCounter: 0, recoveryCounter: 0 };
        return {
          state: (runtimeStates.get(profileId) ?? 'NORMAL') as MitigationState,
          triggerCounter: counters.triggerCounter,
          recoveryCounter: counters.recoveryCounter,
          lastSampleAt: null,
        };
      },
      save: async (profileId, patch) => {
        const counters = persisted.get(profileId) ?? { triggerCounter: 0, recoveryCounter: 0 };
        persisted.set(profileId, {
          triggerCounter: patch.triggerCounter ?? counters.triggerCounter,
          recoveryCounter: patch.recoveryCounter ?? counters.recoveryCounter,
        });
        if (patch.state) runtimeStates.set(profileId, patch.state);
      },
    },
    commands: {
      execute: async (input) => {
        executed.push(input.profileId);
        return { ok: true, status: 'ACTIVATED_VERIFIED', verified: true };
      },
    },
    ...(options.executionEnabled === undefined
      ? {}
      : { executionControl: { enabled: options.executionEnabled } }),
  });
  const run3 = async () => {
    await engine.tick();
    await engine.tick();
    return (await engine.tick())[0]!;
  };
  return { engine, run3, executed, runtimeStates, persisted };
}

describe('AUTO: controle de execucao (autorizacao x execucao separadas)', () => {
  it('A/B) promovido pelo sweep: pausado sem execucao; ativa com execucao ligada', async () => {
    const paused = harness({ targets: [target('sweep-1')], executionEnabled: false });
    const pausedDecision = await paused.run3();
    expect(pausedDecision.outcome).toBe('WOULD_ACTIVATE');
    expect(pausedDecision.reason).toBe('AUTO_EXECUTION_DISABLED');
    expect(paused.executed).toHaveLength(0);

    const armed = harness({ targets: [target('sweep-1')], executionEnabled: true, baseHour: 13 });
    const armedDecision = await armed.run3();
    expect(armedDecision.outcome).toBe('ACTIVATED');
    expect(armed.executed).toEqual(['sweep-1']);
  });

  it('C) AUTO manual/legado (BHNET-3043, proveniencia false) NAO e pausado', async () => {
    const h = harness({
      targets: [target('bhnet-3043', { autoPromotedBySweep: false, directionSource: 'ENV' })],
      executionEnabled: false,
    });
    const decision = await h.run3();
    expect(decision.outcome).toBe('ACTIVATED');
    expect(decision.promotedBySweep).toBe(false);
    expect(h.executed).toEqual(['bhnet-3043']);
  });

  it('D/F) mitigacao ativa preservada: sem REMOVE e sem comando durante a pausa', async () => {
    const h = harness({
      targets: [target('sweep-1', { runtimeState: 'MITIGATED' })],
      executionEnabled: false,
      runtimeStates: { 'sweep-1': 'MITIGATED' },
    });
    const decision = await h.run3();
    expect(decision.outcome).toBe('NO_ACTION');
    expect(decision.reason).toBe('ALREADY_MITIGATED');
    expect(h.executed).toHaveLength(0);
    expect(h.runtimeStates.get('sweep-1')).toBe('MITIGATED');
  });

  it('G) reativacao controlada: pausa -> execucao ligada volta a ativar', async () => {
    const targets = [target('sweep-1')];
    const paused = harness({ targets, executionEnabled: false });
    await paused.run3();
    expect(paused.executed).toHaveLength(0);

    const armed = harness({
      targets,
      executionEnabled: true,
      baseHour: 14,
      runtimeStates: Object.fromEntries(paused.runtimeStates) as Record<string, MitigationState>,
    });
    const decision = await armed.run3();
    expect(decision.outcome).toBe('ACTIVATED');
  });

  it('H) reinicio simulado: contadores retomados e pausa mantida', async () => {
    const targets = [target('sweep-1')];
    const first = harness({ targets, executionEnabled: false });
    const firstDecision = await first.run3();
    expect(firstDecision.outcome).toBe('WOULD_ACTIVATE');
    expect(first.persisted.get('sweep-1')?.triggerCounter).toBeGreaterThanOrEqual(3);

    const restarted = harness({
      targets,
      executionEnabled: false,
      baseHour: 15,
      runtimeStates: Object.fromEntries(first.runtimeStates) as Record<string, MitigationState>,
      counters: Object.fromEntries(first.persisted),
    });
    const restartedDecision = await restarted.run3();
    expect(restartedDecision.outcome).toBe('WOULD_ACTIVATE');
    expect(restartedDecision.reason).toBe('AUTO_EXECUTION_DISABLED');
    expect(restarted.executed).toHaveLength(0);
    // Contadores continuam de onde pararam (persistidos no runtime).
    expect(Number(restartedDecision.samplesOver)).toBeGreaterThanOrEqual(6);
  });

  it('I) RX em perfil promovido continua MONITOR-ONLY (sem comando) com execucao off', async () => {
    const executed: string[] = [];
    let tick = 0;
    const rxHigh = new MitigationAutoEngine({
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
      targets: { list: async () => [target('sweep-rx', { direction: null })] },
      traffic: {
        async sample() {
          return null;
        },
        async sampleWithId() {
          return null;
        },
        async sampleDirectionsWithId() {
          tick += 1;
          const at = new Date(Date.UTC(2026, 9, 14, 16, 0, tick * 10));
          const sample = (bps: bigint) => ({ bps, sampleKey: at.toISOString(), occurredAt: at });
          return {
            sampleKey: at.toISOString(),
            occurredAt: at,
            rx: sample(OVER),
            tx: sample((BW * 10n) / 100n),
          };
        },
      },
      exclusions: { listPeerExclusions: async () => [] },
      runtime: {
        get: async () => ({
          state: 'NORMAL' as MitigationState,
          triggerCounter: 0,
          recoveryCounter: 0,
          lastSampleAt: null,
        }),
        save: async () => undefined,
      },
      commands: {
        execute: async (input) => {
          executed.push(input.profileId);
          return { ok: true, status: 'ACTIVATED_VERIFIED', verified: true };
        },
      },
      dualDirections: { enabled: true },
      executionControl: { enabled: false },
    });
    await rxHigh.tick();
    await rxHigh.tick();
    const decision = (await rxHigh.tick())[0]!;
    expect(decision.outcome).toBe('ALERT_TRIGGERED');
    expect(decision.reason).toBe('RX_MONITOR_ONLY');
    expect(executed).toHaveLength(0);
  });

  it('J) SEM proveniencia (ou sem controle no codigo) o promovido voltaria a atuar', async () => {
    // Simula o cenario de rollback de codigo: o binario antigo nao conhece
    // proveniencia nem controle de execucao => o perfil promovido (AUTO no
    // banco) volta a ser elegivel para NOVA ativacao. Por isso o rollback de
    // codigo exige PRIMEIRO o gate global (MITIGATION_MODE / live write).
    const semProveniencia = harness({
      targets: [target('sweep-1', { autoPromotedBySweep: false })],
    });
    const decision = await semProveniencia.run3();
    expect(decision.outcome).toBe('ACTIVATED');
    expect(semProveniencia.executed).toEqual(['sweep-1']);
  });
});
