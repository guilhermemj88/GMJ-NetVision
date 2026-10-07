'use client';

import { useMemo } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  acknowledgeAlarm,
  acknowledgeOperationalOccurrence,
  getAlertCenter,
  getAlertCenterSummary,
} from '@/lib/api';
import {
  ALERT_CENTER_DEFAULT_LIMIT,
  type AlertCenterItem,
  type AlertCenterListQuery,
  type AlertCenterResponse,
  type AlertCenterSummary,
} from '@gmj/shared';

/** Mesmo ciclo do painel compacto: uma leitura a cada 30s, deduplicada. */
export const ALERT_CENTER_REFRESH_INTERVAL_MS = 30_000;
/** O badge nao precisa da mesma frequencia da tela. */
export const ALERT_CENTER_SUMMARY_REFRESH_INTERVAL_MS = 60_000;

export const ALERT_CENTER_PAGE_SIZE = ALERT_CENTER_DEFAULT_LIMIT;

/**
 * Mesma query key usada pelo badge e pelos cards: qualquer leitura da Central
 * reaproveita o resumo em cache (nunca um polling paralelo so para o badge).
 */
export const ALERT_CENTER_SUMMARY_KEY = ['alert-center', 'summary'] as const;

function invalidateAlertCenter(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['alert-center'] });
  // O painel compacto e a Central mostram os mesmos alarmes.
  void queryClient.invalidateQueries({ queryKey: ['alarms'] });
}

/** Pagina da Central: itens + total + resumo operacional. */
export function useAlertCenterList(query: AlertCenterListQuery) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['alert-center', 'list', query],
    queryFn: () => getAlertCenter(query),
    refetchInterval: ALERT_CENTER_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    placeholderData: (previous) => previous,
    // Alimenta o badge/cards com os numeros que vieram junto da pagina.
    select: (data: AlertCenterResponse) => {
      queryClient.setQueryData(ALERT_CENTER_SUMMARY_KEY, { summary: data.summary });
      return data;
    },
  });
}

const NO_SUMMARY: AlertCenterSummary = {
  alarmsActive: 0,
  alarmsActiveCritical: 0,
  alarmsActiveMajor: 0,
  alarmsActiveWarning: 0,
  alarmsActiveInfo: 0,
  alarmsActiveUnacknowledged: 0,
  alarmsActiveAcknowledged: 0,
  occurrencesUnacknowledged: 0,
  occurrencesAcknowledged: 0,
  occurrencesQuiet24h: 0,
};

/** Resumo operacional (badge + cards). Nunca quebra a UI se a leitura falhar. */
export function useAlertCenterSummary(enabled = true): AlertCenterSummary {
  const query = useQuery({
    queryKey: ALERT_CENTER_SUMMARY_KEY,
    queryFn: getAlertCenterSummary,
    enabled,
    refetchInterval: ALERT_CENTER_SUMMARY_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: 20_000,
  });
  return useMemo(() => query.data?.summary ?? NO_SUMMARY, [query.data]);
}

export interface AcknowledgeBatchResult {
  acknowledgedAlarms: number;
  acknowledgedOccurrences: number;
  failures: string[];
  /** Itens que o operador marcou e continuam sem ACK (recarregar/quebrar lote). */
  failedIds: string[];
}

/**
 * ACK em lote com resultado PARCIAL honesto: cada categoria chama o endpoint
 * dela e uma falha nunca e reportada como sucesso. O primeiro ACK e o que fica
 * registrado no servidor (idempotente).
 */
export function useAcknowledgeAlertItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (items: readonly AlertCenterItem[]): Promise<AcknowledgeBatchResult> => {
      const alarms = items.filter((item) => item.category === 'ALARM');
      const occurrences = items.filter((item) => item.category === 'OCCURRENCE');
      const failures: string[] = [];
      const failedIds: string[] = [];
      let acknowledgedAlarms = 0;
      let acknowledgedOccurrences = 0;

      for (const alarm of alarms) {
        try {
          await acknowledgeAlarm(alarm.id);
          acknowledgedAlarms += 1;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'falha ao reconhecer alarme');
          failedIds.push(alarm.id);
        }
      }
      for (const occurrence of occurrences) {
        try {
          await acknowledgeOperationalOccurrence(occurrence.id);
          acknowledgedOccurrences += 1;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'falha ao reconhecer ocorrência');
          failedIds.push(occurrence.id);
        }
      }
      return { acknowledgedAlarms, acknowledgedOccurrences, failures, failedIds };
    },
    onSettled: () => invalidateAlertCenter(queryClient),
  });
}

/** ACK de um unico item (drawer e acao de linha). */
export function useAcknowledgeAlertItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (item: AlertCenterItem) => {
      if (item.category === 'ALARM') {
        await acknowledgeAlarm(item.id);
        return;
      }
      await acknowledgeOperationalOccurrence(item.id);
    },
    onSettled: () => invalidateAlertCenter(queryClient),
  });
}
