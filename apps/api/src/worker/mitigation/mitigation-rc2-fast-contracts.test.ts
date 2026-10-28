/**
 * Contratos da RC2 que NÃO existiam na versão publicada, e por isso são testados
 * aqui (e não na equivalência GOLDEN):
 *  - janela FAST estrita (30 s/45 s) e reset por lacuna;
 *  - retry limitado da MESMA amostra após falha transitória;
 *  - cooldown/backoff apenas no caminho FAST, medido no fim da execução;
 *  - SHADOW isolado, com estado físico reportado separadamente;
 *  - exigência de leitura de runtime somente para a fonte FAST.
 */
import { describe, expect, it } from 'vitest';
import { BASE_TIME, Runner, type ScenarioOptions, type Step } from '../../testing/mitigation-engine-harness';

const over = 9_500_000_000n;
const at = (offsetMs: number) => BASE_TIME + offsetMs;

const FAST = { maxAgeMs: 30_000, maxGapMs: 45_000 as number | null };
const fastSampling = () => FAST;
const run = async (options: ScenarioOptions, steps: Step[]) =>
  new Runner({ sampling: fastSampling, ...options }, false).run(steps);

/** Amostra FAST real: janela de contadores de 10 s. */
const fastSample = (timeMs: number) => ({
  bps: over,
  atMs: timeMs,
  rateStartAtMs: timeMs - 10_000,
});

const threeFastSamples: Step[] = [
  { at: at(0), sample: fastSample(at(0)) },
  { at: at(10_000), sample: fastSample(at(10_000)) },
  { at: at(20_000), sample: fastSample(at(20_000)) },
];

describe('FAST: janela estrita de 30 s / 45 s', () => {
  it('três amostras em 10 s ativam e a repetição da amostra não reemite', async () => {
    const result = await run({}, [...threeFastSamples, { at: at(21_000) }]);
    expect(result.decisions.map((d) => d.outcome)).toEqual([
      'TRIGGER_PENDING',
      'TRIGGER_PENDING',
      'ACTIVATED',
      'SKIPPED',
    ]);
    expect(result.decisions.at(-1)!.reason).toBe('DUPLICATE_SAMPLE');
    expect(result.commandCalls).toHaveLength(1);
    expect(result.commandCalls[0]!.requestId).toMatch(/^auto-activate-.*-[0-9a-f]{12}$/);
  });

  it('lacuna maior que 45 s zera a sequência', async () => {
    const result = await run({}, [
      { at: at(0), sample: fastSample(at(0)) },
      { at: at(46_000), sample: fastSample(at(46_000)) },
    ]);
    expect(result.decisions.map((d) => d.samplesOver)).toEqual([1, 1]);
  });

  it('amostra com 31 s não é aceita', async () => {
    const result = await run({}, [
      { at: at(0), sample: { bps: over, atMs: at(-31_000), rateStartAtMs: at(-41_000) } },
    ]);
    expect(result.decisions[0]!.reason).toBe('TELEMETRY_UNAVAILABLE');
  });

  it('restart em FAST nunca reidrata confirmações', async () => {
    const runner = new Runner({ sampling: fastSampling }, false);
    await runner.run(threeFastSamples.slice(0, 2));
    runner.restart();
    const result = await runner.run([{ at: at(20_000), sample: fastSample(at(20_000)) }]);
    expect(result.decisions[0]!.samplesOver).toBe(1);
  });
});

describe('DUPLICATE_SAMPLE: retry limitado da mesma amostra', () => {
  it('falha transitória é reavaliada com a MESMA amostra e o MESMO requestId', async () => {
    const result = await run(
      {
        failureBackoffMs: 5_000,
        commandResults: [
          { ok: false, status: 'POLICY_BUSY', verified: false },
          { ok: true, status: 'ACTIVATED_VERIFIED', verified: true },
        ],
      },
      [...threeFastSamples, { at: at(26_000) }],
    );
    expect(result.decisions[2]!.outcome).toBe('FAILED');
    expect(result.decisions[2]!.reason).toBe('POLICY_BUSY');
    const retry = result.decisions[3]!;
    expect(retry.outcome).toBe('ACTIVATED');
    expect(retry.samplesOver).toBe(3);
    expect(result.commandCalls).toHaveLength(2);
    expect(result.commandCalls[0]!.requestId).toBe(result.commandCalls[1]!.requestId);
  });

  it('retry respeita o limite por amostra', async () => {
    const failures = Array.from({ length: 4 }, () => ({
      ok: false,
      status: 'POLICY_BUSY',
      verified: false,
    }));
    const result = await run(
      { failureBackoffMs: 5_000, maxRetriesPerSample: 1, commandResults: failures },
      [...threeFastSamples, { at: at(25_000) }, { at: at(30_000) }],
    );
    expect(result.commandCalls).toHaveLength(2);
    expect(result.decisions.at(-1)!.reason).toBe('DUPLICATE_SAMPLE');
  });

  it('retry exige evidência dentro da janela da fonte', async () => {
    const failures = Array.from({ length: 2 }, () => ({
      ok: false,
      status: 'ACTIVATE_FAILED',
      verified: false,
    }));
    const result = await run(
      { failureBackoffMs: 5_000, commandResults: failures },
      [...threeFastSamples, { at: at(61_000) }],
    );
    expect(result.commandCalls).toHaveLength(1);
    expect(result.decisions.at(-1)!.reason).toBe('TELEMETRY_UNAVAILABLE');
  });
});

describe('cooldown/backoff (somente FAST)', () => {
  it('cooldown de sucesso bloqueia reemissão imediata com amostra nova', async () => {
    const result = await run({}, [
      ...threeFastSamples,
      { at: at(21_000), sample: fastSample(at(21_000)) },
    ]);
    expect(result.decisions.at(-1)!.reason).toBe('ACTIVATION_COOLDOWN');
    expect(result.commandCalls).toHaveLength(1);
  });

  it('falha usa backoff curto, não a janela cheia de sucesso', async () => {
    const failures = Array.from({ length: 2 }, () => ({
      ok: false,
      status: 'POLICY_BUSY',
      verified: false,
    }));
    const result = await run(
      { failureBackoffMs: 5_000, activationCooldownMs: 30_000, commandResults: failures },
      [...threeFastSamples, { at: at(21_000) }, { at: at(26_000) }],
    );
    expect(result.decisions[3]!.reason).toBe('ACTIVATION_COOLDOWN');
    expect(result.decisions[4]!.outcome).toBe('FAILED');
    expect(result.commandCalls).toHaveLength(2);
  });

  it('LEGACY não recebe cooldown nem DUPLICATE_SAMPLE', async () => {
    const result = await new Runner({ failureBackoffMs: 5_000 }, false).run([
      { at: at(0), sample: { bps: over, atMs: at(0) } },
      { at: at(126_000), sample: { bps: over, atMs: at(126_000) } },
      { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
      { at: at(253_000) },
    ]);
    expect(result.decisions.map((d) => d.outcome)).toEqual([
      'TRIGGER_PENDING',
      'TRIGGER_PENDING',
      'ACTIVATED',
      'ACTIVATED',
    ]);
    expect(result.decisions.every((d) => d.reason !== 'ACTIVATION_COOLDOWN')).toBe(true);
    expect(new Set(result.commandCalls.map((c) => c.requestId)).size).toBe(1);
  });
});

describe('SHADOW: hipótese isolada do estado físico', () => {
  it('perfil já MITIGATED produz WOULD_ACTIVATE hipotético sem tocar o runtime', async () => {
    const result = await run(
      { evaluationScope: 'SHADOW', target: { runtimeState: 'MITIGATED' } },
      [...threeFastSamples, { at: at(21_000) }],
    );
    const last = result.raw.at(-1)!;
    expect(last.outcome).toBe('WOULD_ACTIVATE');
    expect(last.reason).toBeNull();
    expect(last.samplesOver).toBe(3);
    expect(last.evaluationScope).toBe('SHADOW');
    expect(last.physicalState).toBe('MITIGATED');
    expect(last.physicalMitigated).toBe(true);
    expect(last.retryAttempt).toBeNull();
    expect(result.commandCalls).toHaveLength(0);
    // O estado físico nunca é alterado pela simulação.
    expect(result.runtime.stateOf('bhnet-3043')).toBe('TRIGGER_PENDING');
  });

  it('bloqueio operacional real aparece ao lado da hipótese', async () => {
    const result = await run(
      {
        evaluationScope: 'SHADOW',
        target: { runtimeState: 'MITIGATED', autoPromotedBySweep: true },
        executionControl: { enabled: false },
      },
      threeFastSamples,
    );
    const last = result.raw.at(-1)!;
    expect(last.outcome).toBe('WOULD_ACTIVATE');
    expect(last.operationalBlock).toBe('AUTO_EXECUTION_DISABLED');
    expect(result.commandCalls).toHaveLength(0);
  });

  it('o motor operacional continua bloqueando o perfil já mitigado', async () => {
    const result = await run({ target: { runtimeState: 'MITIGATED' } }, threeFastSamples);
    expect(result.decisions.every((d) => d.reason === 'ALREADY_MITIGATED')).toBe(true);
    expect(result.commandCalls).toHaveLength(0);
  });
});

describe('leitura de runtime: exigência apenas para a fonte FAST', () => {
  it('LEGACY não ganha bloqueio novo quando a leitura fresca falha', async () => {
    const runner = new Runner({ requireRuntimeRead: () => false }, false);
    await runner.run([{ at: at(0), sample: { bps: over, atMs: at(0) } }]);
    runner.failRuntimeReads();
    const result = await runner.run([{ at: at(126_000) }]);
    expect(result.decisions[0]!.reason).not.toBe('RUNTIME_UNAVAILABLE');
    expect(result.decisions[0]!.samplesOver).toBe(1);
  });

  it('FAST continua fail-closed quando a leitura fresca falha', async () => {
    const runner = new Runner({ sampling: fastSampling, requireRuntimeRead: () => true }, false);
    await runner.run([{ at: at(0), sample: fastSample(at(0)) }]);
    runner.failRuntimeReads();
    const result = await runner.run([{ at: at(10_000), sample: fastSample(at(10_000)) }]);
    expect(result.decisions[0]!.reason).toBe('RUNTIME_UNAVAILABLE');
  });
});

describe('AUTO promovido e manual: kill switch global (SAFETY-GATES-03)', () => {
  it('flag desligada bloqueia promovido E manual, com a mesma fonte FAST', async () => {
    const promoted = await run(
      { target: { autoPromotedBySweep: true }, executionControl: { enabled: false } },
      threeFastSamples,
    );
    expect(promoted.decisions.at(-1)!.reason).toBe('AUTO_EXECUTION_DISABLED');
    expect(promoted.commandCalls).toHaveLength(0);

    const manual = await run(
      { target: { autoPromotedBySweep: false }, executionControl: { enabled: false } },
      threeFastSamples,
    );
    expect(manual.decisions.at(-1)!.reason).toBe('AUTO_EXECUTION_DISABLED');
    expect(manual.commandCalls).toHaveLength(0);

    const enabled = await run(
      { target: { autoPromotedBySweep: false }, executionControl: { enabled: true } },
      threeFastSamples,
    );
    expect(enabled.commandCalls).toHaveLength(1);
  });

  it('SHADOW reporta o bloqueio operacional tambem para AUTO manual', async () => {
    const result = await run(
      {
        evaluationScope: 'SHADOW',
        target: { runtimeState: 'MITIGATED', autoPromotedBySweep: false },
        executionControl: { enabled: false },
      },
      threeFastSamples,
    );
    const last = result.raw.at(-1)!;
    expect(last.outcome).toBe('WOULD_ACTIVATE');
    expect(last.operationalBlock).toBe('AUTO_EXECUTION_DISABLED');
    expect(result.commandCalls).toHaveLength(0);
  });
});
