import type { HostPollResult } from './api';
import type { HistoryPeriod } from '@gmj/shared';

/**
 * Feedback de telemetria (F9.6).
 *
 * O botão VERIFICAR AGORA e os gráficos de histórico compartilham estas
 * mensagens: "verificado" não pode esconder que nenhuma amostra nova foi criada,
 * e um período vazio precisa dizer quando foi a última coleta.
 */

export type PollFeedbackTone = 'ok' | 'partial' | 'baseline' | 'warning';

export interface PollFeedback {
  tone: PollFeedbackTone;
  message: string;
}

const RETRY_HINT_FALLBACK_SECONDS = 45;

function formatRetrySeconds(value: number | null | undefined): string {
  const safe = value && value > 0 ? Math.ceil(value) : RETRY_HINT_FALLBACK_SECONDS;
  return `${safe} s`;
}

/**
 * Traduz o resultado REAL do poll para uma mensagem operacional:
 *
 * - sucesso completo (telemetria + óptico);
 * - parcial (só óptico; telemetria aguardando o intervalo mínimo);
 * - baseline atualizado (gap longo/descontinuidade — a taxa virá no próximo poll);
 * - falha óptica (telemetria sim, leitura óptica indisponível);
 * - anti-spam do óptico no poll manual.
 */
export function describePollFeedback(result: HostPollResult): PollFeedback {
  const telemetry = result.telemetry ?? null;
  const optical = result.optical ?? null;
  // Resposta antiga (sem feedback): mantém a mensagem genérica de sucesso.
  if (!telemetry && !optical) {
    return { tone: 'ok', message: 'Equipamento atualizado com sucesso.' };
  }

  const telemetrySampled = telemetry ? telemetry.samples > 0 : false;
  const telemetrySkipped = telemetry ? telemetry.skipped > 0 : false;
  const baselineOnly = telemetry ? telemetry.samples === 0 && telemetry.baselines > 0 : false;
  const opticalSampled = optical?.sampled ?? false;
  const opticalSkipped = optical?.skipped ?? false;
  const opticalRetry = formatRetrySeconds(optical?.retryAfterSeconds);

  if (opticalSkipped && telemetrySampled) {
    return {
      tone: 'warning',
      message: `Telemetria atualizada. Óptico aguardando o intervalo de proteção (${opticalRetry}).`,
    };
  }

  if (opticalSkipped) {
    return {
      tone: 'warning',
      message: `Óptico aguardando o intervalo de proteção (${opticalRetry}).`,
    };
  }

  if (baselineOnly && opticalSampled) {
    return {
      tone: 'baseline',
      message: 'Baseline atualizado. Aguarde 45 s e verifique novamente para obter uma taxa nova.',
    };
  }

  if (baselineOnly) {
    return {
      tone: 'baseline',
      message: 'Baseline de telemetria atualizado. Aguarde 45 s para obter uma taxa nova.',
    };
  }

  if (telemetrySkipped && opticalSampled) {
    return {
      tone: 'partial',
      message: `Óptico atualizado. Telemetria aguardando intervalo mínimo de ${formatRetrySeconds(
        telemetry?.retryAfterSeconds,
      )}.`,
    };
  }

  if (telemetrySkipped) {
    return {
      tone: 'partial',
      message: `Telemetria aguardando intervalo mínimo de ${formatRetrySeconds(
        telemetry?.retryAfterSeconds,
      )}.`,
    };
  }

  if (telemetrySampled && opticalSampled) {
    return { tone: 'ok', message: 'Telemetria e óptico atualizados.' };
  }

  if (telemetrySampled) {
    return { tone: 'partial', message: 'Telemetria atualizada; leitura óptica indisponível.' };
  }

  if (opticalSampled) {
    return { tone: 'ok', message: 'Óptico atualizado; sem amostra nova de telemetria.' };
  }

  return { tone: 'partial', message: 'Equipamento consultado sem amostras novas.' };
}

const PERIOD_LABELS: Record<HistoryPeriod, string> = {
  '15m': '15 min',
  '1h': '1 h',
  '6h': '6 h',
  '24h': '24 h',
  '7d': '7 dias',
};

/** "Sem amostras nas últimas 6 h" — o período selecionado está vazio. */
export function historyEmptyMessage(period: HistoryPeriod): string {
  return `Sem amostras nas últimas ${PERIOD_LABELS[period]}`;
}

/**
 * Idade legível da última coleta: "há 11h 39min", "há 8 min", "agora".
 * `null` quando nunca houve coleta (a UI mostra "Sem coleta anterior").
 */
export function describeCollectionAge(
  collectedAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!collectedAt) return null;
  const timestamp = Date.parse(collectedAt);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes <= 0) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `há ${hours}h ${String(restMinutes).padStart(2, '0')}min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `há ${days}d ${restHours}h`;
}

/** Texto completo do estado vazio: período sem amostra + idade da última coleta. */
export function emptyHistoryNotice(
  period: HistoryPeriod,
  collectedAt: string | null | undefined,
  now: number = Date.now(),
): string {
  const age = describeCollectionAge(collectedAt, now);
  if (!age) return `${historyEmptyMessage(period)} · Sem coleta anterior`;
  return `${historyEmptyMessage(period)} · Última coleta: ${age}`;
}

/**
 * Coleta óptica mais recente da interface: o escalar (`opticalUpdatedAt`) e as
 * lanes (`opticalLanesUpdatedAt`) podem vir de ciclos diferentes; vale o mais
 * novo dos dois.
 */
export function latestOpticalCollectionAt(
  opticalUpdatedAt: string | null | undefined,
  opticalLanesUpdatedAt: string | null | undefined,
): string | null {
  const timestamps = [opticalUpdatedAt, opticalLanesUpdatedAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}
