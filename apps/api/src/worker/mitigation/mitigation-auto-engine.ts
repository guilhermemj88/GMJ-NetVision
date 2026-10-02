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
  | 'NO_SAFE_TEMPORARY_NODE'
  | 'GLOBAL_MODE_SIMULATION_ONLY'
  | 'EXECUTOR_NOT_HUAWEI'
  | 'LIVE_WRITE_DISABLED'
  | 'DEVICE_NOT_ALLOWED'
  | 'PREFLIGHT_FAILED'
  | 'ACTIVATE_FAILED'
  | 'VERIFY_FAILED'
  | 'CONCURRENT_TICK';

export interface MitigationAutoTargetState {
  profileId: string;
  deviceId: string;
  interfaceId: string | null;
  customer: string | null;
  mode: MitigationProfileMode;
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

export class MitigationAutoEngine {
  private readonly counters = new Map<string, AutoCounters>();
  private readonly inFlight = new Set<string>();
  /** Cadeia de avaliações por profile (serializa ticks concorrentes). */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly decisions = new Map<string, MitigationAutoDecision>();
  private lastVerifiedActivate: MitigationAutoDecision | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: MitigationAutoEngineDeps) {
    this.now = deps.now ?? (() => new Date());
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
    await this.persistCounters(target, counters, traffic, sample.occurredAt ?? at);

    const currentlyMitigated =
      target.runtimeState !== null && MITIGATED_STATES.includes(target.runtimeState);
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
    if (typeof result.blockedReason === 'string' && result.blockedReason.startsWith('preflight')) {
      return 'PREFLIGHT_FAILED';
    }
    if (result.status === 'ACTIVATED_NOT_VERIFIED') return 'VERIFY_FAILED';
    return 'ACTIVATE_FAILED';
  }

  private record(decision: MitigationAutoDecision): MitigationAutoDecision {
    this.deps.logger?.('auto: decisao', {
      profileId: decision.profileId,
      outcome: decision.outcome,
      reason: decision.reason,
    });
    return decision;
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

  private async persistCounters(
    target: MitigationAutoTargetState,
    counters: AutoCounters,
    traffic: bigint,
    sampleAt: Date,
  ): Promise<void> {
    await this.deps.runtime.save(target.profileId, {
      triggerCounter: counters.over,
      recoveryCounter: counters.below,
      currentTrafficBps: traffic,
      // lastSampleAt guarda o timestamp da AMOSTRA (freshness + identidade).
      lastSampleAt: sampleAt,
      // O estado so e tocado quando o motor e dono dele: um target ja mitigado
      // nao pode ter o estado rebaixado para NORMAL pelo AUTO.
      ...(target.runtimeState !== null && MITIGATED_STATES.includes(target.runtimeState)
        ? {}
        : { state: counters.over >= target.triggerSamples ? 'TRIGGER_PENDING' : 'NORMAL' }),
    });
  }
}