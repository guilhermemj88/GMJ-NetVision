import {
  OPERATIONAL_OCCURRENCE_QUIET_MS,
  bigintToSafeNumber,
  type OperationalOccurrenceCloseReason,
  type OperationalOccurrenceType,
} from '@gmj/shared';
import type {
  OperationalOccurrenceSupersede,
  OperationalOccurrenceValues,
} from '../infrastructure/alarms/operational-occurrence-repository';

/**
 * Decisoes puras da ocorrencia operacional persistente (F9.2).
 *
 * Nada aqui toca banco: o servico resolve o estado atual, estas funcoes dizem o
 * que fazer com a amostra e o repositorio aplica em transacao. Separar as duas
 * coisas e o que permite testar 24h, replay, taxa e ordenacao sem subir Prisma.
 */

/** Amostra de contador vinda da ingestao (deltas ja calculados pelo coletor). */
export interface OccurrenceSampleDelta {
  interfaceId: string;
  timestampMs: number;
  /** `null` = FCS nao coletado nesse device (nao vira ocorrencia). */
  fcsErrorsDelta: bigint | null;
  inDiscardsDelta: bigint;
  outDiscardsDelta: bigint;
  /** Timestamp da amostra anterior do mesmo contador (pull anterior). */
  previousSampleTimestampMs?: number | null | undefined;
}

/** Deltas da amostra recortados para UM tipo de ocorrencia. */
export interface OccurrenceDelta {
  crc: bigint;
  rx: bigint;
  tx: bigint;
  /** Eventos do tipo (RX + TX no caso de DISCARD: um unico episodio). */
  total: bigint;
}

export interface OperationalOccurrenceState extends OperationalOccurrenceValues {
  id: string;
}

export type OperationalOccurrencePlan =
  | { action: 'IGNORE' }
  | { action: 'UPDATE'; targetId: string; values: OperationalOccurrenceValues }
  | {
      action: 'CREATE';
      close: OperationalOccurrenceSupersede | null;
      values: OperationalOccurrenceValues;
    };

export interface OperationalOccurrencePlanInput {
  /** Episodio vigente: aberto, sem ACK e com ocorrencia nas ultimas 24h. */
  current: OperationalOccurrenceState | null;
  /** Episodio mais recente do mesmo fingerprint (vigente ou ja encerrado). */
  latest: OperationalOccurrenceState | null;
  /** Episodio aberto a encerrar quando o novo episodio for criado. */
  supersede: OperationalOccurrenceSupersede | null;
  timestampMs: number;
  delta: OccurrenceDelta;
  /** Base conhecida do intervalo (amostra anterior); `null` = desconhecida. */
  intervalBasisMs: number | null;
}

/** Contadores descontinuos viram zero: delta negativo nunca entra no total. */
function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/**
 * CRC/FCS e DISCARDS sao episodios SEPARADOS da mesma amostra (dois cards, dois
 * ids). Dentro de DISCARDS, RX e TX nunca se dividem: sao o mesmo episodio, com
 * totais guardados lado a lado.
 */
export function occurrenceDeltaFor(
  type: OperationalOccurrenceType,
  sample: OccurrenceSampleDelta,
): OccurrenceDelta {
  if (type === 'CRC_FCS') {
    const crc = nonNegative(sample.fcsErrorsDelta ?? 0n);
    return { crc, rx: 0n, tx: 0n, total: crc };
  }
  const rx = nonNegative(sample.inDiscardsDelta);
  const tx = nonNegative(sample.outDiscardsDelta);
  return { crc: 0n, rx, tx, total: rx + tx };
}

/**
 * Maior base valida anterior a amostra. `previousSampleTimestampMs` (ultimo poll)
 * tem prioridade pratica; o cursor do lote cobre amostras processadas juntas.
 */
export function bestIntervalBasisMs(
  timestampMs: number,
  candidates: readonly (number | null | undefined)[],
): number | null {
  let best: number | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    if (candidate >= timestampMs) continue;
    if (best === null || candidate > best) best = candidate;
  }
  return best;
}

export function resolveIntervalMs(
  timestampMs: number,
  basisMs: number | null | undefined,
): number | null {
  if (typeof basisMs !== 'number' || !Number.isFinite(basisMs) || basisMs >= timestampMs) return null;
  return timestampMs - basisMs;
}

/**
 * Eventos por minuto no intervalo observado. Sem base confiavel a taxa fica 0
 * (nunca NaN/Infinity): os totais continuam corretos, so a velocidade e omitida.
 */
export function occurrenceRatePerMinute(events: bigint, intervalMs: number | null): number {
  if (!intervalMs || !Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const minutes = intervalMs / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const rate = bigintToSafeNumber(events) / minutes;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round(rate * 100) / 100;
}

function addDelta(
  state: OperationalOccurrenceState,
  delta: OccurrenceDelta,
  timestampMs: number,
): OperationalOccurrenceValues {
  return {
    firstSeenAtMs: state.firstSeenAtMs,
    lastSeenAtMs: Math.max(state.lastSeenAtMs, timestampMs),
    lastSampleAtMs: state.lastSampleAtMs,
    occurrenceCount: state.occurrenceCount + 1,
    crcDeltaTotal: state.crcDeltaTotal + delta.crc,
    rxDiscardDeltaTotal: state.rxDiscardDeltaTotal + delta.rx,
    txDiscardDeltaTotal: state.txDiscardDeltaTotal + delta.tx,
    currentRatePerMin: state.currentRatePerMin,
    peakRatePerMin: state.peakRatePerMin,
  };
}

/**
 * Decide o efeito de UMA amostra com ocorrencia (`delta.total > 0`):
 *
 * - episodio vigente + amostra nova: soma, avanca `lastSeenAt` e recalcula a taxa;
 * - episodio vigente + amostra atrasada: soma o evento, mas NAO mexe em tempo,
 *   taxa nem pico (um dado fora de ordem nao pode rejuvenescer o episodio);
 * - sem episodio vigente + amostra atrasada em relacao ao ultimo episodio:
 *   ignora (reprocessar o passado nao reabre nem cria card antigo);
 * - caso contrario: cria episodio novo, encerrando o anterior se ficou aberto.
 */
export function planOperationalOccurrence(
  input: OperationalOccurrencePlanInput,
): OperationalOccurrencePlan {
  const { current, latest, delta, timestampMs } = input;
  if (current && timestampMs > current.lastSampleAtMs) {
    const rate = occurrenceRatePerMinute(
      delta.total,
      resolveIntervalMs(timestampMs, input.intervalBasisMs),
    );
    return {
      action: 'UPDATE',
      targetId: current.id,
      values: {
        ...addDelta(current, delta, timestampMs),
        lastSampleAtMs: timestampMs,
        currentRatePerMin: rate,
        peakRatePerMin: Math.max(current.peakRatePerMin, rate),
      },
    };
  }
  if (current) {
    return { action: 'UPDATE', targetId: current.id, values: addDelta(current, delta, timestampMs) };
  }
  if (latest && timestampMs <= latest.lastSampleAtMs) return { action: 'IGNORE' };

  const rate = occurrenceRatePerMinute(
    delta.total,
    resolveIntervalMs(timestampMs, input.intervalBasisMs),
  );
  return {
    action: 'CREATE',
    close: input.supersede,
    values: {
      firstSeenAtMs: timestampMs,
      lastSeenAtMs: timestampMs,
      lastSampleAtMs: timestampMs,
      occurrenceCount: 1,
      crcDeltaTotal: delta.crc,
      rxDiscardDeltaTotal: delta.rx,
      txDiscardDeltaTotal: delta.tx,
      currentRatePerMin: rate,
      peakRatePerMin: rate,
    },
  };
}

/**
 * Episodio vigente: aberto, sem ACK e com ocorrencia dentro da janela de 24h.
 * Depois disso ele continua consultavel no historico, so sai do painel.
 */
export function isOccurrenceStateCurrent(
  state: Pick<OperationalOccurrenceState, 'lastSeenAtMs'>,
  nowMs: number,
): boolean {
  return nowMs - state.lastSeenAtMs < OPERATIONAL_OCCURRENCE_QUIET_MS;
}

/** Motivo/fim real do episodio anterior quando ele precisa ser substituido. */
export function supersedeFor(
  latest: OperationalOccurrenceState,
  timestampMs: number,
  acknowledgedAtMs: number | null,
): OperationalOccurrenceSupersede | null {
  if (acknowledgedAtMs !== null) {
    return { id: latest.id, reason: 'ACKNOWLEDGED', closedAtMs: acknowledgedAtMs };
  }
  if (latest.lastSeenAtMs + OPERATIONAL_OCCURRENCE_QUIET_MS > timestampMs) return null;
  return {
    id: latest.id,
    reason: 'QUIET_24H' as OperationalOccurrenceCloseReason,
    closedAtMs: latest.lastSeenAtMs + OPERATIONAL_OCCURRENCE_QUIET_MS,
  };
}
