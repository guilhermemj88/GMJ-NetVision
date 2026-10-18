import type { FastBridgeConfig } from './fast-observation-bridge';
import type { FastPollerConfig } from '../../infrastructure/snmp/fast-traffic-poller';
import type { MitigationTrafficSample } from './mitigation-traffic-source';

/**
 * Contrato temporal de UMA fonte de telemetria.
 *
 * `maxAgeMs` é o frescor máximo da amostra no instante da decisão.
 * `maxGapMs` é a continuidade máxima entre confirmações consecutivas e pode ser
 * `null`: `null` significa "esta fonte não tem regra de continuidade", que é o
 * contrato publicado do LEGACY (o motor anterior só validava idade, na fonte).
 */
export interface MitigationSamplingWindow {
  maxAgeMs: number;
  maxGapMs: number | null;
}

/** FAST: frescor 30 s e continuidade 45 s (contrato do Gate 2). */
export const FAST_SAMPLING_WINDOW: MitigationSamplingWindow = {
  maxAgeMs: 30_000,
  maxGapMs: 45_000,
};

/**
 * LEGACY: preserva o frescor publicado (600 s por padrão) e NÃO cria limite de
 * continuidade. Introduzir `maxGapMs` aqui mudaria o comportamento da BHNET,
 * cuja coleta real roda a cada 126–248 s.
 */
export function legacySamplingWindow(maxAgeMs: number): MitigationSamplingWindow {
  return { maxAgeMs, maxGapMs: null };
}

/** `true` somente quando uma fonte FAST está de fato roteada para este perfil. */
export function isFastRoutedProfile(
  profileId: string,
  config: { bridge: FastBridgeConfig; embedded: FastPollerConfig },
): boolean {
  if (config.bridge.mode === 'ENFORCE' && config.bridge.enforceProfileIds.includes(profileId))
    return true;
  return config.embedded.mode === 'ENFORCE' && config.embedded.profileIds.includes(profileId);
}

/**
 * Janela da fonte REALMENTE roteada para o motor canônico. SHADOW não roteia
 * FAST: nesse modo o perfil continua LEGACY, mesmo que esteja no escopo do
 * bridge. Aplicar a janela da simulação ao motor operacional foi a causa da
 * regressão do Gate 2.
 */
export function samplingWindowForProfile(
  profileId: string,
  config: {
    legacyMaxAgeMs: number;
    bridge: FastBridgeConfig;
    embedded: FastPollerConfig;
  },
): MitigationSamplingWindow {
  if (config.bridge.mode === 'ENFORCE' && config.bridge.enforceProfileIds.includes(profileId))
    return { maxAgeMs: config.bridge.maxAgeMs, maxGapMs: config.bridge.maxGapMs };
  if (config.embedded.mode === 'ENFORCE' && config.embedded.profileIds.includes(profileId))
    return { maxAgeMs: config.embedded.maxGapMs, maxGapMs: config.embedded.maxGapMs };
  return legacySamplingWindow(config.legacyMaxAgeMs);
}

function sampleIntervalMs(sample: MitigationTrafficSample): number {
  return sample.rateStartAt ? sample.occurredAt!.getTime() - sample.rateStartAt.getTime() : 0;
}

export function withinSamplingWindow(
  sample: MitigationTrafficSample | null,
  atMs: number,
  window: MitigationSamplingWindow,
): sample is MitigationTrafficSample {
  if (!sample || sample.bps < 0n) return false;
  if (!sample.occurredAt) return true; // deterministic fixtures only
  const age = atMs - sample.occurredAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > window.maxAgeMs) return false;
  if (window.maxGapMs === null) return true;
  const interval = sampleIntervalMs(sample);
  return Number.isFinite(interval) && interval >= 0 && interval <= window.maxGapMs;
}

/** Recheck the same source window and continuity after the canonical preflight. */
export function matchesAutoEvidence(
  sample: MitigationTrafficSample | null,
  evidence: { sampleAt: string; continuityKey: string },
  window: MitigationSamplingWindow,
  atMs: number,
): sample is MitigationTrafficSample {
  return (
    withinSamplingWindow(sample, atMs, window) &&
    sample.occurredAt !== null &&
    sample.continuityKey === evidence.continuityKey &&
    sample.occurredAt.getTime() >= Date.parse(evidence.sampleAt)
  );
}
