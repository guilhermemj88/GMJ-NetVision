/**
 * Harness ISOLADO de equivalência entre o motor publicado (`fc790ad`) e a RC2.
 *
 * Nenhum transporte real: a fonte de tráfego é um roteiro em memória, o runtime
 * é um mapa local e o executor devolve resultados sintéticos. O objetivo é
 * comparar decisões, não exercitar SSH/SQL.
 */
import type { MitigationMode, MitigationState } from '../infrastructure/bgp/mitigation/mitigation-types';
import type { MitigationExecutorKind } from '../infrastructure/bgp/mitigation/mitigation-execution-config';
import type {
  MitigationAutoDecision,
  MitigationAutoTargetState,
} from '../worker/mitigation/mitigation-auto-engine';
import type { MitigationSamplingWindow } from '../worker/mitigation/mitigation-sampling-policy';
import type { MitigationTrafficSample } from '../worker/mitigation/mitigation-traffic-source';
import { MitigationAutoEngine } from '../worker/mitigation/mitigation-auto-engine';
import { MitigationAutoEngine as LegacyAutoEngine } from '../worker/mitigation/legacy-auto-engine.fc790ad';

export const BASE_TIME = Date.parse('2026-10-18T14:00:00Z');

export interface SampleInput {
  bps: bigint;
  /** Instante da amostra (ms). Padrão: instante do passo. */
  atMs?: number;
  /** Início da janela de contadores (ms). Padrão: `atMs - 126_000`. */
  rateStartAtMs?: number | null;
  /** Identidade; padrão derivado do instante. */
  key?: string;
  continuityKey?: string;
}

export interface Step {
  /** Instante da avaliação (ms). */
  at: number;
  /**
   * `undefined` = repete a última amostra (mesmo identity);
   * `null` = fonte sem amostra (TELEMETRY_UNAVAILABLE).
   */
  sample?: SampleInput | null;
}

export interface ScenarioOptions {
  target?: Partial<MitigationAutoTargetState>;
  siblings?: MitigationAutoTargetState[];
  executionControl?: { enabled: boolean };
  globalMode?: MitigationMode;
  executor?: MitigationExecutorKind;
  liveWrite?: boolean;
  allowedDeviceIds?: readonly string[];
  requireRuntimeRead?: boolean | ((target: MitigationAutoTargetState) => boolean);
  sampling?: (target: MitigationAutoTargetState) => MitigationSamplingWindow;
  /** Resultados devolvidos pelo comando, na ordem das chamadas. */
  commandResults?: Array<{
    ok: boolean;
    status: string;
    verified: boolean;
    safeError?: string;
  }>;
  runtimeState?: MitigationState;
  evaluationScope?: 'OPERATIONAL' | 'SHADOW';
  activationCooldownMs?: number;
  failureBackoffMs?: number;
  maxFailureBackoffMs?: number;
  maxRetriesPerSample?: number;
  /** Simula falha de leitura do runtime (`runtime.get` lança). */
  runtimeReadFails?: boolean;
  /** Falha a partir da N-ésima chamada (0-based) a `runtime.get`. */
  runtimeReadFailsFromCall?: number;
}

export const defaultTarget = (
  overrides: Partial<MitigationAutoTargetState> = {},
): MitigationAutoTargetState => ({
  profileId: 'bhnet-3043',
  deviceId: 'ne8000',
  policyName: 'PL-BHNET_IPv4-IN',
  interfaceId: 'if3043',
  customer: 'BHNET',
  mode: 'AUTO',
  addressFamily: 'IPV4',
  direction: 'tx',
  directionSource: 'ENV',
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
  ...overrides,
});

class ScriptedSource {
  private current: MitigationTrafficSample | null = null;
  constructor(private readonly maxAgeMs = 600_000) {}
  push(input: SampleInput, atMs: number): void {
    const occurredAt = new Date(input.atMs ?? atMs);
    const rateStartAt =
      input.rateStartAtMs === null
        ? null
        : new Date(input.rateStartAtMs ?? occurredAt.getTime() - 126_000);
    this.current = {
      bps: input.bps,
      sampleKey: input.key ?? occurredAt.toISOString(),
      occurredAt,
      rateStartAt,
      continuityKey: input.continuityKey ?? 'ne8000:if3043:200:tx',
    };
  }
  clear(): void {
    this.current = null;
  }
  /**
   * Reproduz o filtro da fonte publicada (`InterfaceTrafficSource.validRow`):
   * idade máxima de 600 s e taxa não negativa. Sem ele o motor veria amostras
   * que jamais chegam a ele em produção.
   */
  private usable(atMs: number, sample: MitigationTrafficSample | null): MitigationTrafficSample | null {
    if (!sample || sample.bps < 0n) return null;
    if (!sample.occurredAt) return sample;
    const age = atMs - sample.occurredAt.getTime();
    return Number.isFinite(age) && age >= 0 && age <= this.maxAgeMs ? sample : null;
  }
  async sampleWithId(): Promise<MitigationTrafficSample | null> {
    return this.usable(this.clockMs(), this.current);
  }
  async sample(): Promise<bigint | null> {
    return (await this.sampleWithId())?.bps ?? null;
  }
  async sampleDirectionsWithId(): Promise<never> {
    throw new Error('DUAL_NAO_SUPORTADO_NO_HARNESS');
  }
  clockMs: () => number = () => Date.now() + 1_000;
}

class LocalRuntime {
  private readonly entries = new Map<
    string,
    {
      state: MitigationState;
      triggerCounter: number;
      recoveryCounter: number;
      lastSampleAt: Date | null;
    }
  >();
  saved: Array<{ profileId: string; patch: Record<string, unknown> }> = [];
  constructor(initial: Array<{ id: string; state: MitigationState }>) {
    for (const { id, state } of initial)
      this.entries.set(id, {
        state,
        triggerCounter: 0,
        recoveryCounter: 0,
        lastSampleAt: null,
      });
  }
  async get(profileId: string) {
    return this.entries.get(profileId) ?? null;
  }
  async save(profileId: string, patch: Record<string, unknown>) {
    this.saved.push({ profileId, patch });
    const entry = this.entries.get(profileId) ?? {
      state: 'NORMAL' as MitigationState,
      triggerCounter: 0,
      recoveryCounter: 0,
      lastSampleAt: null,
    };
    if (patch.state) entry.state = patch.state as MitigationState;
    if (typeof patch.triggerCounter === 'number') entry.triggerCounter = patch.triggerCounter;
    if (typeof patch.recoveryCounter === 'number') entry.recoveryCounter = patch.recoveryCounter;
    if (patch.lastSampleAt instanceof Date) entry.lastSampleAt = patch.lastSampleAt;
    this.entries.set(profileId, entry);
  }
  stateOf(profileId: string): MitigationState | null {
    return this.entries.get(profileId)?.state ?? null;
  }
}

export interface DecisionSignature {
  outcome: string;
  reason: string | null;
  samplesOver: number;
  samplesBelow: number;
  trafficBps: string | null;
  requestId: string | null;
}
const signature = (decision: MitigationAutoDecision): DecisionSignature => ({
  outcome: decision.outcome,
  reason: decision.reason,
  samplesOver: decision.samplesOver,
  samplesBelow: decision.samplesBelow,
  trafficBps: decision.trafficBps,
  requestId: decision.requestId,
});

interface EngineLike {
  tick(): Promise<MitigationAutoDecision[]>;
}

interface RunResult {
  decisions: DecisionSignature[];
  /** Decisões completas (RC2), usadas nos testes de contrato. */
  raw: MitigationAutoDecision[];
  commandCalls: Array<{ requestId: string; autoEvidence?: unknown }>;
  runtime: LocalRuntime;
}

export class Runner {
  readonly source = new ScriptedSource();
  readonly runtime: LocalRuntime;
  readonly calls: Array<{ requestId: string; autoEvidence?: unknown }> = [];
  private engine: EngineLike;
  private remaining: NonNullable<ScenarioOptions['commandResults']>;
  private readonly legacy: boolean;
  /** Relógio virtual: cada passo avalia no instante declarado. */
  private clockMs = BASE_TIME;
  private runtimeReadCalls = 0;
  private readsFail = false;

  constructor(private readonly options: ScenarioOptions, legacy: boolean) {
    this.legacy = legacy;
    const target = defaultTarget(options.target);
    const targets = [target, ...(options.siblings ?? [])];
    this.runtime = new LocalRuntime(
      targets.map((t) => ({
        id: t.profileId,
        // Em SHADOW o runtime lido é o estado isolado da simulação: o estado
        // físico real chega pelo target (`runtimeState`) e é reportado à parte.
        state:
          options.evaluationScope === 'SHADOW'
            ? 'NORMAL'
            : (t.runtimeState ?? options.runtimeState ?? 'NORMAL'),
      })),
    );
    this.remaining = [...(options.commandResults ?? [])];
    this.engine = this.build();
  }

  private build(): EngineLike {
    const { options } = this;
    const target = defaultTarget(options.target);
    const targets = [target, ...(options.siblings ?? [])];
    const common = {
      globalMode: options.globalMode ?? 'AUTO',
      evaluationConcurrency: 1,
      now: () => new Date(this.clockMs),
      execution: {
        executor: options.executor ?? 'HUAWEI',
        liveWrite: options.liveWrite ?? true,
        allowedDeviceIds: options.allowedDeviceIds ?? ['ne8000'],
      },
      targets: { list: async () => targets },
      traffic: this.source,
      exclusions: { listPeerExclusions: async () => [] },
      runtime: {
        get: async (id: string) => {
          const call = this.runtimeReadCalls++;
          if (this.readsFail || options.runtimeReadFails) throw new Error('RUNTIME_READ_FAILED');
          if (
            options.runtimeReadFailsFromCall !== undefined &&
            call >= options.runtimeReadFailsFromCall
          )
            throw new Error('RUNTIME_READ_FAILED');
          return this.runtime.get(id);
        },
        save: (id: string, patch: Record<string, unknown>) => this.runtime.save(id, patch),
      },
      commands: {
        execute: async (input: { requestId: string; autoEvidence?: unknown }) => {
          this.calls.push({ requestId: input.requestId, autoEvidence: input.autoEvidence });
          return (
            this.remaining.shift() ?? { ok: true, status: 'ACTIVATED_VERIFIED', verified: true }
          );
        },
      },
      ...(options.executionControl ? { executionControl: options.executionControl } : {}),
      ...(options.requireRuntimeRead !== undefined
        ? { requireRuntimeRead: options.requireRuntimeRead }
        : {}),
      ...(options.evaluationScope ? { evaluationScope: options.evaluationScope } : {}),
      ...(options.activationCooldownMs !== undefined
        ? { activationCooldownMs: options.activationCooldownMs }
        : {}),
      ...(options.failureBackoffMs !== undefined
        ? { failureBackoffMs: options.failureBackoffMs }
        : {}),
      ...(options.maxFailureBackoffMs !== undefined
        ? { maxFailureBackoffMs: options.maxFailureBackoffMs }
        : {}),
      ...(options.maxRetriesPerSample !== undefined
        ? { maxRetriesPerSample: options.maxRetriesPerSample }
        : {}),
      // Baseline congelado não conhece `sampling`; a RC2 exige a janela.
      ...(this.legacy
        ? {}
        : {
            sampling:
              options.sampling ?? (() => ({ maxAgeMs: 600_000, maxGapMs: null as number | null })),
          }),
    };
    return (
      this.legacy ? new LegacyAutoEngine(common as never) : new MitigationAutoEngine(common as never)
    ) as EngineLike;
  }

  /** Reinício de processo: motor novo, estado persistido e fonte preservados. */
  restart(): void {
    this.engine = this.build();
  }

  /** A partir de agora toda leitura de runtime falha (teste do gate de leitura). */
  failRuntimeReads(): void {
    this.readsFail = true;
  }

  async run(steps: Step[]): Promise<RunResult> {
    const decisions: DecisionSignature[] = [];
    const raw: MitigationAutoDecision[] = [];
    this.source.clockMs = () => this.clockMs;
    for (const step of steps) {
      this.clockMs = step.at;
      if (step.sample !== undefined) {
        if (step.sample === null) this.source.clear();
        else this.source.push(step.sample, step.at);
      }
      const [decision] = await this.engine.tick();
      raw.push(decision!);
      decisions.push(signature(decision!));
    }
    return { decisions, raw, commandCalls: this.calls, runtime: this.runtime };
  }
}

/** Executa o MESMO roteiro nos dois motores, com estados independentes. */
export async function runScenario(
  options: ScenarioOptions,
  steps: Step[],
): Promise<{ baseline: RunResult; rc2: RunResult }> {
  const baseline = await new Runner(options, true).run(steps);
  const rc2 = await new Runner(options, false).run(steps);
  return { baseline, rc2 };
}

/** Assinatura compacta para mensagens de falha legíveis. */
export const summarize = (result: RunResult): string =>
  result.decisions
    .map((d) => `${d.outcome}/${d.reason ?? '-'}/over=${d.samplesOver}/below=${d.samplesBelow}`)
    .join(' | ');
