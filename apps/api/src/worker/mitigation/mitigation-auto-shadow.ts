import type {
  BgpMitigationProfileDto,
  MitigationAutoShadowEntryDto,
  MitigationAutoShadowReportDto,
  MitigationAutoTrafficDirection,
  MitigationAutoDirectionSource,
} from '@gmj/shared';
import type { MitigationAutoDecision } from './mitigation-auto-engine';
import type { MitigationAutoRuntimeStatus } from './mitigation-auto-runtime';

/**
 * Relatorio de SOMBRA do motor AUTO (AUTO-ALL-PREP-1).
 *
 * Somente leitura: cruza a decisao MAIS RECENTE de cada perfil (motor em
 * execucao) com a configuracao persistida (direcao/modo/histerese). Permite ao
 * operador ver exatamente o que o motor faria SEM armar escrita e distingue
 * `ALERT_TRIGGERED` (linha de log) de uma notificacao REALMENTE entregue a
 * camada de midias (n8n/Telegram).
 *
 * Nao escreve nada: nem banco, nem Huawei, nem n8n.
 */
export interface AutoShadowInput {
  generatedAt: string;
  profiles: BgpMitigationProfileDto[];
  runtime:
    | Pick<
        MitigationAutoRuntimeStatus,
        'state' | 'evaluationIntervalMs' | 'lastTickAt' | 'lastError' | 'decisions'
      >
    | null;
}

const MITIGATED_STATES = new Set(['MITIGATED']);
const IN_PROGRESS_STATES = new Set(['MITIGATING', 'RECOVERING', 'RECOVERY_PENDING']);

function outcomeWouldActivate(outcome: string): boolean {
  // `WOULD_ACTIVATE` = gates passaram e so falta autorizacao de escrita.
  // `ALERT_TRIGGERED` = o perfil esta em ALERT_ONLY (sombra) e TERIA mitigado.
  return outcome === 'WOULD_ACTIVATE' || outcome === 'ALERT_TRIGGERED';
}

function directionFromProfile(
  profile: BgpMitigationProfileDto,
): MitigationAutoTrafficDirection | null {
  return profile.autoTrafficDirection ?? null;
}

/** O motor usa `rx`/`tx` minusculo; o DTO publico usa `RX`/`TX`. */
function toPublicDirection(value: 'rx' | 'tx' | null | undefined): MitigationAutoTrafficDirection | null {
  if (value === 'rx') return 'RX';
  if (value === 'tx') return 'TX';
  return null;
}

function directionSourceFromProfile(
  profile: BgpMitigationProfileDto,
): MitigationAutoDirectionSource | null {
  return profile.autoTrafficDirection ? 'PROFILE' : null;
}

function modeWeight(mode: string): number {
  if (mode === 'AUTO') return 0;
  if (mode === 'ALERT_ONLY') return 1;
  return 2;
}

export function buildAutoShadowReport(input: AutoShadowInput): MitigationAutoShadowReportDto {
  const decisions = new Map<string, MitigationAutoDecision>();
  for (const decision of input.runtime?.decisions ?? []) {
    const previous = decisions.get(decision.profileId);
    if (previous === undefined || decision.at > previous.at) decisions.set(decision.profileId, decision);
  }

  const entries: MitigationAutoShadowEntryDto[] = input.profiles
    .filter((profile) => profile.persisted)
    .map((profile) => {
      const decision = decisions.get(profile.id) ?? null;
      const runtimeState = profile.runtimeState ?? decision?.runtimeState ?? null;
      return {
        profileId: profile.id,
        customer: profile.customer,
        policyName: profile.policyName,
        interfaceId: profile.interfaceId,
        interfaceName: profile.interfaceName,
        addressFamily: profile.addressFamily,
        mode: profile.mode,
        enabled: profile.enabled,
        direction: toPublicDirection(decision?.direction) ?? directionFromProfile(profile),
        directionSource: decision?.directionSource ?? directionSourceFromProfile(profile),
        effectiveBandwidthBps: profile.effectiveBandwidthBps,
        bandwidthSource: profile.bandwidthSource ?? null,
        thresholdBps: decision?.thresholdBps ?? null,
        recoveryThresholdBps: decision?.recoveryThresholdBps ?? null,
        trafficBps: decision?.trafficBps ?? null,
        samplesOver: decision?.samplesOver ?? 0,
        requiredSamples: profile.triggerSamples ?? decision?.requiredSamples ?? 3,
        samplesBelow: decision?.samplesBelow ?? 0,
        requiredRecoverySamples: profile.recoverySamples ?? 12,
        wouldActivate: decision !== null && outcomeWouldActivate(decision.outcome),
        outcome: decision?.outcome ?? null,
        reason: decision?.reason ?? null,
        trafficByDirection: decision?.trafficByDirection ?? null,
        triggeredDirections: (decision?.triggeredDirections ?? [])
          .map((value) => toPublicDirection(value))
          .filter((value): value is MitigationAutoTrafficDirection => value !== null),
        blockedReason:
          decision?.outcome === 'BLOCKED' ? decision.reason : (profile.blockedReason ?? null),
        readiness: profile.readiness,
        snapshotAvailable: profile.snapshotAvailable,
        runtimeState,
        sharedPolicy: profile.sharedPolicy,
        sharedPolicyTargets: profile.sharedPolicyTargets,
        sharedPolicyAutomationBlocked: profile.autoBlockedReason === 'SHARED_POLICY',
        // Distincao explicita: ALERT_TRIGGERED nunca vai para a midia hoje.
        notificationDelivery:
          decision?.notification?.published === true
            ? ('N8N_MEDIA' as const)
            : ('LOG_ONLY' as const),
        decisionAt: decision?.at ?? null,
      };
    })
    .sort(
      (left, right) =>
        modeWeight(left.mode) - modeWeight(right.mode) ||
        (left.policyName ?? '').localeCompare(right.policyName ?? '') ||
        (left.interfaceName ?? '').localeCompare(right.interfaceName ?? ''),
    );

  return {
    generatedAt: input.generatedAt,
    engine: {
      state: input.runtime?.state ?? 'OFF',
      evaluationIntervalMs: input.runtime?.evaluationIntervalMs ?? 0,
      lastTickAt: input.runtime?.lastTickAt ?? null,
      lastError: input.runtime?.lastError ?? null,
    },
    summary: {
      total: entries.length,
      auto: entries.filter((entry) => entry.mode === 'AUTO').length,
      alertOnly: entries.filter((entry) => entry.mode === 'ALERT_ONLY').length,
      disabled: entries.filter((entry) => entry.mode === 'DISABLED').length,
      directionConfigured: entries.filter((entry) => entry.direction !== null).length,
      awaitingDirection: entries.filter(
        (entry) => entry.mode === 'ALERT_ONLY' && entry.enabled && entry.direction === null,
      ).length,
      shadowActive: entries.filter(
        (entry) => entry.mode === 'ALERT_ONLY' && entry.direction !== null,
      ).length,
      blocked: entries.filter((entry) => entry.outcome === 'BLOCKED').length,
      wouldActivate: entries.filter((entry) => entry.wouldActivate).length,
      mitigated: entries.filter(
        (entry) => entry.runtimeState !== null && MITIGATED_STATES.has(entry.runtimeState),
      ).length,
      inProgress: entries.filter(
        (entry) => entry.runtimeState !== null && IN_PROGRESS_STATES.has(entry.runtimeState),
      ).length,
    },
    entries,
  };
}
