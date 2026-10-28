
/**
 * S5 / REVIEW-05 — POLITICA de alerta de deteccao (episodio de ataque).
 *
 * Modulo PURO (sem I/O): valida os limites de ENV e concentra os defaults.
 * Motivo (R5-7): os valores de ENV eram aceitos com qualquer numero > 0 —
 * inclusive fracionario e 1 ms — o que produzia dezenas de alertas por minuto.
 * Aqui todo valor fora da faixa cai no DEFAULT e e REPORTADO (`rejected`), nunca
 * aplicado silenciosamente.
 */

/** Piso do silencio que delimita episodio (R5-5/R5-7). */
export const MIN_EPISODE_IDLE_MS = 60_000;
/** Piso da repeticao explicita: nunca menos de 5 minutos entre lembretes. */
export const MIN_REPEAT_MS = 300_000;
/** Piso do intervalo minimo entre EMISSOES por profile (R5-6, crash-loop). */
export const MIN_ALERT_INTERVAL_MS = 60_000;

export const DEFAULT_EPISODE_IDLE_MS = 120_000;
export const DEFAULT_ALERT_INTERVAL_MS = 30 * 60_000;
/** Teto de vida de um episodio sem recuperacao comprovada (rede de seguranca). */
export const DEFAULT_EPISODE_MAX_MS = 6 * 60 * 60_000;
/**
 * Backoff de entrega (R5-4 / RC6-A2): 30 s, 1 min, 2 min, 5 min, 10 min.
 * A ultima faixa se repete ate o limite de tentativas — o objetivo e atravessar
 * indisponibilidade de alguns minutos do n8n, nao desistir em 2,5 min.
 */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000, 600_000,
];

export interface DetectionAlertPolicy {
  /** Silencio de DETECCAO que delimita o episodio (>= 60 s). */
  episodeIdleMs: number;
  /** Lembrete enquanto o MESMO episodio persiste. `null` = desligado. */
  repeatEveryMs: number | null;
  /** Intervalo minimo entre emissoes do MESMO profile, entre episodios. */
  minAlertIntervalMs: number;
  /** Tentativas de entrega por episodio antes de FAILED observavel. */
  maxDeliveryAttempts: number;
  /** Backoff por tentativa (ms). */
  retryBackoffMs: readonly number[];
  /** Vida maxima do episodio sem recuperacao comprovada. */
  episodeMaxMs: number;
}

export interface DetectionAlertPolicyInput {
  episodeIdleSeconds?: number | null | undefined;
  repeatSeconds?: number | null | undefined;
  alertIntervalSeconds?: number | null | undefined;
  maxDeliveryAttempts?: number | null | undefined;
}

function wholeSecondsToMs(
  value: number | null | undefined,
  minimumMs: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  const ms = value * 1000;
  if (ms < minimumMs) return null;
  return ms;
}

/**
 * Resolve a politica efetiva. `rejected` lista os nomes de ENV recusados —
 * o chamador deve registrar WARN; nunca ha aplicacao silenciosa de valor invalido.
 */
export function resolveDetectionAlertPolicy(input: DetectionAlertPolicyInput = {}): {
  policy: DetectionAlertPolicy;
  rejected: string[];
} {
  const rejected: string[] = [];

  const idle = wholeSecondsToMs(input.episodeIdleSeconds, MIN_EPISODE_IDLE_MS);
  if (input.episodeIdleSeconds !== undefined && input.episodeIdleSeconds !== null && idle === null) {
    rejected.push('MITIGATION_AUTO_DETECTION_EPISODE_IDLE_SECONDS');
  }

  let repeat: number | null = null;
  if (input.repeatSeconds !== undefined && input.repeatSeconds !== null) {
    repeat = wholeSecondsToMs(input.repeatSeconds, MIN_REPEAT_MS);
    if (repeat === null) rejected.push('MITIGATION_AUTO_DETECTION_REPEAT_SECONDS');
  }

  const interval = wholeSecondsToMs(input.alertIntervalSeconds, MIN_ALERT_INTERVAL_MS);
  if (
    input.alertIntervalSeconds !== undefined &&
    input.alertIntervalSeconds !== null &&
    interval === null
  ) {
    rejected.push('MITIGATION_AUTO_DETECTION_INTERVAL_SECONDS');
  }

  let maxAttempts = 12;
  if (input.maxDeliveryAttempts !== undefined && input.maxDeliveryAttempts !== null) {
    const value = input.maxDeliveryAttempts;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 50) {
      rejected.push('MITIGATION_AUTO_DETECTION_MAX_ATTEMPTS');
    } else {
      maxAttempts = value;
    }
  }

  return {
    policy: {
      episodeIdleMs: idle ?? DEFAULT_EPISODE_IDLE_MS,
      repeatEveryMs: repeat,
      minAlertIntervalMs: interval ?? DEFAULT_ALERT_INTERVAL_MS,
      maxDeliveryAttempts: maxAttempts,
      retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS,
      episodeMaxMs: DEFAULT_EPISODE_MAX_MS,
    },
    rejected,
  };
}
