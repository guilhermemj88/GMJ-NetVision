import { evaluateTraffic } from '../../infrastructure/bgp/mitigation/mitigation-state-machine';
import type {
  MitigationMode,
  MitigationProfileMode,
  MitigationState,
} from '../../infrastructure/bgp/mitigation/mitigation-types';
import type { MitigationExecutorKind } from '../../infrastructure/bgp/mitigation/mitigation-execution-config';
import type { MitigationTrafficSource } from './mitigation-traffic-source';

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
  | 'CONCURRENT_TICK';

export interface MitigationAutoTargetState {
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
}

export interface MitigationAutoDecision {
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
  /** `true` = policy compartilhada com automacao bloqueada por config. */
  sharedPolicyAutomationBlocked?: boolean;
  requestId: string | null;
  commandStatus: string | null;
  verified: boolean;
  notification: { published: boolean; skipped: boolean } | null;
  detail: string | null;
}

export interface MitigationAutoEngineDeps {
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
}

interface AutoCounters {
  over: number;
  below: number;
  triggerStartedAtMs: number | null;
  loaded: boolean;
  /** Identidade da ultima amostra contada (distinct samples por timestamp). */
  lastSampleKey: string | null;
  /** Timestamp (ms) da ultima amostra contada, para exigir monotonicidade. */
  lastSampleAtMs: number | null;
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
  private readonly counters = new Map<string, AutoCounters>();
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
    this.now = deps.now ?? (() => new Date());
    this.summaryIntervalMs = deps.summaryIntervalMs ?? 300_000;
    this.transitionThrottleMs = deps.transitionThrottleMs ?? 30_000;
  }

  /** Ultima decisao por target (observabilidade da UI/health). */
  getDecisions(): MitigationAutoDecision[] {
    return [...this.decisions.values()];
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
    for (const target of targets) {
      // Erro em UM profile nunca derruba a avaliacao dos outros.
      try {
        const decision = await this.evaluate(target);
        this.decisions.set(target.profileId, decision);
        result.push(decision);
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
        result.push(decision);
      }
    }
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
    const at = this.now();
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

    // IPv4/IPv6 da MESMA interface compartilham contadores: AUTO simultaneo nas
    // duas familias exige aprovacao explicita do par (fail-closed).
    if (target.mode === 'AUTO') {
      const contendedBy = await this.detectFamilyContention(target);
      if (contendedBy !== null) {
        return this.record({
          ...base,
          outcome: 'BLOCKED',
          reason: 'FAMILY_CONTENTION_UNRESOLVED',
          detail: `Auto simultaneo IPv4/IPv6 no mesmo escopo sem aprovacao (par com ${contendedBy.join(', ')})`,
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

    const sample = await this.deps.traffic.sampleWithId({
      profileId: target.profileId,
      deviceId: target.deviceId,
      interfaceId: target.interfaceId,
      bandwidthBps: target.effectiveBandwidthBps,
    });
    if (sample === null) return block('TELEMETRY_UNAVAILABLE');
    const traffic = sample.bps;

    const threshold = (target.effectiveBandwidthBps * BigInt(target.triggerPercent)) / 100n;
    const recoveryThreshold =
      (target.effectiveBandwidthBps * BigInt(target.recoveryPercent)) / 100n;
    const withValues = {
      ...base,
      trafficBps: traffic.toString(),
      thresholdBps: threshold.toString(),
      recoveryThresholdBps: recoveryThreshold.toString(),
    };

    const counters = await this.loadCounters(target);
    // CRITICO: so conta sample novo quando a IDENTIDADE da telemetria muda.
    // 3 ticks lendo a MESMA InterfaceMetricSample valem 1 sample, nunca 3.
    // Regra de amostra distinta:
    //   - com occurredAt real: exige MONOTONICIDADE (T > lastSampleAt).
    //     Igual => nao conta; menor (telemetria atrasada/reordenada) => nao conta.
    //   - sem occurredAt (fontes de teste): identidade por sampleKey.
    let isNewSample: boolean;
    if (sample.occurredAt) {
      const atMs = sample.occurredAt.getTime();
      isNewSample = counters.lastSampleAtMs === null || atMs > counters.lastSampleAtMs;
      if (isNewSample) counters.lastSampleAtMs = atMs;
    } else {
      isNewSample = counters.lastSampleKey !== sample.sampleKey;
    }
    counters.lastSampleKey = sample.sampleKey;
    if (isNewSample) {
      if (traffic > threshold) {
        counters.over += 1;
        counters.below = 0;
        if (counters.triggerStartedAtMs === null) counters.triggerStartedAtMs = at.getTime();
      } else if (traffic < recoveryThreshold) {
        counters.below += 1;
        counters.over = 0;
      } else {
        counters.over = 0;
        counters.below = 0;
        counters.triggerStartedAtMs = null;
      }
    }
    await this.persistCounters(target, counters, traffic, sample.occurredAt ?? at, freshRead);

    const currentlyMitigated =
      (target.runtimeState !== null && MITIGATED_STATES.includes(target.runtimeState)) ||
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

    if (traffic <= threshold) {
      return decided('THRESHOLD_NOT_EXCEEDED', 'NO_ACTION');
    }
    if (counters.over < target.triggerSamples) {
      return decided('SAMPLES_INSUFFICIENT', 'TRIGGER_PENDING');
    }

    // Modo decide a ACAO, nunca a elegibilidade: AUTO e ALERT_ONLY passaram
    // pelos MESMOS gates acima. ALERT_ONLY para aqui, com zero escrita.
    if (target.mode === 'ALERT_ONLY') {
      return decided(null, 'ALERT_TRIGGERED');
    }

    // Daqui para baixo o target esta apto: o que falta e a autorizacao de escrita.
    if (this.deps.globalMode !== 'AUTO') return decided('GLOBAL_MODE_SIMULATION_ONLY', 'WOULD_ACTIVATE');
    if (this.deps.execution.executor !== 'HUAWEI') return decided('EXECUTOR_NOT_HUAWEI', 'WOULD_ACTIVATE');
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

    const requestId = `auto-activate-${target.profileId}-${counters.triggerStartedAtMs ?? at.getTime()}`;
    this.inFlight.add(target.profileId);
    this.deps.logger?.('auto: disparando ACTIVATE', {
      profileId: target.profileId,
      deviceId: target.deviceId,
      requestId,
    });
    try {
      const result = await this.deps.commands.execute({
        requestId,
        action: 'ACTIVATE',
        profileId: target.profileId,
      });
      const verified = result.ok && result.verified && result.status === 'ACTIVATED_VERIFIED';
      const decision = this.record({
        ...withValues,
        samplesOver: counters.over,
        samplesBelow: counters.below,
        requestId,
        commandStatus: result.status,
        verified,
        notification: result.notification ?? null,
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
        requestId,
        outcome: 'FAILED',
        reason: 'ACTIVATE_FAILED',
        detail: error instanceof Error ? error.message : 'falha no ACTIVATE',
      });
    } finally {
      this.inFlight.delete(target.profileId);
    }
  }

  private mapCommandReason(result: MitigationAutoCommandResult): MitigationAutoBlockReason {
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
    this.logDecision(decision);
    return decision;
  }

  private logDecision(decision: MitigationAutoDecision): void {
    const meta = {
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
      detail: decision.detail,
    };
    this.deps.debugLogger?.('auto: decisao (debug)', meta);

    const nowMs = this.now().getTime();
    if (this.summary.startedAtMs === 0) this.summary.startedAtMs = nowMs;
    this.summary.total += 1;
    const outcomeKey = decision.outcome;
    this.summary.byOutcome.set(outcomeKey, (this.summary.byOutcome.get(outcomeKey) ?? 0) + 1);
    const reasonKey = decision.reason ?? 'SEM_BLOQUEIO';
    this.summary.byReason.set(reasonKey, (this.summary.byReason.get(reasonKey) ?? 0) + 1);

    const key = `${decision.outcome}|${decision.reason ?? ''}|${decision.runtimeState ?? ''}`;
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
      if (lastAtMs !== 0 && nowMs - lastAtMs < this.transitionThrottleMs) {
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

  private async loadCounters(target: MitigationAutoTargetState): Promise<AutoCounters> {
    const cached = this.counters.get(target.profileId);
    if (cached) return cached;
    const runtime = await this.deps.runtime.get(target.profileId);
    const counters: AutoCounters = {
      over: runtime?.triggerCounter ?? 0,
      below: runtime?.recoveryCounter ?? 0,
      triggerStartedAtMs: null,
      loaded: true,
      // Reidrata a identidade do ultimo sample (sobrevive a restart).
      lastSampleKey: runtime?.lastSampleAt?.toISOString() ?? null,
      lastSampleAtMs: runtime?.lastSampleAt ? runtime.lastSampleAt.getTime() : null,
    };
    this.counters.set(target.profileId, counters);
    return counters;
  }

  /**
   * Leitura fresca do runtime (estado + sucesso da leitura). Falha de leitura e
   * tratada como "nao sei": nunca autoriza o motor a sobrescrever estado.
   */
  /**
   * IPv4 e IPv6 de UMA interface usam os MESMOS contadores SNMP: um unico pico
   * alimenta os dois targets. Com as DUAS familias em AUTO (e direcao
   * configurada) o mesmo ataque abriria duas ativacoes fisicas em policies
   * diferentes - inclusive a familia que NAO foi atacada. Fail-closed: a
   * familia secundaria (nao-IPv4) fica bloqueada ate o operador aprovar o par
   * explicitamente (`MITIGATION_AUTO_FAMILY_PAIRS_ALLOWED`).
   *
   * ALERT_ONLY (modo sombra) NAO e afetado: sem escrita, a sombra pode medir as
   * duas familias enquanto o operador coleta evidencia.
   */
  private async detectFamilyContention(
    target: MitigationAutoTargetState,
  ): Promise<string[] | null> {
    const family = target.addressFamily ?? 'IPV4';
    if (family === 'IPV4') return null;
    const interfaceId = target.interfaceId;
    if (interfaceId === null || target.direction === null || target.direction === undefined) {
      return null;
    }
    let siblings: MitigationAutoTargetState[];
    try {
      siblings = (await this.deps.targets.list()).filter(
        (candidate) =>
          candidate.profileId !== target.profileId &&
          candidate.deviceId === target.deviceId &&
          candidate.interfaceId === interfaceId &&
          candidate.mode === 'AUTO' &&
          (candidate.direction ?? null) !== null &&
          (candidate.addressFamily ?? 'IPV4') !== family,
      );
    } catch {
      // Leitura indisponivel NAO bloqueia: o preflight fisico segue como ultima
      // barreira (mesma semantica do F3).
      return null;
    }
    if (siblings.length === 0) return null;
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
      ...(fresh.ok && engineOwnsState(target.runtimeState) && engineOwnsState(fresh.state)
        ? { state: counters.over >= target.triggerSamples ? 'TRIGGER_PENDING' : 'NORMAL' }
        : {}),
    });
  }
}