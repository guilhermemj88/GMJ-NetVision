'use client';

import { useQuery } from '@tanstack/react-query';
import { getAlarms, getRecentResolvedAlarms } from '@/lib/api';
import type { Alarm } from '@gmj/shared';

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

/** Contagem de alarmes ativos por equipamento (usada por badges e camadas). */
export function countAlarmsByDevice(alarms: Alarm[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const alarm of alarms) {
    counts.set(alarm.deviceId, (counts.get(alarm.deviceId) ?? 0) + 1);
  }
  return counts;
}
