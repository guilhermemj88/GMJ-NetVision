import { alarmInterfaceLabel } from '@gmj/shared';
import type { InterfaceOccurrence } from '@gmj/shared';
import type { HostRepository, InterfaceOccurrenceRow } from '../infrastructure/persistence/host-repository';

export interface InterfaceOccurrenceOptions {
  /** Janela observada (minutos) — o mesmo periodo consultado no banco. */
  windowMinutes: number;
  limit?: number;
  /** Corte absoluto da janela; amostras anteriores sao ignoradas por seguranca. */
  sinceMs?: number;
}

export const DEFAULT_OCCURRENCE_WINDOW_MINUTES = 15;
export const MAX_OCCURRENCE_LIMIT = 50;
const DEFAULT_LIMIT = 12;

interface OccurrenceBucket {
  row: InterfaceOccurrenceRow;
  crcDelta: bigint;
  crcIntervals: number;
  crcLastAt: number;
  rxDelta: bigint;
  txDelta: bigint;
  discardIntervals: number;
  discardLastAt: number;
}

function ratePerMinute(delta: bigint, windowMinutes: number): number {
  if (windowMinutes <= 0) return 0;
  return Math.round((Number(delta) / windowMinutes) * 100) / 100;
}

/**
 * Read model das ocorrencias RECENTES de CRC/FCS e discards a partir das
 * amostras de contador JA persistidas: agrega os deltas por interface, nunca
 * conta duas vezes e nunca cria alarme artificial. Ocorrencia != alarme: aqui
 * aparece o que aconteceu de fato, com regra configurada ou sem ela.
 */
export function summarizeInterfaceOccurrences(
  rows: readonly InterfaceOccurrenceRow[],
  options: InterfaceOccurrenceOptions,
): InterfaceOccurrence[] {
  const windowMinutes = options.windowMinutes;
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_OCCURRENCE_LIMIT);
  const buckets = new Map<string, OccurrenceBucket>();

  for (const row of rows) {
    if (options.sinceMs !== undefined && row.timestamp.getTime() < options.sinceMs) continue;
    const bucket = buckets.get(row.interfaceId) ?? {
      row,
      crcDelta: 0n,
      crcIntervals: 0,
      crcLastAt: 0,
      rxDelta: 0n,
      txDelta: 0n,
      discardIntervals: 0,
      discardLastAt: 0,
    };
    buckets.set(row.interfaceId, bucket);
    const timestamp = row.timestamp.getTime();
    if (row.fcsErrorsDelta !== null && row.fcsErrorsDelta > 0n) {
      bucket.crcDelta += row.fcsErrorsDelta;
      bucket.crcIntervals += 1;
      bucket.crcLastAt = Math.max(bucket.crcLastAt, timestamp);
    }
    if (row.inDiscardsDelta > 0n || row.outDiscardsDelta > 0n) {
      bucket.rxDelta += row.inDiscardsDelta;
      bucket.txDelta += row.outDiscardsDelta;
      bucket.discardIntervals += 1;
      bucket.discardLastAt = Math.max(bucket.discardLastAt, timestamp);
    }
  }

  const items: Array<{ lastAt: number; occurrence: InterfaceOccurrence }> = [];
  for (const bucket of buckets.values()) {
    const { row } = bucket;
    const identity = {
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      interfaceId: row.interfaceId,
      interfaceName: row.interfaceName,
      interfaceLabel: alarmInterfaceLabel(
        row.interfaceAlias,
        row.interfaceDescription,
        row.interfaceName,
        row.ifIndex,
      ),
      ifIndex: row.ifIndex,
      windowMinutes,
    };
    if (bucket.crcIntervals > 0) {
      items.push({
        lastAt: bucket.crcLastAt,
        occurrence: {
          ...identity,
          kind: 'CRC',
          crcDelta: bucket.crcDelta.toString(),
          rxDelta: '0',
          txDelta: '0',
          ratePerMinute: ratePerMinute(bucket.crcDelta, windowMinutes),
          lastOccurrenceAt: new Date(bucket.crcLastAt).toISOString(),
          intervals: bucket.crcIntervals,
        },
      });
    }
    if (bucket.discardIntervals > 0) {
      const worstSide = bucket.rxDelta >= bucket.txDelta ? bucket.rxDelta : bucket.txDelta;
      items.push({
        lastAt: bucket.discardLastAt,
        occurrence: {
          ...identity,
          kind: 'DISCARDS',
          crcDelta: '0',
          rxDelta: bucket.rxDelta.toString(),
          txDelta: bucket.txDelta.toString(),
          ratePerMinute: ratePerMinute(worstSide, windowMinutes),
          lastOccurrenceAt: new Date(bucket.discardLastAt).toISOString(),
          intervals: bucket.discardIntervals,
        },
      });
    }
  }

  return items
    .sort((left, right) => right.lastAt - left.lastAt)
    .slice(0, limit)
    .map((item) => item.occurrence);
}

/**
 * Le as amostras persistidas da janela e devolve as ocorrencias prontas. Nunca
 * lanca para o roteador: falha de leitura vira lista vazia (o painel nao some).
 */
export async function collectInterfaceOccurrences(
  repository: HostRepository,
  options: InterfaceOccurrenceOptions & { now?: () => number },
): Promise<InterfaceOccurrence[]> {
  const now = options.now ?? Date.now;
  const sinceMs = now() - options.windowMinutes * 60_000;
  const rows = await repository.getRecentInterfaceOccurrenceRows(new Date(sinceMs));
  return summarizeInterfaceOccurrences(rows, { ...options, sinceMs });
}
