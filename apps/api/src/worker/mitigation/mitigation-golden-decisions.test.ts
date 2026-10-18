/**
 * GOLDEN DECISIONS — equivalência entre a API publicada (`fc790ad`) e a RC2.
 *
 * Cada cenário roda o MESMO roteiro de amostras/estados nos dois motores e exige
 * decisões idênticas (outcome, reason e contadores). Diferenças só são aceitas
 * nas duas exceções deliberadas documentadas no relatório da RC2:
 *   1. retry limitado da mesma amostra depois de falha transitória (§4);
 *   2. cooldown medido no FIM da execução, com backoff de falha (§5).
 */
import { describe, expect, it } from 'vitest';
import type { MitigationAutoTargetState } from './mitigation-auto-engine';
import {
  BASE_TIME,
  defaultTarget,
  Runner,
  runScenario,
  summarize,
  type ScenarioOptions,
  type Step,
} from '../../testing/mitigation-engine-harness';

const over = 9_500_000_000n;
const under = 3_000_000_000n;
const exact = 9_000_000_000n;

const at = (offsetMs: number) => BASE_TIME + offsetMs;

/** Três confirmações com o intervalo informado, mais um tick repetindo a última. */
const cadence = (intervalMs: number): Step[] => [
  { at: at(0), sample: { bps: over, atMs: at(0) } },
  { at: at(1_000) },
  { at: at(intervalMs), sample: { bps: over, atMs: at(intervalMs) } },
  { at: at(intervalMs * 2), sample: { bps: over, atMs: at(intervalMs * 2) } },
  { at: at(intervalMs * 2 + 1_000) },
];

const compare = async (options: ScenarioOptions, steps: Step[], label: string) => {
  const { baseline, rc2 } = await runScenario(options, steps);
  expect(rc2.decisions, `${label}\nbaseline: ${summarize(baseline)}\nrc2: ${summarize(rc2)}`).toEqual(
    baseline.decisions,
  );
  return { baseline, rc2 };
};

describe('GOLDEN: LEGACY mantém decisões idênticas às publicadas', () => {
  it('cadência real de 126 s: três confirmações e um único ACTIVATE', async () => {
    const { rc2 } = await compare({}, cadence(126_000), '126s');
    // Sem regra de continuidade, LEGACY preserva a reemissão idempotente do
    // MESMO comando enquanto o runtime não confirmar MITIGATED.
    expect(rc2.decisions.map((d) => d.outcome)).toEqual([
      'TRIGGER_PENDING',
      'TRIGGER_PENDING',
      'TRIGGER_PENDING',
      'ACTIVATED',
      'ACTIVATED',
    ]);
    expect(new Set(rc2.commandCalls.map((c) => c.requestId)).size).toBe(1);
  });

  it('cadência de 248 s: três confirmações e um único ACTIVATE', async () => {
    const { rc2 } = await compare({}, cadence(248_000), '248s');
    expect(new Set(rc2.commandCalls.map((c) => c.requestId)).size).toBe(1);
    expect(rc2.decisions.at(-2)?.outcome).toBe('ACTIVATED');
  });

  it('fronteira de frescor 599/600/601 s', async () => {
    for (const ageMs of [599_000, 600_000, 601_000]) {
      const steps: Step[] = [
        { at: at(0), sample: { bps: over, atMs: at(-ageMs), rateStartAtMs: null } },
      ];
      const { rc2 } = await compare({}, steps, `frescor ${ageMs}`);
      expect(rc2.decisions[0]!.outcome).toBe(ageMs <= 600_000 ? 'TRIGGER_PENDING' : 'BLOCKED');
    }
  });

  it('sem regra de continuidade: lacuna de 601 s não zera confirmações', async () => {
    const steps: Step[] = [
      { at: at(0), sample: { bps: over, atMs: at(0), rateStartAtMs: at(0) - 601_000 } },
      { at: at(601_000), sample: { bps: over, atMs: at(601_000), rateStartAtMs: at(0) } },
      { at: at(1_202_000), sample: { bps: over, atMs: at(1_202_000), rateStartAtMs: at(601_000) } },
    ];
    const { rc2 } = await compare({}, steps, 'lacuna 601s');
    expect(rc2.decisions.map((d) => d.samplesOver)).toEqual([1, 2, 3]);
    expect(rc2.decisions.at(-1)!.outcome).toBe('ACTIVATED');
  });

  it('amostra repetida em três ticks conta uma única vez', async () => {
    const steps: Step[] = [
      { at: at(0), sample: { bps: over, atMs: at(0) } },
      { at: at(1_000) },
      { at: at(2_000) },
    ];
    const { rc2 } = await compare({}, steps, 'duplicada');
    expect(rc2.decisions.map((d) => d.samplesOver)).toEqual([1, 1, 1]);
    expect(rc2.decisions.every((d) => d.outcome === 'TRIGGER_PENDING')).toBe(true);
  });

  it('amostra stale não conta e não escreve', async () => {
    const steps: Step[] = [
      { at: at(0), sample: { bps: over, atMs: at(-900_000), rateStartAtMs: null } },
      { at: at(1_000) },
    ];
    const { rc2 } = await compare({}, steps, 'stale');
    expect(rc2.decisions.every((d) => d.reason === 'TELEMETRY_UNAVAILABLE')).toBe(true);
    expect(rc2.commandCalls).toHaveLength(0);
  });

  it('restart entre confirmações preserva identidade e exige uma confirmação nova', async () => {
    const baseline = new Runner({}, true);
    const rc2 = new Runner({}, false);
    const first: Step[] = [
      { at: at(0), sample: { bps: over, atMs: at(0) } },
      { at: at(126_000), sample: { bps: over, atMs: at(126_000) } },
    ];
    const beforeBaseline = await baseline.run(first);
    const beforeRc2 = await rc2.run(first);
    expect(beforeRc2.decisions.map((d) => d.samplesOver)).toEqual([1, 2]);
    expect(beforeRc2.decisions).toEqual(beforeBaseline.decisions);

    baseline.restart();
    rc2.restart();
    const afterBaseline = await baseline.run([
      { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
    ]);
    const afterRc2 = await rc2.run([
      { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
    ]);
    // Confirmações anteriores sobrevivem enquanto a evidência é fresca: a
    // amostra nova completa a sequência nos dois motores.
    expect(afterBaseline.decisions[0]!.outcome).toBe('ACTIVATED');
    expect(afterRc2.decisions[0]!.outcome).toBe('ACTIVATED');
  });

  it('restart com gatilho já confirmado não ativa sem amostra nova (diferença deliberada)', async () => {
    const steps: Step[] = [
      { at: at(0), sample: { bps: over, atMs: at(0) } },
      { at: at(126_000), sample: { bps: over, atMs: at(126_000) } },
      { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
    ];
    const commandResults = Array.from({ length: 4 }, () => ({
      ok: false,
      status: 'ACTIVATE_FAILED',
      verified: false,
    }));
    const baseline = new Runner({ commandResults }, true);
    const rc2 = new Runner({ commandResults }, false);
    await baseline.run(steps);
    await rc2.run(steps);
    expect(baseline.runtime.stateOf('bhnet-3043')).toBe('TRIGGER_PENDING');
    const baselineCalls = baseline.calls.length;
    const rc2Calls = rc2.calls.length;

    baseline.restart();
    rc2.restart();
    // Mesma amostra, sem amostra nova depois do restart.
    await baseline.run([{ at: at(252_500) }]);
    const afterRc2 = await rc2.run([{ at: at(252_500) }]);
    // A versão publicada reemite o comando com o contador persistido; a RC2
    // reidrata no máximo `triggerSamples - 1` e exige confirmação nova.
    expect(baseline.calls.length).toBe(baselineCalls + 1);
    expect(rc2.calls.length).toBe(rc2Calls);
    expect(afterRc2.decisions[0]!.outcome).toBe('TRIGGER_PENDING');
    expect(afterRc2.decisions[0]!.samplesOver).toBe(2);
  });

  it('restart com evidência antiga não reidrata confirmações', async () => {
    const runner = new Runner({}, false);
    await runner.run([{ at: at(0), sample: { bps: over, atMs: at(0) } }]);
    runner.restart();
    const result = await runner.run([
      { at: at(900_000), sample: { bps: over, atMs: at(900_000) } },
    ]);
    expect(result.decisions[0]!.samplesOver).toBe(1);
  });

  it('limiar: abaixo, exato e acima', async () => {
    const steps: Step[] = [
      { at: at(0), sample: { bps: under, atMs: at(0) } },
      { at: at(126_000), sample: { bps: exact, atMs: at(126_000) } },
      { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
      { at: at(378_000), sample: { bps: over, atMs: at(378_000) } },
      { at: at(504_000), sample: { bps: over, atMs: at(504_000) } },
    ];
    const { rc2 } = await compare({}, steps, 'limiar');
    expect(rc2.decisions.map((d) => d.reason)).toEqual([
      'THRESHOLD_NOT_EXCEEDED',
      'THRESHOLD_NOT_EXCEEDED',
      'SAMPLES_INSUFFICIENT',
      'SAMPLES_INSUFFICIENT',
      null,
    ]);
    expect(rc2.decisions.at(-1)!.outcome).toBe('ACTIVATED');
  });

  it('AUTO promovido com execução desligada permanece bloqueado', async () => {
    const { baseline, rc2 } = await compare(
      { target: { autoPromotedBySweep: true }, executionControl: { enabled: false } },
      cadence(126_000),
      'promovido',
    );
    expect(rc2.decisions.at(-2)!.reason).toBe('AUTO_EXECUTION_DISABLED');
    expect(rc2.decisions.at(-2)!.outcome).toBe('WOULD_ACTIVATE');
    expect(rc2.commandCalls).toHaveLength(0);
    expect(baseline.commandCalls).toHaveLength(0);
  });

  it('AUTO manual não é afetado pelo controle de execução', async () => {
    const { rc2 } = await compare(
      { target: { autoPromotedBySweep: false }, executionControl: { enabled: false } },
      cadence(126_000),
      'manual',
    );
    expect(new Set(rc2.commandCalls.map((c) => c.requestId)).size).toBe(1);
  });

  it('ALERT_ONLY alerta sem escrever', async () => {
    const { rc2 } = await compare({ target: { mode: 'ALERT_ONLY' } }, cadence(126_000), 'alert-only');
    expect(rc2.decisions.at(-2)!.outcome).toBe('ALERT_TRIGGERED');
    expect(rc2.commandCalls).toHaveLength(0);
  });

  it('perfil já MITIGATED não recebe novo comando', async () => {
    const { rc2 } = await compare({ target: { runtimeState: 'MITIGATED' } }, cadence(126_000), 'mitigated');
    expect(rc2.decisions.every((d) => d.outcome === 'NO_ACTION')).toBe(true);
    expect(rc2.decisions[0]!.reason).toBe('ALREADY_MITIGATED');
    expect(rc2.commandCalls).toHaveLength(0);
  });

  it('policy compartilhada com irmão mitigado não instala segundo par', async () => {
    const sibling = defaultTarget({
      profileId: 'bhnet-rbn',
      interfaceId: 'if3044',
      customer: 'BHNET-RBN',
      autoPromotedBySweep: true,
      runtimeState: 'MITIGATED',
    });
    const steps: Step[] = [
      { at: at(0), sample: { bps: over, atMs: at(0) } },
      { at: at(126_000), sample: { bps: over, atMs: at(126_000) } },
      { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
    ];
    const { rc2 } = await compare({ siblings: [sibling] }, steps, 'shared-policy');
    expect(rc2.decisions.at(-1)!.reason).toBe('SCOPE_ALREADY_MITIGATED');
    expect(rc2.commandCalls).toHaveLength(0);
  });

  it('sem telemetria (direção ausente) não escreve', async () => {
    const steps: Step[] = [{ at: at(0), sample: null }];
    const { rc2 } = await compare({}, steps, 'sem telemetria');
    expect(rc2.decisions[0]!.reason).toBe('TELEMETRY_UNAVAILABLE');
  });

  it('gates de elegibilidade permanecem idênticos', async () => {
    const cases: Array<Partial<MitigationAutoTargetState>> = [
      { mode: 'DISABLED' },
      { snapshotAvailable: false },
      { readiness: 'NOT_READY' },
      { prefixStatus: 'EXCEEDED' },
      { blockedReason: 'SYNTHETIC' },
      { mitigationExcluded: true },
      { effectiveBandwidthBps: null },
      { bogonNode: null },
    ];
    for (const [index, target] of cases.entries()) {
      const { rc2 } = await compare(
        { target },
        [{ at: at(0), sample: { bps: over, atMs: at(0) } }],
        `gate ${index}`,
      );
      expect(rc2.commandCalls).toHaveLength(0);
    }
  });

  it('modo global/executor sem escrita também é equivalente', async () => {
    for (const options of [
      { globalMode: 'SIMULATION_ONLY' },
      { executor: 'MOCK' },
      { liveWrite: false },
      { allowedDeviceIds: ['outro-device'] },
    ] satisfies ScenarioOptions[]) {
      const steps: Step[] = [
        { at: at(0), sample: { bps: over, atMs: at(0) } },
        { at: at(126_000), sample: { bps: over, atMs: at(126_000) } },
        { at: at(252_000), sample: { bps: over, atMs: at(252_000) } },
      ];
      await compare(options, steps, `autorização ${JSON.stringify(options)}`);
    }
  });

  it('comando que devolve ACTIVATED_NOT_VERIFIED é registrado igual', async () => {
    const { rc2 } = await compare(
      {
        commandResults: [{ ok: true, status: 'ACTIVATED_NOT_VERIFIED', verified: false }],
      },
      cadence(126_000),
      'verify-failed',
    );
    const last = rc2.decisions.at(-2)!;
    expect(last.outcome).toBe('FAILED');
    expect(last.reason).toBe('VERIFY_FAILED');
  });

  it('confirma que o ACTIVATE carrega evidência de amostra para revalidação', async () => {
    const { rc2 } = await compare({}, cadence(126_000), 'evidência');
    expect(rc2.commandCalls.length).toBeGreaterThan(0);
    expect(rc2.commandCalls[0]!.autoEvidence).toMatchObject({
      sampleAt: new Date(at(252_000)).toISOString(),
      continuityKey: 'ne8000:if3043:200:tx',
    });
  });
});
