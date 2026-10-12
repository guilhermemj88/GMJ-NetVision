import { describe, expect, it } from 'vitest';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from './mitigation-auto-engine';
import type { MitigationTrafficSample } from './mitigation-traffic-source';

// Testes da POLITICA DE LOG do motor AUTO.
//
// O motor decide a cada 5 s para dezenas de profiles; registrar a MESMA decisao
// normal a cada tick gerava ~300 MB/dia de syslog. Estes testes provam que a
// reducao de verbosidade muda SOMENTE a emissao de log: as decisoes, contadores
// e motivos continuam identicos (comparacao direta com um motor sem logger).

const NOW_MS = Date.parse('2026-10-12T12:00:00.000Z');
const DEVICE = 'device-1';

function target(overrides: Partial<MitigationAutoTargetState> = {}): MitigationAutoTargetState {
  return {
    profileId: 'profile-1',
    deviceId: DEVICE,
    interfaceId: 'if-1',
    customer: 'Cliente',
    mode: 'AUTO',
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
    recoveryPercent: 50,
    triggerSamples: 3,
    recoverySamples: 3,
    ...overrides,
  };
}

interface LogLine {
  message: string;
  meta: Record<string, unknown>;
}

interface HarnessOptions {
  targets: MitigationAutoTargetState[];
  samples?: (MitigationTrafficSample | null)[];
  failTraffic?: boolean;
  summaryIntervalMs?: number;
  transitionThrottleMs?: number;
  withLogger?: boolean;
}

function harness(options: HarnessOptions) {
  const info: LogLine[] = [];
  const debug: LogLine[] = [];
  const clock = { ms: NOW_MS };
  const samples = [...(options.samples ?? [])];
  const engine = new MitigationAutoEngine({
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
    targets: { list: async () => options.targets },
    traffic: {
      sample: async () => null,
      sampleWithId: async () => {
        if (options.failTraffic) throw new Error('leitura de telemetria falhou');
        return samples.shift() ?? null;
      },
    },
    exclusions: { listPeerExclusions: async () => [] },
    runtime: { get: async () => null, save: async () => undefined },
    commands: {
      execute: async () => ({ ok: false, status: 'NAO_CHAMADO', verified: false }),
    },
    now: () => new Date(clock.ms),
    ...(options.withLogger === false
      ? {}
      : {
          logger: (message: string, meta?: Record<string, unknown>) =>
            info.push({ message, meta: meta ?? {} }),
          debugLogger: (message: string, meta?: Record<string, unknown>) =>
            debug.push({ message, meta: meta ?? {} }),
        }),
    ...(options.summaryIntervalMs === undefined
      ? {}
      : { summaryIntervalMs: options.summaryIntervalMs }),
    ...(options.transitionThrottleMs === undefined
      ? {}
      : { transitionThrottleMs: options.transitionThrottleMs }),
  });
  return { engine, info, debug, clock, samples };
}

const decisionsOf = (lines: LogLine[]) => lines.filter((line) => line.message === 'auto: decisao');
const summariesOf = (lines: LogLine[]) =>
  lines.filter((line) => line.message === 'auto: resumo de decisoes');

describe('politica de log do motor AUTO', () => {
  it('1) decisao normal repetida nao gera linha INFO a cada tick', async () => {
    const h = harness({ targets: [target({ mode: 'DISABLED' })] });
    await h.engine.tick();
    h.clock.ms += 5_000;
    await h.engine.tick();
    h.clock.ms += 5_000;
    await h.engine.tick();

    expect(decisionsOf(h.info)).toHaveLength(1);
    expect(decisionsOf(h.info)[0]!.meta.reason).toBe('PROFILE_DISABLED');
    // DEBUG continua com o detalhe de TODOS os ticks.
    expect(h.debug).toHaveLength(3);
  });

  it('2) mudanca de motivo de bloqueio e registrada', async () => {
    const mutable = target();
    const h = harness({ targets: [mutable] });
    await h.engine.tick();
    expect(decisionsOf(h.info)).toHaveLength(1);

    // Mesmo resultado, motivo diferente (snapshot do discovery caiu).
    Object.assign(mutable, {
      snapshotAvailable: false,
    } satisfies Partial<MitigationAutoTargetState>);
    h.clock.ms += 60_000;
    await h.engine.tick();

    const lines = decisionsOf(h.info);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.meta.reason).toBe('SNAPSHOT_UNAVAILABLE');

    // Repeticao do novo motivo volta a ser suprimida.
    h.clock.ms += 60_000;
    await h.engine.tick();
    expect(decisionsOf(h.info)).toHaveLength(2);
  });

  it('3) transicao dentro do silencio minimo nao vira linha (e entra no resumo)', async () => {
    const mutable = target({ mode: 'DISABLED' });
    const h = harness({
      targets: [mutable],
      summaryIntervalMs: 1_000,
      transitionThrottleMs: 30_000,
    });
    await h.engine.tick();
    expect(decisionsOf(h.info)).toHaveLength(1);

    // 5 s depois o motivo muda: throttle impede a linha.
    Object.assign(mutable, { mode: 'AUTO' } satisfies Partial<MitigationAutoTargetState>);
    h.clock.ms += 5_000;
    await h.engine.tick();
    expect(decisionsOf(h.info)).toHaveLength(1);

    const summaries = summariesOf(h.info);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(Number(summaries.at(-1)!.meta.suppressed)).toBeGreaterThanOrEqual(1);

    // Passado o throttle, a transicao pendente e emitida.
    h.clock.ms += 60_000;
    await h.engine.tick();
    const lines = decisionsOf(h.info);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.at(-1)!.meta.reason).toBe('TELEMETRY_UNAVAILABLE');
  });

  it('4) transicao de estado do runtime (RECONCILIATION_REQUIRED) e registrada', async () => {
    const mutable = target();
    const h = harness({ targets: [mutable] });
    await h.engine.tick();

    Object.assign(mutable, {
      runtimeState: 'RECONCILIATION_REQUIRED',
    } satisfies Partial<MitigationAutoTargetState>);
    h.clock.ms += 60_000;
    await h.engine.tick();

    const lines = decisionsOf(h.info);
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)!.meta.runtimeState).toBe('RECONCILIATION_REQUIRED');
  });

  it('5) falha de telemetria/excecao e SEMPRE registrada', async () => {
    const h = harness({ targets: [target()], failTraffic: true });
    await h.engine.tick();
    h.clock.ms += 5_000;
    await h.engine.tick();

    const lines = decisionsOf(h.info);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.meta.outcome).toBe('FAILED');
      expect(line.meta.reason).toBe('ACTIVATE_FAILED');
    }
  });

  it('6) resumo periodico agrega as decisoes suprimidas', async () => {
    const h = harness({
      targets: [target({ mode: 'DISABLED' })],
      summaryIntervalMs: 1_000,
    });
    await h.engine.tick();
    h.clock.ms += 2_000;
    await h.engine.tick();
    h.clock.ms += 2_000;
    await h.engine.tick();

    const summaries = summariesOf(h.info);
    expect(summaries).toHaveLength(2);
    expect(Number(summaries[0]!.meta.decisions)).toBe(2);
    expect(Number(summaries[0]!.meta.suppressed)).toBe(1);
    expect(summaries[0]!.meta.byOutcome).toEqual({ BLOCKED: 2 });
    expect(summaries[0]!.meta.byReason).toEqual({ PROFILE_DISABLED: 2 });
    expect(Number(summaries[1]!.meta.decisions)).toBe(1);
  });

  it('7) a decisao devolvida e identica com e sem logger', async () => {
    const project = (decisions: Awaited<ReturnType<MitigationAutoEngine['tick']>>) =>
      decisions.map((decision) => ({
        profileId: decision.profileId,
        outcome: decision.outcome,
        reason: decision.reason,
        trafficBps: decision.trafficBps,
        thresholdBps: decision.thresholdBps,
        samplesOver: decision.samplesOver,
        samplesBelow: decision.samplesBelow,
        runtimeState: decision.runtimeState,
      }));

    const withLog = harness({ targets: [target()], failTraffic: true });
    const withoutLog = harness({ targets: [target()], failTraffic: true, withLogger: false });
    const a = project(await withLog.engine.tick());
    const b = project(await withoutLog.engine.tick());
    expect(a).toEqual(b);
    expect(withLog.info.length).toBeGreaterThan(0);
    expect(withoutLog.info).toHaveLength(0);
  });
});
