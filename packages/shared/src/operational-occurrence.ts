import type { AlarmSeverity } from './types';

/**
 * Ocorrencia operacional persistente (F9.2).
 *
 * OCCURRENCE = "algo novo aconteceu" (telemetria factual, sem severidade de
 * regra e sem midia). ALARM = "uma regra pediu atencao". As duas entidades
 * coexistem: uma amostra com CRC pode criar a occurrence E, se existir regra,
 * abrir o alarme — nunca uma substitui a outra.
 */

export type OperationalOccurrenceType = 'CRC_FCS' | 'DISCARDS';

export const OPERATIONAL_OCCURRENCE_TYPES = [
  'CRC_FCS',
  'DISCARDS',
] as const satisfies readonly OperationalOccurrenceType[];

/** Por que o episodio saiu do painel compacto. */
export type OperationalOccurrenceCloseReason = 'ACKNOWLEDGED' | 'QUIET_24H' | 'MANUAL';

/** Janela de visibilidade operacional: depois disso o episodio e historico. */
export const OPERATIONAL_OCCURRENCE_QUIET_MS = 24 * 60 * 60 * 1000;

export interface OperationalOccurrence {
  id: string;
  fingerprint: string;
  type: OperationalOccurrenceType;
  deviceId: string;
  deviceName: string;
  interfaceId: string;
  interfaceName: string;
  interfaceLabel: string;
  ifIndex: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  crcDeltaTotal: number;
  rxDiscardDeltaTotal: number;
  txDiscardDeltaTotal: number;
  currentRatePerMin: number;
  peakRatePerMin: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  closedAt: string | null;
  closeReason: OperationalOccurrenceCloseReason | null;
  /** Motivo ja traduzido para o operador (null quando segue aberta). */
  closeReasonLabel?: string | null;
  /** Severidade informativa usada pela Central (occurrence nao tem regra). */
  severity: AlarmSeverity;
}

/** Resposta da listagem (paginacao pronta para a Workspace ALERTAS da F9.3). */
export interface OperationalOccurrenceListResponse {
  items: OperationalOccurrence[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface OperationalOccurrenceAckResponse {
  occurrence: OperationalOccurrence;
  /** false quando o ACK ja existia (idempotencia preserva o primeiro). */
  acknowledged: boolean;
}

/**
 * Fingerprint canonico: CRC e um episodio por interface; RX e TX de discard
 * NUNCA viram dois episodios (os totais ficam separados dentro do mesmo card).
 */
export function operationalOccurrenceFingerprint(
  interfaceId: string,
  type: OperationalOccurrenceType,
): string {
  return `${interfaceId}|${type}`;
}

/** Texto do motivo de encerramento (nunca "recuperacao tecnica"). */
export function operationalOccurrenceCloseReasonLabel(
  reason: OperationalOccurrenceCloseReason | null | undefined,
): string | null {
  if (!reason) return null;
  if (reason === 'ACKNOWLEDGED') return 'reconhecida pelo operador';
  if (reason === 'QUIET_24H') return 'sem novas ocorrências por 24h';
  return 'encerrada manualmente';
}

/** Tipo do episodio exibido no card (mesmos rotulos NOC do painel). */
export function operationalOccurrenceTypeLabel(type: OperationalOccurrenceType): string {
  return type === 'CRC_FCS' ? 'CRC/FCS' : 'DISCARDS';
}

/**
 * Episodio ainda operacional: nao reconhecido e visto nas ultimas 24h. Depois
 * disso ele continua consultavel no historico, apenas sai do painel compacto.
 */
export function isOperationalOccurrenceCurrent(
  occurrence: Pick<OperationalOccurrence, 'acknowledgedAt' | 'lastSeenAt'>,
  nowMs: number,
): boolean {
  if (occurrence.acknowledgedAt) return false;
  const lastSeenMs = new Date(occurrence.lastSeenAt).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;
  return nowMs - lastSeenMs < OPERATIONAL_OCCURRENCE_QUIET_MS;
}

/**
 * Totais de contador sao BigInt no banco (Counter64/BigInt do Prisma). Converter
 * para number e seguro na pratica (episodios de 24h), mas nunca silencioso:
 * satura em Number.MAX_SAFE_INTEGER em vez de perder precisao.
 */
export function bigintToSafeNumber(value: bigint | number): number {
  const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (big < BigInt(-Number.MAX_SAFE_INTEGER)) return -Number.MAX_SAFE_INTEGER;
  return Number(big);
}
