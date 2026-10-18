import { evaluateTraffic } from '../../infrastructure/bgp/mitigation/mitigation-state-machine';
import { createHash } from 'node:crypto';
import type { MitigationAutoEvidence } from '../../infrastructure/bgp/mitigation/mitigation-command-service';
import type {
  MitigationMode,
  MitigationProfileMode,
  MitigationState,
} from '../../infrastructure/bgp/mitigation/mitigation-types';
import type { MitigationExecutorKind } from '../../infrastructure/bgp/mitigation/mitigation-execution-config';
import type { MitigationTrafficSample, MitigationTrafficSource } from './mitigation-traffic-source';
import { withinSamplingWindow, type MitigationSamplingWindow } from './mitigation-sampling-policy';

/**
 * MOTOR AUTO do GMJ NetVision.
 *
 * Regras estruturais desta primeira versao:
 *  - AUTO ATIVA sozinho; REMOVE continua exclusivamente humano (Telegram -> n8n).
 *  - Nenhum caminho paralelo: o ACTIVATE passa pelo MESMO MitigationCommandService
 *    usado pela UI e pelo inbound do n8n (preflight + read-back + notificacao).
 *  - Fail-closed: qualquer gate que nao esteja verde NAO escreve; a decisao e
 *    registrada com motivo seguro.
 */

export type MitigationAutoOutcome =
  | 'NO_ACTION'
  | 'TRIGGER_PENDING'
  | 'WOULD_ACTIVATE'
  | 'ACTIVATED'
  /** ALERT_ONLY cruzou threshold com samples: alerta, nunca escrita. */
  | 'ALERT_TRIGGERED'
  | 'BLOCKED'
  | 'FAILED'
  | 'SKIPPED'
  | 'RECOVERY_PENDING';

export type MitigationAutoBlockReason =
  | 'PROFILE_DISABLED'
  | 'PROFILE_MODE_NOT_AUTO'
  | 'BANDWIDTH_UNKNOWN'
  | 'TELEMETRY_UNAVAILABLE'
  | 'RUNTIME_UNAVAILABLE'
  | 'DUPLICATE_SAMPLE'
  | 'ACTIVATION_COOLDOWN'
  | 'ALREADY_MITIGATED'
  | 'AUTO_REMOVE_DISABLED'
  | 'THRESHOLD_NOT_EXCEEDED'
  | 'SAMPLES_INSUFFICIENT'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'TARGET_NOT_READY'
  | 'PREFIX_LIMIT_EXCEEDED'
  | 'TARGET_BLOCKED'
  | 'MITIGATION_EXCLUDED'
  | 'PEER_MITIGATION_EXCLUDED'
  /** AUTOMACAO bloqueada por policy compartilhada (config, com aprovacao explicita). */
  | 'SHARED_POLICY_UNRESOLVED'
  /**
   * IPv4 e IPv6 da MESMA interface compartilham contadores: AUTO simultaneo nas
   * duas familias exige aprovacao explicita do par (env). Fail-closed por padrao.
   */
  | 'FAMILY_CONTENTION_UNRESOLVED'
  | 'NO_SAFE_TEMPORARY_NODE'
  | 'GLOBAL_MODE_SIMULATION_ONLY'
  | 'EXECUTOR_NOT_HUAWEI'
  | 'LIVE_WRITE_DISABLED'
  | 'DEVICE_NOT_ALLOWED'
  | 'PREFLIGHT_FAILED'
  | 'ACTIVATE_FAILED'
  | 'VERIFY_FAILED'
  | 'SCOPE_ALREADY_MITIGATED'
  | 'SCOPE_OPERATION_IN_FLIGHT'
  | 'POLICY_BUSY'
  /**
   * DUAL: o ataque foi detectado em RX. A mitigacao BGP existente diversa
   * prefixos (acao valida em TX), entao RX e monitorado/alertado sem escrever
   * comando incompativel. Nao e bloqueio tecnico: e deteccao sem acao viavel.
   */
  | 'RX_MONITOR_ONLY'
  /**
   * AUTO-ALL: perfil promovido pelo sweep com o controle de execucao
   * DESLIGADO (`MITIGATION_AUTO_EXECUTION_ENABLED=0`). O gatilho e reconhecido e
   * registrado, mas NENHUMA nova ativacao automatica parte deste perfil. O AUTO
   * manual (ex.: BHNET-3043) nao e afetado e mitigacoes ativas nao sao tocadas.
   */
  | 'AUTO_EXECUTION_DISABLED'
  | 'CONCURRENT_TICK';

export interface MitigationAutoTargetState {
  /** Optional config epoch supplied by the integration; never a traffic identity. */
  configurationKey?: string;
  activationDirection?: 'tx';
  profileId: string;
  deviceId: string;
  /** Nome da route-policy fisica: escopo compartilhado do AUTO (F3). */
  policyName?: string | null;
  interfaceId: string | null;
  customer: string | null;
  mode: MitigationProfileMode;
  /**
   * Familia do alvo. IPv4 e IPv6 da MESMA interface compartilham os contadores
   * SNMP - e por isso que AUTO simultaneo nas duas familias exige aprovacao.
   */
  addressFamily?: 'IPV4' | 'IPV6';
  /**
   * Direcao EFETIVA de telemetria deste perfil (persistida no perfil ou
   * fallback ENV). `null`/ausente = nao configurada => TELEMETRY_UNAVAILABLE.
   */
  direction?: 'rx' | 'tx' | null;
  directionSource?: 'PROFILE' | 'ENV' | null;
  /**
   * AUTO-ALL: `true` = o modo AUTO veio do sweep da DESCRIPTION. Somente estes
   * perfis respeitam o controle de execucao (pausa de NOVAS ativacoes).
   */
  autoPromotedBySweep?: boolean;
  /**
   * Policy compartilhada com outro target (config): quando a guarda de
   * automacao esta ligada, o target AUTO so passa se estiver na allowlist.
   */
  sharedPolicyAutomationBlocked?: boolean;
  /** Ha snapshot de discovery nesta sessao; false => SNAPSHOT_UNAVAILABLE. */
  snapshotAvailable: boolean;
  readiness: 'READY' | 'NOT_READY';
  prefixStatus: 'SAFE' | 'WARNING' | 'EXCEEDED' | 'UNKNOWN';
  blockedReason: string | null;
  mitigationExcluded: boolean;
  runtimeState: MitigationState | null;
  effectiveBandwidthBps: bigint | null;
  bogonNode: number | null;
  mitigationNode: number | null;
  sharedPolicy: boolean;
  peerAddresses: string[];
  triggerPercent: number;
  recoveryPercent: number;
  triggerSamples: number;
  recoverySamples: number;
}

export interface MitigationAutoCommandResult {
  ok: boolean;
  status: string;
  verified: boolean;
  blockedReason?: string | null;
  safeError?: string;
  notification?: { published: boolean; skipped: boolean } | null;
  timingsMs?: { preflight: number; execution: number; readback: number };
}

export interface MitigationAutoDecision {
  sampleAt?: string | null;
  sampleToDecisionMs?: number | null;
  decisionMs?: number;
  at: string;
  profileId: string;
  deviceId: string;
  customer: string | null;
  outcome: MitigationAutoOutcome;
  reason: MitigationAutoBlockReason | null;
  trafficBps: string | null;
  thresholdBps: string | null;
  recoveryThresholdBps: string | null;
  samplesOver: number;
  samplesBelow: number;
  requiredSamples: number;
  runtimeState: MitigationState | null;
  sharedPolicy: boolean;
  /** Familia do alvo avaliado (auditoria do modo sombra). */
  addressFamily?: 'IPV4' | 'IPV6';
  /** Direcao EFETIVA e origem usadas nesta avaliacao. */
  direction?: 'rx' | 'tx' | null;
  directionSource?: 'PROFILE' | 'ENV' | null;
  /** AUTO-ALL: proveniencia do modo (sweep x manual) nesta avaliacao. */
  promotedBySweep?: boolean;
  /**
   * DUAL: taxas lidas por direcao NESTA avaliacao (mesma amostra/identidade).
   * Ausente quando o alvo roda no caminho legado de direcao unica.
   */
  trafficByDirection?: { rx: string | null; tx: string | null } | null;
  /**
   * DUAL: direcoes que cruzaram o threshold com amostras suficientes. `tx`
   * habilita a mitigacao BGP existente; `rx` gera ALERT_TRIGGERED sem escrita.
   */
  triggeredDirections?: Array<'rx' | 'tx'>;
  /** `true` = policy compartilhada com automacao bloqueada por config. */
  sharedPolicyAutomationBlocked?: boolean;
  requestId: string | null;
  commandStatus: string | null;
  verified: boolean;
  notification: { published: boolean; skipped: boolean } | null;
  detail: string | null;
  firstAbnormalAt?: string | null;
  confirmationMs?: number | null;
  commandMs?: number;
  timingsMs?: { preflight: number; execution: number; readback: number };
  totalResponseMs?: number | null;
  responseDeadlineExceeded?: boolean;
  /** Escopo desta avaliação: operacional (pode escrever) ou hipotético (SHADOW). */
  evaluationScope?: 'OPERATIONAL' | 'SHADOW';
  /** SHADOW: estado FÍSICO real do perfil, reportado separadamente da hipótese. */
  physicalState?: MitigationState | null;
  /** SHADOW: `true` quando o perfil já está mitigado fisicamente. */
  physicalMitigated?: boolean;
  /** SHADOW: bloqueio operacional que impediria a escrita (não afeta a hipótese). */
  operationalBlock?: MitigationAutoBlockReason | null;
  /** Retentativa N da MESMA amostra confirmada (idempotente por `requestId`). */
  retryAttempt?: number | null;
  /** Janela temporal aplicada nesta avaliação (auditoria do contrato da fonte). */
  samplingMaxAgeMs?: number;
  samplingMaxGapMs?: number | null;
}

/**
 * Janela por FONTE. `null` em `maxGapMs` = fonte sem regra de continuidade
 * (contrato publicado do LEGACY). O motor não inicia sem esta configuração.
 */
export type MitigationAutoSamplingPolicy =
  | MitigationSamplingWindow
  | ((target: MitigationAutoTargetState) => MitigationSamplingWindow);

export interface MitigationAutoEngineDeps {
  /**
   * Exigir leitura de runtime para este target. Booleano (todos) ou por target:
   * somente fontes FAST exigem; LEGACY mantém a tolerância publicada.
   */
  requireRuntimeRead?: boolean | ((target: MitigationAutoTargetState) => boolean);
  /** Modo global do motor (AUTO so escreve quando o global tambem e AUTO). */
  globalMode: MitigationMode;
  execution: {
    executor: MitigationExecutorKind;
    liveWrite: boolean;
    allowedDeviceIds: readonly string[];
  };
  targets: { list(): Promise<MitigationAutoTargetState[]> };
  traffic: MitigationTrafficSource;
  exclusions: {
    listPeerExclusions(filter?: {
      deviceId?: string;
      peerAddresses?: string[];
    }): Promise<{ peerAddress: string }[]>;
  };
  runtime: {
    get(profileId: string): Promise<{
      state: MitigationState;
      triggerCounter: number;
      recoveryCounter: number;
      lastSampleAt?: Date | null;
    } | null>;
    save(
      profileId: string,
      patch: {
        state?: MitigationState;
        triggerCounter?: number;
        recoveryCounter?: number;
        currentTrafficBps?: bigint | null;
        lastSampleAt?: Date | null;
      },
    ): Promise<void>;
  };
  commands: {
    execute(input: {
      requestId: string;
      action: 'ACTIVATE';
      profileId: string;
      autoEvidence?: MitigationAutoEvidence;
    }): Promise<MitigationAutoCommandResult>;
  };
  now?: () => Date;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * Log de INVESTIGACAO: recebe TODA decisao (um profile por tick). Deve ir
   * para o nivel DEBUG - e esta via que mantem o detalhe completo sem inundar
   * o syslog com a mesma decisao normal a cada 5 s.
   */
  debugLogger?: (message: string, meta?: Record<string, unknown>) => void;
  /** Janela do resumo agregado das decisoes normais (default 5 min). */
  summaryIntervalMs?: number;
  /** Silencio minimo por profile entre mudancas NAO criticas (default 30 s). */
  transitionThrottleMs?: number;
  /**
   * Guarda de automacao em POLICY COMPARTILHADA. Desligada por padrao: preserva
   * exatamente o comportamento do AUTO atual (BHNET-CEASA, que compartilha a
   * policy com outro cliente). Ligada, um target AUTO marcado como
   * `sharedPolicyAutomationBlocked` (discovery) so passa se estiver na
   * allowlist explicita do operador.
   */
  sharedPolicyGuard?: {
    enabled: boolean;
    allowedProfileIds: readonly string[];
  };
  /**
   * Pares IPv4/IPv6 do MESMO escopo de contadores aprovados EXPLICITAMENTE para
   * AUTO simultaneo (`[profileIdA, profileIdB]`, ordem indiferente). Ausente ou
   * vazio = nenhum par aprovado (fail-closed).
   */
  approvedFamilyPairs?: readonly (readonly [string, string])[];
  /**
   * DUAL RX+TX (flag `MITIGATION_AUTO_DUAL_DIRECTIONS`): avalia as DUAS
   * direcoes da mesma amostra, com contadores independentes. TX continua sendo
   * a direcao da mitigacao BGP; RX dispara ALERT_TRIGGERED (`RX_MONITOR_ONLY`)
   * sem escrita. Desligado = caminho legado de direcao unica, inalterado.
   */
  dualDirections?: { enabled: boolean };
  /**
   * AUTO-ALL (flag `MITIGATION_AUTO_EXECUTION_ENABLED`): quando DESLIGADO, o
   * motor nao inicia NOVAS ativacoes de perfis promovidos pelo sweep
   * (`autoPromotedBySweep=true`). AUTO manual/legado (BHNET-3043) e mitigacoes
   * ja ativas permanecem intactos; o REMOVE continua 100% manual.
   */
  executionControl?: { enabled: boolean };
  /**
   * OBRIGATÓRIO: janela da fonte roteada para este motor. Sem valor explícito o
   * construtor falha — não existe fallback global (o antigo 45 s aplicado ao
   * LEGACY foi a causa da regressão do Gate 2).
   */
  sampling: MitigationAutoSamplingPolicy;
  /**
   * `OPERATIONAL` decide escrita real; `SHADOW` avalia a hipótese em estado
   * próprio e nunca passa pelos gates de autorização de escrita.
   */
  evaluationScope?: 'OPERATIONAL' | 'SHADOW';
  activationCooldownMs?: number;
  /** Backoff após falha transitória de execução (default 15 s, escalonado). */
  failureBackoffMs?: number;
  maxFailureBackoffMs?: number;
  /** Máximo de retentativas da MESMA amostra confirmada (default 2). */
  maxRetriesPerSample?: number;
  /** Bounded evaluation of independent profiles; canonical policy locks still serialize writes. */
  evaluationConcurrency?: number;
}

interface DirectionCounters {
  over: number;
  below: number;
  triggerStartedAtMs: number | null;
  /** Identidade da ultima amostra contada (distinct samples por timestamp). */
  lastSampleKey: string | null;
  /** Timestamp (ms) da ultima amostra contada, para exigir monotonicidade. */
  lastSampleAtMs: number | null;
  continuityKey?: string | undefined;
}

interface AutoCounters extends DirectionCounters {
  loaded: boolean;
  /**
   * DUAL: contadores de RX, INDEPENDENTES dos de TX (que sao a base persistida
   * em `triggerCounter`/`recoveryCounter`). RX nao escreve no equipamento e nao
   * tem histerese persistida: a memoria do processo basta e um restart apenas
   * reinicia a contagem (fail-closed, nunca dispara escrita).
   */
  rx?: DirectionCounters;
}

/**
 * Ultima tentativa de escrita por ESCOPO fisico (`deviceId:policy`).
 * O cooldown so passa a contar quando a execucao TERMINA: falha transitoria
 * (preflight/lock) usa backoff curto e escalonado, nunca a janela cheia.
 */
interface ScopeAttempt {
  startedAtMs: number;
  lastOutcomeAtMs: number | null;
  /** Falhas consecutivas de execucao real (0 = ultima tentativa verificada). */
  failures: number;
  /** Identidade da amostra que autorizou a tentativa (retry da MESMA amostra). */
  sampleKey: string | null;
}

function newDirectionCounters(): DirectionCounters {
  return {
    over: 0,
    below: 0,
    triggerStartedAtMs: null,
    lastSampleKey: null,
    lastSampleAtMs: null,
  };
}

/**
 * Conta a amostra UMA vez, por DIRECAO: identidade distinta (occurredAt
 * monotonico; sem occurredAt, por sampleKey), threshold de gatilho e piso de
 * recuperacao. Extraido para RX e TX usarem exatamente a mesma regra.
 */
function countDistinctSample(
  counters: DirectionCounters,
  sample: MitigationTrafficSample,
  thresholds: { trigger: bigint; recovery: bigint },
  atMs: number,
  maxGapMs: number | null,
): boolean {
  const sampleMs = sample.occurredAt?.getTime() ?? atMs;
  if (
    (maxGapMs !== null &&
      counters.lastSampleAtMs !== null &&
      sampleMs - counters.lastSampleAtMs > maxGapMs) ||
    (counters.continuityKey !== undefined && counters.continuityKey !== sample.continuityKey)
  ) {
    resetSequence(counters);
  }
  let isNewSample: boolean;
  if (sample.occurredAt) {
    const atSampleMs = sample.occurredAt.getTime();
    isNewSample = counters.lastSampleAtMs === null || atSampleMs > counters.lastSampleAtMs;
    if (isNewSample) counters.lastSampleAtMs = atSampleMs;
  } else {
    isNewSample = counters.lastSampleKey !== sample.sampleKey;
  }
  if (!isNewSample) return false;
  counters.lastSampleKey = sample.sampleKey;
  counters.continuityKey = sample.continuityKey;
  if (sample.bps > thresholds.trigger) {
    counters.over += 1;
    counters.below = 0;
    if (counters.triggerStartedAtMs === null) counters.triggerStartedAtMs = sampleMs;
  } else if (sample.bps < thresholds.recovery) {
    counters.below += 1;
    counters.over = 0;
    counters.triggerStartedAtMs = null;
  } else {
    counters.over = 0;
    counters.below = 0;
    counters.triggerStartedAtMs = null;
  }
  return true;
}

function resetSequence(counters: DirectionCounters): void {
  counters.over = 0;
  counters.below = 0;
  counters.triggerStartedAtMs = null;
}

const MITIGATED_STATES: readonly MitigationState[] = [
  'MITIGATING',
  'MITIGATED',
  'RECOVERY_PENDING',
  'RECOVERING',
];

/** Outcomes que SEMPRE aparecem em INFO: operacao real ou falha. */
const ALWAYS_LOGGED_OUTCOMES: readonly MitigationAutoOutcome[] = [
  'ACTIVATED',
  'FAILED',
  'ALERT_TRIGGERED',
  'RECOVERY_PENDING',
];

interface DecisionSummary {
  startedAtMs: number;
  total: number;
  suppressed: number;
  byOutcome: Map<string, number>;
  byReason: Map<string, number>;
}

function newSummary(startedAtMs: number): DecisionSummary {
  return { startedAtMs, total: 0, suppressed: 0, byOutcome: new Map(), byReason: new Map() };
}

/**
 * Estados que o AUTO POSSUI: somente de/para eles o motor escreve `state` no
 * runtime. MITIGATED/RECOVERY_* e principalmente RECONCILIATION_REQUIRED/FAILED
 * sao de outros donos (comando/reconciliacao) e NUNCA podem ser sobrescritos
 * por um tick - um estado fisico desconhecido nao vira NORMAL por decurso de
 * tempo.
 */
function engineOwnsState(state: MitigationState | null | undefined): boolean {
  return state === null || state === undefined || state === 'NORMAL' || state === 'TRIGGER_PENDING';
}

export class MitigationAutoEngine {
  private readonly history = new Map<string, MitigationAutoDecision[]>();
  private readonly attempts = new Map<string, ScopeAttempt>();
  private readonly counters = new Map<string, AutoCounters>();
  private readonly configurationKeys = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  /** Cadeia de avaliações por profile (serializa ticks concorrentes). */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly decisions = new Map<string, MitigationAutoDecision>();
  private lastVerifiedActivate: MitigationAutoDecision | null = null;
  private readonly now: () => Date;
  /** Ultima decisao emitida em INFO por profile (`outcome|reason|state`). */
  private readonly loggedDecisions = new Map<string, string>();
  /** Instante da ultima emissao em INFO por profile (throttle de transicao). */
  private readonly loggedAtMs = new Map<string, number>();
  private summary: DecisionSummary = newSummary(0);
  private readonly summaryIntervalMs: number;
  private readonly transitionThrottleMs: number;

  constructor(private readonly deps: MitigationAutoEngineDeps) {
    if (!deps.sampling) throw new Error('MITIGATION_AUTO_SAMPLING_REQUIRED');
    this.now = deps.now ?? (() => new Date());
    this.summaryIntervalMs = deps.summaryIntervalMs ?? 300_000;
    this.transitionThrottleMs = deps.transitionThrottleMs ?? 30_000;
  }

  /** Ultima decisao por target (observabilidade da UI/health). */
  getDecisions(): MitigationAutoDecision[] {
    return [...this.decisions.values()];
  }

  getDecisionHistory(profileId: string): MitigationAutoDecision[] {
    return [...(this.history.get(profileId) ?? [])];
  }

  getLastDecision(): MitigationAutoDecision | null {
    const all = this.getDecisions();
    if (all.length === 0) return null;
    return all.reduce((latest, item) => (item.at > latest.at ? item : latest));
  }

  getLastVerifiedActivate(): MitigationAutoDecision | null {
    return this.lastVerifiedActivate;
  }

  isBusy(profileId: string): boolean {
    return this.inFlight.has(profileId);
  }

  /** Avalia todos os targets. O chamador decide a cadencia (loop/timer). */
  async tick(): Promise<MitigationAutoDecision[]> {
    const targets = await this.deps.targets.list();
    const result: MitigationAutoDecision[] = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < targets.length) {
        const index = nextIndex++;
        const target = targets[index]!;
        // Erro em UM profile nunca derruba a avaliacao dos outros.
        try {
          const decision = await this.evaluate(target);
          this.decisions.set(target.profileId, decision);
          result[index] = decision;
        } catch (error) {
          const decision = this.record({
            at: this.now().toISOString(),
            profileId: target.profileId,
            deviceId: target.deviceId,
            customer: target.customer,
            outcome: 'FAILED',
            reason: 'ACTIVATE_FAILED',
            trafficBps: null,
            thresholdBps: null,
            recoveryThresholdBps: null,
            samplesOver: 0,
            samplesBelow: 0,
            requiredSamples: target.triggerSamples,
            runtimeState: target.runtimeState,
            sharedPolicy: target.sharedPolicy,
            requestId: null,
            commandStatus: null,
            verified: false,
            notification: null,
            detail: error instanceof Error ? error.message : 'falha na avaliacao',
          });
          this.decisions.set(target.profileId, decision);
          result[index] = decision;
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            targets.length,
            Math.max(1, Math.min(4, this.deps.evaluationConcurrency ?? 1)),
          ),
        },
        worker,
      ),
    );
    // Resumo agregado das decisoes normais (substitui o log por tick).
    this.flushSummaryIfDue();
    return result;
  }

  /**
   * Avalia UM target, serializando por profile.
   *
   * A serialização é a proteção contra concorrência dentro do processo: dois
   * ticks sobrepostos não podem intercalar contadores (o que geraria/duplicaria
   * gatilho). O lock de escrita (`inFlight`) continua valendo por cima disso.
   */
  async evaluate(target: MitigationAutoTargetState): Promise<MitigationAutoDecision> {
    const previous = this.chains.get(target.profileId) ?? Promise.resolve();
    const next = previous.then(
      () => this.evaluateOnce(target),
      () => this.evaluateOnce(target),
    );
    this.chains.set(
      target.profileId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async evaluateOnce(target: MitigationAutoTargetState): Promise<MitigationAutoDecision> {
    // Contrato por FONTE, resolvido a cada avaliação. Não existe fallback: o
    // construtor garante que a política foi fornecida.
    const sampling =
      typeof this.deps.sampling === 'function' ? this.deps.sampling(target) : this.deps.sampling;
    const maxGapMs = sampling.maxGapMs;
    if (target.configurationKey !== undefined) {
      const previous = this.configurationKeys.get(target.profileId);
      if (previous !== undefined && previous !== target.configurationKey) {
        const staleCounters = await this.loadCounters(target, sampling);
        resetSequence(staleCounters);
        if (staleCounters.rx) resetSequence(staleCounters.rx);
        await this.deps.runtime.save(target.profileId, { triggerCounter: 0, recoveryCounter: 0 });
      }
      this.configurationKeys.set(target.profileId, target.configurationKey);
    }
    let at = this.now();
    const base = {
      at: at.toISOString(),
      profileId: target.profileId,
      deviceId: target.deviceId,
      customer: target.customer,
      trafficBps: null as string | null,
      thresholdBps: null as string | null,
      recoveryThresholdBps: null as string | null,
      samplesOver: 0,
      samplesBelow: 0,
      requiredSamples: target.triggerSamples,
      runtimeState: target.runtimeState,
      sharedPolicy: target.sharedPolicy,
      addressFamily: target.addressFamily ?? ('IPV4' as const),
      direction: target.direction ?? null,
      directionSource: target.directionSource ?? null,
      promotedBySweep: target.autoPromotedBySweep === true,
      sharedPolicyAutomationBlocked: target.sharedPolicyAutomationBlocked === true,
      requestId: null as string | null,
      commandStatus: null as string | null,
      verified: false,
      notification: null as { published: boolean; skipped: boolean } | null,
      detail: null as string | null,
    };
    const block = (reason: MitigationAutoBlockReason, outcome: MitigationAutoOutcome = 'BLOCKED') =>
      this.record({ ...base, outcome, reason, detail: reason });
    const pending = (reason: MitigationAutoBlockReason, outcome: MitigationAutoOutcome) =>
      this.record({ ...base, outcome, reason, detail: reason });

    if (target.mode === 'DISABLED') return block('PROFILE_DISABLED');
    if (this.inFlight.has(target.profileId)) return pending('CONCURRENT_TICK', 'SKIPPED');

    // O runtime pode ter mudado DURANTE o ciclo: outro profile do MESMO escopo
    // (deviceId + policyName) acabou de mitigar a policy compartilhada, ou o
    // comando marcou RECONCILIATION_REQUIRED. A leitura fresca evita decisao
    // baseada em estado velho e impede o tick de rebaixar estado alheio.
    const freshRead = await this.readRuntimeState(target.profileId);
    if (this.requiresRuntimeRead(target) && !freshRead.ok) return block('RUNTIME_UNAVAILABLE');

    // ---------------------------------------------------------------------
    // Gates de ELEGIBILIDADE, comuns a AUTO e ALERT_ONLY (mesma semantica do
    // discovery). Rodam ANTES de threshold/telemetria, na ordem:
    //   snapshot -> readiness -> prefixo (EXCEEDED) -> seguranca/exclusao.
    // ALERT_ONLY nunca "alerta" um target que o AUTO nao poderia mitigar.
    // ---------------------------------------------------------------------
    // Sem snapshot de discovery (cache vazio pos-restart antes da reidratacao)
    // o motor fica fail-closed: nao depende do fallback NOT_READY do DTO.
    if (!target.snapshotAvailable) return block('SNAPSHOT_UNAVAILABLE');
    if (target.readiness !== 'READY') return block('TARGET_NOT_READY');
    // Sessao BGP e quantidade de prefixos sao INFORMATIVAS. So o EXCESSO de
    // prefixos bloqueia - mesma semantica do discovery (PREFIX_LIMIT_EXCEEDED).
    if (target.prefixStatus === 'EXCEEDED') return block('PREFIX_LIMIT_EXCEEDED');
    if (target.blockedReason !== null) return block('TARGET_BLOCKED');
    if (target.mitigationExcluded) return block('MITIGATION_EXCLUDED');

    // Guarda de CONFIG para policy compartilhada. Desligada por padrao para nao
    // alterar o AUTO existente; quando ligada, exige allowlist explicita.
    const sharedGuard = this.deps.sharedPolicyGuard;
    if (
      target.mode === 'AUTO' &&
      target.sharedPolicyAutomationBlocked === true &&
      sharedGuard?.enabled === true &&
      !sharedGuard.allowedProfileIds.includes(target.profileId)
    ) {
      return block('SHARED_POLICY_UNRESOLVED');
    }

    // IPv4/IPv6 da MESMA interface compartilham contadores: AUTO no alvo IPv6
    // exige aprovacao explicita do par (fail-closed, independente de direcao).
    if (target.mode === 'AUTO') {
      const contendedBy = await this.detectFamilyContention(target);
      if (contendedBy !== null) {
        return this.record({
          ...base,
          outcome: 'BLOCKED',
          reason: 'FAMILY_CONTENTION_UNRESOLVED',
          detail: `AUTO IPv6 sem aprovacao explicita de familia (${contendedBy.join(', ')})`,
        });
      }
    }

    const excludedPeers = await this.deps.exclusions.listPeerExclusions({
      deviceId: target.deviceId,
      peerAddresses: target.peerAddresses,
    });
    if (excludedPeers.length > 0) return block('PEER_MITIGATION_EXCLUDED');

    if (target.bogonNode === null || target.mitigationNode === null) {
      return block('NO_SAFE_TEMPORARY_NODE');
    }
    if (target.effectiveBandwidthBps === null || target.effectiveBandwidthBps <= 0n) {
      return block('BANDWIDTH_UNKNOWN');
    }

    const threshold = (target.effectiveBandwidthBps * BigInt(target.triggerPercent)) / 100n;
    const recoveryThreshold =
      (target.effectiveBandwidthBps * BigInt(target.recoveryPercent)) / 100n;
    const thresholds = { trigger: threshold, recovery: recoveryThreshold };
    // Contrato por FONTE, resolvido a cada avaliação. Não existe fallback: o
    // construtor garante que a política foi fornecida.
    const counters = await this.loadCounters(target, sampling);
    const refreshFastDecisionTime = () => {
      if (sampling.maxGapMs === null) return; // preserve the published LEGACY timing
      at = this.now();
      base.at = at.toISOString();
    };
    const usable = (sample: MitigationTrafficSample | null): sample is MitigationTrafficSample =>
      withinSamplingWindow(sample, at.getTime(), sampling);
    const unavailable = async () => {
      resetSequence(counters);
      if (counters.rx) resetSequence(counters.rx);
      await this.deps.runtime.save(target.profileId, {
        triggerCounter: 0,
        recoveryCounter: 0,
        currentTrafficBps: null,
        ...(freshRead.ok && engineOwnsState(freshRead.state) && engineOwnsState(target.runtimeState)
          ? { state: 'NORMAL' as const }
          : {}),
      });
      return block('TELEMETRY_UNAVAILABLE');
    };
    let newTxSample = false;
    let autoEvidence: MitigationAutoEvidence | undefined;
    const evidenceOf = (sample: MitigationTrafficSample): MitigationAutoEvidence | undefined =>
      sample.occurredAt && sample.continuityKey
        ? { sampleAt: sample.occurredAt.toISOString(), continuityKey: sample.continuityKey }
        : undefined;

    // DUAL RX+TX (flag): as duas direcoes da MESMA amostra, com contadores
    // independentes. O alvo com direcao PINADA em `rx` continua no caminho
    // legado: nao existe acao BGP compativel com RX e o operador fixou essa
    // leitura de proposito.
    const dual =
      this.deps.dualDirections?.enabled === true &&
      typeof this.deps.traffic.sampleDirectionsWithId === 'function' &&
      (target.direction === null || target.direction === undefined || target.direction === 'tx');

    let traffic: bigint;
    let decisionSampleAt: Date | null = null;
    let trafficByDirection: { rx: string | null; tx: string | null } | null = null;
    let triggeredDirections: Array<'rx' | 'tx'> | null = null;
    if (dual) {
      const sample = await this.deps.traffic.sampleDirectionsWithId!({
        profileId: target.profileId,
        deviceId: target.deviceId,
        interfaceId: target.interfaceId,
        bandwidthBps: target.effectiveBandwidthBps,
        ...(target.configurationKey ? { configurationKey: target.configurationKey } : {}),
      }).catch(() => null);
      refreshFastDecisionTime();
      if (sample === null || (sample.rx === null && sample.tx === null)) {
        return unavailable();
      }
      decisionSampleAt = sample.occurredAt;
      const rxCounters = (counters.rx ??= newDirectionCounters());
      // Mesma regra de amostra distinta, POR DIRECAO: a identidade (occurredAt
      // monotonico) e a mesma linha do equipamento para RX e TX.
      if (usable(sample.rx))
        countDistinctSample(rxCounters, sample.rx, thresholds, at.getTime(), maxGapMs);
      else {
        resetSequence(rxCounters);
        sample.rx = null;
      }
      if (usable(sample.tx))
        newTxSample = countDistinctSample(counters, sample.tx, thresholds, at.getTime(), maxGapMs);
      else {
        resetSequence(counters);
        sample.tx = null;
      }
      const rxTriggered =
        sample.rx !== null &&
        sample.rx.bps > threshold &&
        rxCounters.over >= target.triggerSamples;
      const txTriggered =
        sample.tx !== null && sample.tx.bps > threshold && counters.over >= target.triggerSamples;
      trafficByDirection = {
        rx: sample.rx !== null ? sample.rx.bps.toString() : null,
        tx: sample.tx !== null ? sample.tx.bps.toString() : null,
      };
      triggeredDirections = [
        ...(rxTriggered ? (['rx'] as const) : []),
        ...(txTriggered ? (['tx'] as const) : []),
      ];
      // TX e a direcao da mitigacao existente (diversao de prefixo). Sem essa
      // leitura nao existe acao viavel: com RX confirmado vira ALERTA (com
      // registro), sem RX confirmado a telemetria util esta indisponivel.
      if (sample.tx === null) {
        return this.record({
          ...base,
          trafficBps: trafficByDirection.rx,
          thresholdBps: threshold.toString(),
          recoveryThresholdBps: recoveryThreshold.toString(),
          samplesOver: rxCounters.over,
          samplesBelow: rxCounters.below,
          trafficByDirection,
          triggeredDirections,
          outcome: rxTriggered ? 'ALERT_TRIGGERED' : 'BLOCKED',
          reason: rxTriggered ? 'RX_MONITOR_ONLY' : 'TELEMETRY_UNAVAILABLE',
          detail: rxTriggered
            ? 'Attack detectado em RX: alertado sem escrita (a acao BGP de diversao e valida em TX)'
            : 'TELEMETRY_UNAVAILABLE',
        });
      }
      autoEvidence = evidenceOf(sample.tx);
      if (newTxSample)
        await this.persistCounters(
          target,
          counters,
          sample.tx.bps,
          sample.tx.occurredAt ?? at,
          freshRead,
        );
      // RX detectado e TX normal: registra/alertar SEM escrever. A mitigacao
      // BGP nao resolve o cenario de RX (origem no cliente) com a acao atual.
      if (rxTriggered && !txTriggered) {
        return this.record({
          ...base,
          trafficBps: sample.tx.bps.toString(),
          thresholdBps: threshold.toString(),
          recoveryThresholdBps: recoveryThreshold.toString(),
          samplesOver: rxCounters.over,
          samplesBelow: rxCounters.below,
          trafficByDirection,
          triggeredDirections,
          outcome: 'ALERT_TRIGGERED',
          reason: 'RX_MONITOR_ONLY',
          detail:
            'Attack detectado em RX: alertado sem escrita (a acao BGP de diversao e valida em TX)',
        });
      }
      // RX acumulando amostras (ainda sem gatilho) e TX normal: a decisao
      // mostra o PENDENTE do RX em vez de um NO_ACTION enganoso.
      if (!txTriggered && rxCounters.over > 0) {
        return this.record({
          ...base,
          trafficBps: sample.tx.bps.toString(),
          thresholdBps: threshold.toString(),
          recoveryThresholdBps: recoveryThreshold.toString(),
          samplesOver: rxCounters.over,
          samplesBelow: rxCounters.below,
          trafficByDirection,
          triggeredDirections,
          outcome: 'TRIGGER_PENDING',
          reason: 'SAMPLES_INSUFFICIENT',
          detail: 'RX acima do threshold: acumulando amostras distintas (TX sem gatilho)',
        });
      }
      traffic = sample.tx.bps;
    } else {
      // Caminho LEGADO (direcao unica): identico ao publicado.
      const sample = await this.deps.traffic
        .sampleWithId({
          profileId: target.profileId,
          deviceId: target.deviceId,
          interfaceId: target.interfaceId,
          bandwidthBps: target.effectiveBandwidthBps,
          ...(target.configurationKey ? { configurationKey: target.configurationKey } : {}),
        })
        .catch(() => null);
      refreshFastDecisionTime();
      if (!usable(sample)) return unavailable();
      decisionSampleAt = sample.occurredAt;
      traffic = sample.bps;
      autoEvidence = evidenceOf(sample);
      // CRITICO: so conta sample novo quando a IDENTIDADE da telemetria muda.
      // 3 ticks lendo a MESMA InterfaceMetricSample valem 1 sample, nunca 3.
      // Regra de amostra distinta:
      //   - com occurredAt real: exige MONOTONICIDADE (T > lastSampleAt).
      //     Igual => nao conta; menor (telemetria atrasada/reordenada) => nao conta.
      //   - sem occurredAt (fontes de teste): identidade por sampleKey.
      newTxSample = countDistinctSample(counters, sample, thresholds, at.getTime(), maxGapMs);
      if (newTxSample)
        await this.persistCounters(target, counters, traffic, sample.occurredAt ?? at, freshRead);
    }

    const shadowScope = this.deps.evaluationScope === 'SHADOW';
    const withValues = {
      ...base,
      sampleAt: decisionSampleAt?.toISOString() ?? null,
      sampleToDecisionMs: decisionSampleAt
        ? Math.max(0, this.now().getTime() - decisionSampleAt.getTime())
        : null,
      decisionMs: this.now().getTime() - at.getTime(),
      trafficBps: traffic.toString(),
      thresholdBps: threshold.toString(),
      recoveryThresholdBps: recoveryThreshold.toString(),
      firstAbnormalAt:
        counters.triggerStartedAtMs === null
          ? null
          : new Date(counters.triggerStartedAtMs).toISOString(),
      confirmationMs:
        counters.over >= target.triggerSamples && counters.triggerStartedAtMs !== null
          ? at.getTime() - counters.triggerStartedAtMs
          : null,
      responseDeadlineExceeded:
        counters.triggerStartedAtMs !== null && at.getTime() - counters.triggerStartedAtMs > 60_000,
      evaluationScope: shadowScope ? ('SHADOW' as const) : ('OPERATIONAL' as const),
      samplingMaxAgeMs: sampling.maxAgeMs,
      samplingMaxGapMs: sampling.maxGapMs,
      ...(trafficByDirection !== null ? { trafficByDirection } : {}),
      ...(triggeredDirections !== null ? { triggeredDirections } : {}),
    };
    let retryAttempt: number | null = null;

    const physicalMitigated =
      target.runtimeState !== null && MITIGATED_STATES.includes(target.runtimeState);
    // SHADOW avalia a HIPOTESE em estado proprio: o runtime lido e o SHADOW, e o
    // estado fisico real viaja separado (`physicalState`) sem bloquear a
    // simulacao. No escopo operacional vale a regra publicada (fisico ou fresco).
    const currentlyMitigated = shadowScope
      ? freshRead.ok && freshRead.state !== null && MITIGATED_STATES.includes(freshRead.state)
      : physicalMitigated ||
        (freshRead.ok && freshRead.state !== null && MITIGATED_STATES.includes(freshRead.state));
    const evaluation = evaluateTraffic({
      currentlyMitigated,
      consecutiveOverThreshold: counters.over,
      consecutiveBelowRecovery: counters.below,
      hysteresis: {
        triggerSamples: target.triggerSamples,
        recoverySamples: target.recoverySamples,
      },
    });

    const decided = (reason: MitigationAutoBlockReason | null, outcome: MitigationAutoOutcome) =>
      this.record({
        ...withValues,
        retryAttempt,
        samplesOver: counters.over,
        samplesBelow: counters.below,
        outcome,
        reason,
        detail: reason,
      });

    if (currentlyMitigated) {
      // REMOVE automatico NAO existe nesta fase: apenas registra a condicao.
      if (evaluation.result === 'WOULD_RECOVER') {
        return decided('AUTO_REMOVE_DISABLED', 'RECOVERY_PENDING');
      }
      return decided('ALREADY_MITIGATED', 'NO_ACTION');
    }

    // Semantica publicada: igual ao limiar NAO e gatilho (`>` na contagem).
    if (traffic <= threshold) {
      return decided('THRESHOLD_NOT_EXCEEDED', 'NO_ACTION');
    }
    if (counters.over < target.triggerSamples) {
      return decided('SAMPLES_INSUFFICIENT', 'TRIGGER_PENDING');
    }
    const scopeKey = `${target.deviceId}:${target.policyName ?? target.profileId}`;
    const attempt = this.attempts.get(scopeKey);
    /**
     * Fontes com regra de continuidade (FAST) têm cadência curta: reemitir o
     * comando a cada 10 s sobre a MESMA amostra custaria SSH por nada. LEGACY
     * preserva a semântica publicada (reemissão do MESMO `requestId`, que o
     * comando canônico deduplica) — nenhum gate novo é aplicado.
     */
    const strictDispatch = !shadowScope && sampling.maxGapMs !== null;
    if (!newTxSample) {
      retryAttempt = attempt && attempt.failures > 0 ? attempt.failures : null;
      if (strictDispatch) {
        const authorized = this.retryAuthorization(scopeKey, counters, at.getTime(), sampling, attempt);
        if (authorized === null) return decided('DUPLICATE_SAMPLE', 'SKIPPED');
        retryAttempt = authorized;
      }
    }
    if (target.activationDirection === 'tx' && target.direction === 'rx')
      return decided('RX_MONITOR_ONLY', 'ALERT_TRIGGERED');

    // Modo decide a ACAO, nunca a elegibilidade: AUTO e ALERT_ONLY passaram
    // pelos MESMOS gates acima. ALERT_ONLY para aqui, com zero escrita.
    if (target.mode === 'ALERT_ONLY') {
      return decided(null, 'ALERT_TRIGGERED');
    }

    // SHADOW: a hipotese termina aqui. Os gates abaixo sao de AUTORIZACAO DE
    // ESCRITA (operacionais) e nao respondem a pergunta do SHADOW; o bloqueio
    // real correspondente e reportado em `operationalBlock`, ao lado do estado
    // fisico. Nada e escrito e nenhum comando e emitido.
    if (shadowScope) {
      return this.record({
        ...withValues,
        samplesOver: counters.over,
        samplesBelow: counters.below,
        retryAttempt,
        outcome: 'WOULD_ACTIVATE',
        reason: null,
        physicalState: target.runtimeState,
        physicalMitigated,
        operationalBlock:
          target.autoPromotedBySweep === true && this.deps.executionControl?.enabled !== true
            ? 'AUTO_EXECUTION_DISABLED'
            : null,
        detail: physicalMitigated
          ? 'SHADOW: condicoes hipoteticas satisfeitas; estado fisico ja MITIGATED (preservado)'
          : 'SHADOW: condicoes hipoteticas satisfeitas',
      });
    }

    // AUTO-ALL: a flag de AUTORIZACAO (sweep) e a flag de EXECUCAO sao
    // independentes. Com o controle de execucao desligado, um perfil promovido
    // pelo sweep NAO inicia nova ativacao - o gatilho e registrado (WOULD_ACTIVATE)
    // e nada e escrito. AUTO manual/legado nao e afetado e mitigacao ativa
    // permanece intocada (REMOVE e 100% manual).
    if (target.autoPromotedBySweep === true && this.deps.executionControl?.enabled !== true) {
      return decided('AUTO_EXECUTION_DISABLED', 'WOULD_ACTIVATE');
    }
    // Daqui para baixo o target esta apto: o que falta e a autorizacao de escrita.
    if (this.deps.globalMode !== 'AUTO')
      return decided('GLOBAL_MODE_SIMULATION_ONLY', 'WOULD_ACTIVATE');
    if (this.deps.execution.executor !== 'HUAWEI')
      return decided('EXECUTOR_NOT_HUAWEI', 'WOULD_ACTIVATE');
    if (!this.deps.execution.liveWrite) return decided('LIVE_WRITE_DISABLED', 'WOULD_ACTIVATE');
    if (!this.deps.execution.allowedDeviceIds.includes(target.deviceId)) {
      return decided('DEVICE_NOT_ALLOWED', 'WOULD_ACTIVATE');
    }

    // Ultima barreira antes do comando: se a policy (ou o runtime) mudou entre
    // o inicio do tick e agora, nao gastar comando num estado que ja mudou.
    const preCommandRead = await this.readRuntimeState(target.profileId);
    if (
      preCommandRead.ok &&
      preCommandRead.state !== null &&
      MITIGATED_STATES.includes(preCommandRead.state)
    ) {
      return decided('ALREADY_MITIGATED', 'NO_ACTION');
    }

    // F3 (escopo fisico compartilhado): um irmao da MESMA policy ja mitigado (ou
    // com operacao em andamento) significa que a policy fisica JA esta mitigada.
    // O AUTO nao tenta instalar um segundo par; sem irmao comprovado o preflight
    // fisico (read-back real) continua sendo a barreira final.
    const scopeReason = await this.detectScopeMitigation(target);
    if (scopeReason !== null) return decided(scopeReason, 'NO_ACTION');

    // Cooldown/backoff apenas onde foi introduzido (fonte FAST). LEGACY nao
    // ganha janela nova: a versao publicada nao tinha, e o comando e idempotente
    // por `requestId`. O cooldown conta a partir do FIM da execucao real.
    if (strictDispatch) {
      const cooldownMs =
        attempt && attempt.failures > 0
          ? this.failureBackoffFor(attempt.failures)
          : (this.deps.activationCooldownMs ?? 30_000);
      if (
        attempt?.lastOutcomeAtMs !== null &&
        attempt?.lastOutcomeAtMs !== undefined &&
        at.getTime() - attempt.lastOutcomeAtMs < cooldownMs
      ) {
        return decided('ACTIVATION_COOLDOWN', 'SKIPPED');
      }
    }
    this.attempts.set(scopeKey, {
      startedAtMs: at.getTime(),
      lastOutcomeAtMs: attempt?.lastOutcomeAtMs ?? null,
      failures: attempt?.failures ?? 0,
      sampleKey: counters.lastSampleKey,
    });

    const observationHash = createHash('sha256')
      .update(counters.lastSampleKey ?? String(at.getTime()))
      .digest('hex')
      .slice(0, 12);
    // LEGACY preserva o `requestId` publicado (literal). FAST acrescenta a
    // identidade da amostra para que um retry idempotente nunca se confunda com
    // uma amostra nova.
    const requestId = strictDispatch
      ? `auto-activate-${target.profileId}-${counters.triggerStartedAtMs ?? at.getTime()}-${observationHash}`
      : `auto-activate-${target.profileId}-${counters.triggerStartedAtMs ?? at.getTime()}`;
    this.inFlight.add(target.profileId);
    // Publish progress while the canonical operation is awaiting SSH/readback.
    // Three confirmations are not a verified mitigation.
    this.decisions.set(target.profileId, { ...withValues, samplesOver: counters.over, samplesBelow: counters.below,
      outcome: 'TRIGGER_PENDING', reason: null, requestId, commandStatus: 'IN_FLIGHT', verified: false });
    this.deps.logger?.('auto: disparando ACTIVATE', {
      profileId: target.profileId,
      deviceId: target.deviceId,
      requestId,
      ...(retryAttempt !== null ? { retryAttempt } : {}),
    });
    let attemptVerified = false;
    try {
      const commandStarted = this.now().getTime();
      const result = await this.deps.commands.execute({
        requestId,
        action: 'ACTIVATE',
        profileId: target.profileId,
        ...(autoEvidence ? { autoEvidence } : {}),
      });
      const verified = result.ok && result.verified && result.status === 'ACTIVATED_VERIFIED';
      attemptVerified = verified;
      const decision = this.record({
        ...withValues,
        samplesOver: counters.over,
        samplesBelow: counters.below,
        retryAttempt,
        requestId,
        commandStatus: result.status,
        verified,
        notification: result.notification ?? null,
        commandMs: this.now().getTime() - commandStarted,
        ...(result.timingsMs ? { timingsMs: result.timingsMs } : {}),
        totalResponseMs:
          counters.triggerStartedAtMs === null
            ? null
            : this.now().getTime() - counters.triggerStartedAtMs,
        responseDeadlineExceeded:
          counters.triggerStartedAtMs !== null &&
          this.now().getTime() - counters.triggerStartedAtMs > 60_000,
        outcome: verified ? 'ACTIVATED' : 'FAILED',
        reason: verified
          ? null
          : result.status === 'ACTIVATED_VERIFIED'
            ? 'VERIFY_FAILED'
            : this.mapCommandReason(result),
        detail: verified ? null : (result.safeError ?? result.status),
      });
      if (verified) this.lastVerifiedActivate = decision;
      return decision;
    } catch (error) {
      return this.record({
        ...withValues,
        samplesOver: counters.over,
        samplesBelow: counters.below,
        retryAttempt,
        requestId,
        outcome: 'FAILED',
        reason: 'ACTIVATE_FAILED',
        detail: error instanceof Error ? error.message : 'falha no ACTIVATE',
      });
    } finally {
      this.inFlight.delete(target.profileId);
      // A tentativa so conta como "concluida" aqui: o cooldown de sucesso ou o
      // backoff de falha comecam a partir deste instante, nunca do inicio.
      const current = this.attempts.get(scopeKey);
      if (current && current.startedAtMs === at.getTime()) {
        this.attempts.set(scopeKey, {
          ...current,
          lastOutcomeAtMs: this.now().getTime(),
          failures: attemptVerified ? 0 : current.failures + 1,
        });
      }
    }
  }

  private mapCommandReason(result: MitigationAutoCommandResult): MitigationAutoBlockReason {
    if (result.status === 'AUTO_TELEMETRY_UNAVAILABLE') return 'TELEMETRY_UNAVAILABLE';
    if (result.blockedReason === 'PEER_MITIGATION_EXCLUDED') return 'PEER_MITIGATION_EXCLUDED';
    if (result.blockedReason === 'MITIGATION_EXCLUDED') return 'MITIGATION_EXCLUDED';
    // O preflight bloqueado reporta o motivo agregado em `safeError`; sem isto
    // um bloqueio do equipamento virava um generico ACTIVATE_FAILED.
    if (result.safeError?.startsWith('Preflight read-only falhou')) return 'PREFLIGHT_FAILED';
    if (typeof result.blockedReason === 'string' && result.blockedReason.startsWith('preflight')) {
      return 'PREFLIGHT_FAILED';
    }
    // F4: lock ocupado por outra operacao do MESMO escopo.
    if (result.status === 'POLICY_BUSY') return 'POLICY_BUSY';
    if (result.status === 'ACTIVATED_NOT_VERIFIED') return 'VERIFY_FAILED';
    return 'ACTIVATE_FAILED';
  }

  /**
   * Registro da decisao em DUAS camadas (nao muda NADA da decisao em si):
   *  - `debugLogger` (DEBUG): uma linha por profile/tick, detalhe completo;
   *  - `logger` (INFO): transicoes de estado/motivo, operacoes reais e falhas.
   * Decisao normal repetida NAO vira linha: entra no contador e sai no resumo
   * periodico (`auto: resumo de decisoes`).
   */
  private record(decision: MitigationAutoDecision): MitigationAutoDecision {
    this.decisions.set(decision.profileId, decision);
    const history = this.history.get(decision.profileId) ?? [];
    const signature = (d: MitigationAutoDecision) =>
      `${d.outcome}|${d.reason}|${Math.min(d.samplesOver, d.requiredSamples)}|${d.commandStatus}`;
    const previous = history.at(-1);
    if (!previous || signature(previous) !== signature(decision)) {
      history.push(decision);
      if (history.length > 20) history.shift();
      this.history.set(decision.profileId, history);
    }
    this.logDecision(decision);
    return decision;
  }

  private logDecision(decision: MitigationAutoDecision): void {
    const meta = {
      at: decision.at,
      profileId: decision.profileId,
      deviceId: decision.deviceId,
      outcome: decision.outcome,
      reason: decision.reason,
      runtimeState: decision.runtimeState,
      trafficBps: decision.trafficBps,
      thresholdBps: decision.thresholdBps,
      samplesOver: decision.samplesOver,
      samplesBelow: decision.samplesBelow,
      requiredSamples: decision.requiredSamples,
      direction: decision.direction ?? null,
      directionSource: decision.directionSource ?? null,
      promotedBySweep: decision.promotedBySweep ?? null,
      trafficByDirection: decision.trafficByDirection ?? null,
      triggeredDirections: decision.triggeredDirections ?? null,
      detail: decision.detail,
      firstAbnormalAt: decision.firstAbnormalAt ?? null,
      confirmationMs: decision.confirmationMs ?? null,
      commandMs: decision.commandMs ?? null,
      timingsMs: decision.timingsMs ?? null,
      totalResponseMs: decision.totalResponseMs ?? null,
      responseDeadlineExceeded: decision.responseDeadlineExceeded ?? false,
      verified: decision.verified,
      commandStatus: decision.commandStatus,
      requestId: decision.requestId,
      sampleAt: decision.sampleAt ?? null,
      sampleToDecisionMs: decision.sampleToDecisionMs ?? null,
      decisionMs: decision.decisionMs ?? null,
      evaluationScope: decision.evaluationScope ?? 'OPERATIONAL',
      physicalState: decision.physicalState ?? null,
      physicalMitigated: decision.physicalMitigated ?? false,
      operationalBlock: decision.operationalBlock ?? null,
      retryAttempt: decision.retryAttempt ?? null,
      samplingMaxAgeMs: decision.samplingMaxAgeMs ?? null,
      samplingMaxGapMs: decision.samplingMaxGapMs ?? null,
    };
    this.deps.debugLogger?.('auto: decisao (debug)', meta);

    const nowMs = this.now().getTime();
    if (this.summary.startedAtMs === 0) this.summary.startedAtMs = nowMs;
    this.summary.total += 1;
    const outcomeKey = decision.outcome;
    this.summary.byOutcome.set(outcomeKey, (this.summary.byOutcome.get(outcomeKey) ?? 0) + 1);
    const reasonKey = decision.reason ?? 'SEM_BLOQUEIO';
    this.summary.byReason.set(reasonKey, (this.summary.byReason.get(reasonKey) ?? 0) + 1);

    const progress = decision.outcome === 'TRIGGER_PENDING' ? decision.samplesOver : 0;
    const key = `${decision.outcome}|${decision.reason ?? ''}|${decision.runtimeState ?? ''}|${progress}`;
    if (!ALWAYS_LOGGED_OUTCOMES.includes(decision.outcome)) {
      // Sem transicao => decisao normal repetida (o caso dos 35 profiles sem
      // direction para o AUTO a cada 5 s).
      if (this.loggedDecisions.get(decision.profileId) === key) {
        this.summary.suppressed += 1;
        return;
      }
      // Transicao real, mas dentro do silencio minimo do profile (evita
      // metralhadora quando o motivo oscila a cada tick). A chave NAO e gravada:
      // se o estado se mantiver, a proxima janela emite a linha.
      const lastAtMs = this.loggedAtMs.get(decision.profileId) ?? 0;
      if (progress === 0 && lastAtMs !== 0 && nowMs - lastAtMs < this.transitionThrottleMs) {
        this.summary.suppressed += 1;
        return;
      }
    }
    this.loggedDecisions.set(decision.profileId, key);
    this.loggedAtMs.set(decision.profileId, nowMs);
    this.deps.logger?.('auto: decisao', meta);
  }

  /** Resumo das decisoes da janela (substitui as linhas suprimidas). */
  private flushSummaryIfDue(): void {
    const nowMs = this.now().getTime();
    if (this.summary.startedAtMs === 0) return;
    if (nowMs - this.summary.startedAtMs < this.summaryIntervalMs) return;
    const windowSeconds = Math.max(1, Math.round((nowMs - this.summary.startedAtMs) / 1000));
    this.deps.logger?.('auto: resumo de decisoes', {
      windowSeconds,
      decisions: this.summary.total,
      suppressed: this.summary.suppressed,
      byOutcome: Object.fromEntries(this.summary.byOutcome),
      byReason: Object.fromEntries(this.summary.byReason),
    });
    this.summary = newSummary(nowMs);
  }

  /**
   * Somente fontes FAST exigem leitura de runtime. LEGACY preserva a tolerancia
   * publicada (uma falha de leitura nao cria um bloqueio novo). SHADOW nunca
   * exige: o estado simulado e best-effort e nao autoriza escrita.
   */
  private requiresRuntimeRead(target: MitigationAutoTargetState): boolean {
    if (this.deps.evaluationScope === 'SHADOW') return false;
    const rule = this.deps.requireRuntimeRead;
    if (typeof rule === 'function') return rule(target);
    return rule === true;
  }

  /** Backoff por falha transitoria: 15 s, 30 s, 60 s, 120 s (cap). */
  private failureBackoffFor(failures: number): number {
    const base = this.deps.failureBackoffMs ?? 15_000;
    const cap = this.deps.maxFailureBackoffMs ?? 120_000;
    return Math.min(base * 2 ** Math.min(Math.max(failures - 1, 0), 3), cap);
  }

  /**
   * Autoriza reavaliar a MESMA amostra ja confirmada depois de uma falha
   * transitoria (preflight/lock/execucao). Regras:
   *  - nunca reconta (nao chama `countDistinctSample`);
   *  - somente a mesma identidade de amostra que autorizou a tentativa;
   *  - somente enquanto a evidencia continua dentro da janela da fonte;
   *  - limitado por `maxRetriesPerSample` (default 2), com backoff.
   */
  private retryAuthorization(
    scopeKey: string,
    counters: AutoCounters,
    atMs: number,
    window: MitigationSamplingWindow,
    attempt = this.attempts.get(scopeKey),
  ): number | null {
    if (!attempt || attempt.failures === 0) return null;
    if (attempt.failures > (this.deps.maxRetriesPerSample ?? 2)) return null;
    if (attempt.sampleKey === null || attempt.sampleKey !== counters.lastSampleKey) return null;
    if (counters.lastSampleAtMs === null) return null;
    if (atMs - counters.lastSampleAtMs > window.maxAgeMs) return null;
    return attempt.failures;
  }

  private async loadCounters(
    target: MitigationAutoTargetState,
    sampling: MitigationSamplingWindow,
  ): Promise<AutoCounters> {
    const cached = this.counters.get(target.profileId);
    if (cached) return cached;
    const runtime = await this.deps.runtime.get(target.profileId);
    const lastSampleAt = runtime?.lastSampleAt ?? null;
    const fresh =
      lastSampleAt !== null && this.now().getTime() - lastSampleAt.getTime() <= sampling.maxAgeMs;
    // Restart: a identidade da amostra persistida é sempre reidratada (para a
    // MESMA leitura nunca contar duas vezes). As confirmações só sobrevivem no
    // contrato LEGACY, com evidência ainda fresca e no máximo até uma amostra
    // antes do gatilho: o restart exige ao menos uma confirmação nova. FAST
    // sempre recomeça a sequência.
    const rehydrate = fresh && sampling.maxGapMs === null;
    const keep = Math.max(0, target.triggerSamples - 1);
    const counters: AutoCounters = {
      over: rehydrate ? Math.min(Math.max(0, runtime?.triggerCounter ?? 0), keep) : 0,
      below: rehydrate ? Math.max(0, runtime?.recoveryCounter ?? 0) : 0,
      triggerStartedAtMs: null,
      loaded: true,
      lastSampleKey: lastSampleAt?.toISOString() ?? null,
      lastSampleAtMs: lastSampleAt ? lastSampleAt.getTime() : null,
    };
    this.counters.set(target.profileId, counters);
    return counters;
  }

  /**
   * Leitura fresca do runtime (estado + sucesso da leitura). Falha de leitura e
   * tratada como "nao sei": nunca autoriza o motor a sobrescrever estado.
   */
  /**
   * CONTENCAO DE FAMILIA (camada de EXECUCAO, independente de direcao).
   *
   * IPv4 e IPv6 de UMA interface usam os MESMOS contadores SNMP: um unico pico
   * alimenta os dois targets. Em modo AUTO, o alvo IPv6 NUNCA inicia acao BGP
   * sem aprovacao explicita do par, valendo para RX, TX, DUAL, direcao herdada
   * do ENV, direcao persistida, ausencia de direcao, perfis promovidos pelo
   * sweep e policy compartilhada.
   *
   * Aprovacao = `approvedFamilyPairs` contendo ESTE alvo e o irmao IPv4 da mesma
   * interface. Sem irmao IPv4 tambem e fail-closed (nao ha par verificavel).
   */
  private async detectFamilyContention(
    target: MitigationAutoTargetState,
  ): Promise<string[] | null> {
    const family = target.addressFamily ?? 'IPV4';
    if (family === 'IPV4') return null;
    const interfaceId = target.interfaceId;
    if (interfaceId === null) return ['IF_NAO_IDENTIFICADA'];
    let siblings: MitigationAutoTargetState[];
    try {
      siblings = (await this.deps.targets.list()).filter(
        (candidate) =>
          candidate.profileId !== target.profileId &&
          candidate.deviceId === target.deviceId &&
          candidate.interfaceId === interfaceId &&
          candidate.mode === 'AUTO' &&
          (candidate.addressFamily ?? 'IPV4') !== family,
      );
    } catch {
      // Leitura indisponivel NAO autoriza: sem saber os irmaos nao ha prova de
      // seguranca de familia (fail-closed).
      return ['IRMAOS_INDISPONIVEIS'];
    }
    if (siblings.length === 0) return ['SEM_VINCULO_IPV4'];
    const approved = this.deps.approvedFamilyPairs ?? [];
    const unapproved = siblings.filter(
      (sibling) =>
        !approved.some(
          (pair) => pair.includes(target.profileId) && pair.includes(sibling.profileId),
        ),
    );
    return unapproved.length > 0 ? unapproved.map((item) => item.profileId) : null;
  }

  /**
   * F3: o escopo fisico e `deviceId + policyName`. Se qualquer OUTRO target do
   * mesmo escopo esta MITIGATED/RECOVERY_PENDING, a policy ja esta mitigada e
   * um novo ACTIVATE instalaria um SEGUNDO par (proibido). MITIGATING/RECOVERING
   * indicam operacao em andamento (nao competir com ela). Leitura de runtime
   * indisponivel NAO bloqueia: o preflight fisico decide com prova real.
   */
  private async detectScopeMitigation(
    target: MitigationAutoTargetState,
  ): Promise<MitigationAutoBlockReason | null> {
    const policyName = target.policyName ?? null;
    if (policyName === null) return null;
    let siblings: MitigationAutoTargetState[];
    try {
      siblings = (await this.deps.targets.list()).filter(
        (candidate) =>
          candidate.profileId !== target.profileId &&
          candidate.deviceId === target.deviceId &&
          candidate.policyName === policyName,
      );
    } catch {
      return null;
    }
    for (const sibling of siblings) {
      const state = (await this.readRuntimeState(sibling.profileId)).state;
      if (state === 'MITIGATED' || state === 'RECOVERY_PENDING') {
        return 'SCOPE_ALREADY_MITIGATED';
      }
      if (state === 'MITIGATING' || state === 'RECOVERING') {
        return 'SCOPE_OPERATION_IN_FLIGHT';
      }
    }
    return null;
  }

  private async readRuntimeState(
    profileId: string,
  ): Promise<{ ok: boolean; state: MitigationState | null }> {
    try {
      const runtime = await this.deps.runtime.get(profileId);
      return { ok: true, state: runtime?.state ?? null };
    } catch {
      return { ok: false, state: null };
    }
  }

  private async persistCounters(
    target: MitigationAutoTargetState,
    counters: AutoCounters,
    traffic: bigint,
    sampleAt: Date,
    fresh: { ok: boolean; state: MitigationState | null },
  ): Promise<void> {
    await this.deps.runtime.save(target.profileId, {
      triggerCounter: counters.over,
      recoveryCounter: counters.below,
      currentTrafficBps: traffic,
      // lastSampleAt guarda o timestamp da AMOSTRA (freshness + identidade).
      lastSampleAt: sampleAt,
      // O estado so e tocado quando o motor e dono dele TANTO no snapshot
      // quanto na leitura fresca: estado mitigado/desconhecido nunca e
      // rebaixado pelo tick, e falha de leitura nunca autoriza escrita.
      // No escopo SHADOW o snapshot e FISICO e nao governa o estado simulado:
      // vale apenas a leitura do runtime SHADOW.
      ...(fresh.ok &&
      (this.deps.evaluationScope === 'SHADOW' || engineOwnsState(target.runtimeState)) &&
      engineOwnsState(fresh.state)
        ? { state: counters.over >= target.triggerSamples ? 'TRIGGER_PENDING' : 'NORMAL' }
        : {}),
    });
  }
}
