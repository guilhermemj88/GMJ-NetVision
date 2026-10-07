'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  acknowledgeAlarm,
  getAlarmOccurrences,
  getAlarmSuppressions,
  getAlarms,
  getRecentResolvedAlarms,
  releaseAlarmSuppression,
  suppressAlarm,
  type SuppressAlarmPayload,
} from '@/lib/api';
import type { Alarm, AlarmSuppression, InterfaceOccurrence } from '@gmj/shared';

/** Mesmo ciclo de atualização do mapa; react-query deduplica por chave. */
export const ALARM_REFRESH_INTERVAL_MS = 30_000;

/**
 * Array vazio ESTÁVEL. Devolver um `[]` novo a cada render enquanto a query
 * ainda não tem dados faria todo `useMemo` que depende dele recalcular e
 * entrar em loop de renderização.
 */
const NO_ALARMS: readonly Alarm[] = Object.freeze([]) as readonly Alarm[];

export function useActiveAlarms(enabled = true): Alarm[] {
  const query = useQuery({
    queryKey: ['alarms'],
    queryFn: getAlarms,
    enabled,
    refetchInterval: ALARM_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  return query.data ?? (NO_ALARMS as Alarm[]);
}

export function useRecentResolvedAlarms(enabled = true, limit = 3): Alarm[] {
  const query = useQuery({
    queryKey: ['alarms', 'resolved'],
    queryFn: () => getRecentResolvedAlarms(limit),
    enabled,
    refetchInterval: ALARM_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  return query.data ?? (NO_ALARMS as Alarm[]);
}

const NO_OCCURRENCES: readonly InterfaceOccurrence[] = Object.freeze([]) as readonly InterfaceOccurrence[];

/** Ocorrencias recentes de CRC/FCS e discards derivadas das amostras persistidas. */
export function useRecentAlarmOccurrences(
  enabled = true,
  minutes = 15,
  limit = 12,
): InterfaceOccurrence[] {
  const query = useQuery({
    queryKey: ['alarms', 'occurrences', minutes, limit],
    queryFn: () => getAlarmOccurrences(minutes, limit),
    enabled,
    refetchInterval: ALARM_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  return query.data ?? (NO_OCCURRENCES as InterfaceOccurrence[]);
}

/**
 * Indice `alarmId -> Alarm` (ativos + resolvidos recentes). Os logs de midia
 * guardam o id do alarme, entao este indice e o que permite mostrar
 * equipamento/interface/tipo/severidade sem duplicar payload no log.
 */
export function useAlarmIndex(enabled = true): Map<string, Alarm> {
  const active = useActiveAlarms(enabled);
  const resolved = useRecentResolvedAlarms(enabled, 25);
  return useMemo(
    () => new Map([...active, ...resolved].map((alarm) => [alarm.id, alarm])),
    [active, resolved],
  );
}

/** Contagem de alarmes ativos por equipamento (usada por badges e camadas). */
export function countAlarmsByDevice(alarms: Alarm[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const alarm of alarms) {
    counts.set(alarm.deviceId, (counts.get(alarm.deviceId) ?? 0) + 1);
  }
  return counts;
}

const NO_SUPPRESSIONS: readonly AlarmSuppression[] = Object.freeze(
  [],
) as readonly AlarmSuppression[];

/** Supressoes ainda validas (tempo real do operador; base do "Suprimidos"). */
export function useActiveAlarmSuppressions(enabled = true): AlarmSuppression[] {
  const query = useQuery({
    queryKey: ['alarm-suppressions', 'active'],
    queryFn: () => getAlarmSuppressions(true),
    enabled,
    refetchInterval: ALARM_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  return query.data ?? (NO_SUPPRESSIONS as AlarmSuppression[]);
}

/** ACK/supressao mudam as duas leituras (alarmes e supressoes). */
function invalidateAlarmReads(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['alarms'] });
  void queryClient.invalidateQueries({ queryKey: ['alarm-suppressions'] });
}

/**
 * ACK: reflete o reconhecimento na hora e reconcilia com o servidor. O alarme
 * continua ativo — so o destaque visual muda.
 */
export function useAcknowledgeAlarm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alarmId: string) => acknowledgeAlarm(alarmId),
    onSuccess: (updated) => {
      queryClient.setQueryData<Alarm[]>(['alarms'], (current) =>
        current?.map((alarm) => (alarm.id === updated.id ? updated : alarm)),
      );
      invalidateAlarmReads(queryClient);
    },
  });
}

/** Retirar/Suprimir: o alarme encerrado sai dos ativos imediatamente. */
export function useSuppressAlarm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ alarmId, payload }: { alarmId: string; payload: SuppressAlarmPayload }) =>
      suppressAlarm(alarmId, payload),
    onSuccess: (_result, variables) => {
      queryClient.setQueryData<Alarm[]>(['alarms'], (current) =>
        current?.filter((alarm) => alarm.id !== variables.alarmId),
      );
      invalidateAlarmReads(queryClient);
    },
  });
}

/** Liberar supressao: o fingerprint volta a poder abrir alarme. */
export function useReleaseAlarmSuppression() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (suppressionId: string) => releaseAlarmSuppression(suppressionId),
    onSuccess: () => invalidateAlarmReads(queryClient),
  });
}
