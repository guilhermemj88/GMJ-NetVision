import {
  ALERT_CENTER_OCCURRENCE_WINDOW_MS,
  alertCenterTypesMatching,
  bigintToSafeNumber,
  normalizeAlertSearchTerm,
  type AlarmMetadata,
  type AlarmResolutionReason,
  type AlertCenterAlarmState,
  type AlertCenterItem,
  type AlertCenterOccurrenceState,
  type AlertCenterStateFilter,
} from '@gmj/shared';
import type {
  AlertCenterAlarmRow,
  AlertCenterOccurrenceRow,
} from './alert-center-repository';

/**
 * Semantica pura da Central de Alertas (F9.3).
 *
 * Vive ao lado do read model porque e usada pelos DOIS repositorios: o Prisma
 * traduz estas regras para SQL (filtros) e o DEMO aplica em memoria. Estado
 * normalizado, ordem estavel, periodo e resumo de valor ficam aqui, sem I/O.
 */

/** Motivos administrativos que significam "retirado/suprimido pelo operador". */
export const SUPPRESSION_RESOLUTION_REASONS: readonly AlarmResolutionReason[] = [
  'MANUAL_SUPPRESSION',
  'INTENTIONAL_SHUTDOWN',
  'MAINTENANCE',
  'FALSE_POSITIVE',
];

export function isSuppressionResolutionReason(
  reason: string | null | undefined,
): reason is AlarmResolutionReason {
  return reason != null && (SUPPRESSION_RESOLUTION_REASONS as readonly string[]).includes(reason);
}

/** Janela de vigencia de uma ocorrencia nao reconhecida (24h). */
export function occurrenceWindowMs(): number {
  return ALERT_CENTER_OCCURRENCE_WINDOW_MS;
}

/** ACK nunca vira RESOLVED: o alarme continua ativo, so muda de subestado. */
export function alarmStateFor(row: {
  endedAt: Date | null;
  acknowledgedAt: Date | null;
  suppressionReason?: string | null | undefined;
  metadata?: AlarmMetadata | null | undefined;
}): AlertCenterAlarmState {
  const reason = alarmSuppressionReasonOf(row);
  if (row.endedAt) {
    return isSuppressionResolutionReason(reason) ? 'SUPPRESSED' : 'RESOLVED';
  }
  return row.acknowledgedAt ? 'ACTIVE_ACKNOWLEDGED' : 'ACTIVE_UNACKNOWLEDGED';
}

/**
 * Motivo administrativo do encerramento: campo explicito (quando o chamador ja
 * extraiu) ou `metadata.resolutionReason` da linha do alarme.
 */
export function alarmSuppressionReasonOf(row: {
  suppressionReason?: string | null | undefined;
  metadata?: AlarmMetadata | null | undefined;
}): string | null {
  if (row.suppressionReason !== undefined) return row.suppressionReason;
  const reason = row.metadata?.resolutionReason;
  return typeof reason === 'string' ? reason : null;
}

/** ACK encerra o episodio da ocorrencia (F9.2); 24h sem evento vira QUIET_24H. */
export function occurrenceStateFor(row: {
  acknowledgedAt: Date | null;
  closedAt: Date | null;
  closeReason?: string | null | undefined;
}): AlertCenterOccurrenceState {
  if (row.acknowledgedAt) return 'ACKNOWLEDGED';
  if (!row.closedAt) return 'UNACKNOWLEDGED';
  return row.closeReason === 'QUIET_24H' ? 'QUIET_24H' : 'CLOSED';
}

/** Estados de ocorrencia que exigem a janela de 24h (vigentes). */
export function occurrenceStateIsVigent(state: AlertCenterStateFilter): boolean {
  return state === 'ACTIVE' || state === 'UNACKNOWLEDGED';
}

export function alarmMatchesStateFilter(
  row: {
    endedAt: Date | null;
    acknowledgedAt: Date | null;
    suppressionReason?: string | null | undefined;
    metadata?: AlarmMetadata | null | undefined;
  },
  state: AlertCenterStateFilter,
): boolean {
  const suppressed = isSuppressionResolutionReason(alarmSuppressionReasonOf(row));
  switch (state) {
    case 'ACTIVE':
      return row.endedAt === null;
    case 'UNACKNOWLEDGED':
      return row.endedAt === null && row.acknowledgedAt === null;
    case 'ACKNOWLEDGED':
      return row.endedAt === null && row.acknowledgedAt !== null;
    case 'RESOLVED':
      return row.endedAt !== null && !suppressed;
    case 'SUPPRESSED':
      return row.endedAt !== null && suppressed;
    default:
      return true;
  }
}

export function occurrenceMatchesStateFilter(
  row: {
    acknowledgedAt: Date | null;
    closedAt: Date | null;
    lastSeenAt: Date;
    closeReason?: string | null | undefined;
  },
  state: AlertCenterStateFilter,
  nowMs: number,
): boolean {
  switch (state) {
    case 'ACTIVE':
    case 'UNACKNOWLEDGED':
      return (
        row.closedAt === null &&
        row.acknowledgedAt === null &&
        row.lastSeenAt.getTime() >= nowMs - occurrenceWindowMs()
      );
    case 'ACKNOWLEDGED':
      return row.acknowledgedAt !== null;
    case 'RESOLVED':
    case 'SUPPRESSED':
      // Ocorrencia nao tem severidade nem supressao: nada a mostrar aqui.
      return false;
    default:
      return true;
  }
}

/** Piso de tempo aplicado ao historico de ocorrencias (periodo + 24h quando vigente). */
export function occurrenceFloorMs(
  state: AlertCenterStateFilter,
  fromMs: number | null,
  nowMs: number,
): number | null {
  const windowFloor = occurrenceStateIsVigent(state)
    ? nowMs - occurrenceWindowMs()
    : null;
  if (fromMs === null) return windowFloor;
  if (windowFloor === null) return fromMs;
  return Math.max(fromMs, windowFloor);
}

/**
 * Periodo NUNCA esconde alarme ativo (spec F9.3 §20): um problema que continua
 * de pe ha 40 dias segue em ATIVOS; o corte temporal so olha o historico.
 */
export function alarmMatchesPeriodFilter(
  row: { endedAt: Date | null; updatedAt: Date },
  fromMs: number | null,
): boolean {
  if (row.endedAt === null || fromMs === null) return true;
  return row.updatedAt.getTime() >= fromMs;
}

export function occurrenceMatchesPeriodFilter(
  row: { lastSeenAt: Date },
  floorMs: number | null,
): boolean {
  if (floorMs === null) return true;
  return row.lastSeenAt.getTime() >= floorMs;
}

function matchesSearch(values: readonly (string | null | undefined)[], term: string): boolean {
  return values.some((value) => value != null && normalizeAlertSearchTerm(value).includes(term));
}

export function alarmMatchesSearch(row: AlertCenterAlarmRow, search: string): boolean {
  const term = normalizeAlertSearchTerm(search);
  if (!term) return true;
  if (matchesSearch([row.deviceName, row.deviceHostname, row.site], term)) return true;
  if (matchesSearch([row.interfaceName, row.interfaceAlias, row.interfaceDescription], term)) {
    return true;
  }
  if (normalizeAlertSearchTerm(row.type).includes(term)) return true;
  return alertCenterTypesMatching(term).includes(row.type);
}

export function occurrenceMatchesSearch(row: AlertCenterOccurrenceRow, search: string): boolean {
  const term = normalizeAlertSearchTerm(search);
  if (!term) return true;
  if (matchesSearch([row.deviceName, row.deviceHostname, row.site], term)) return true;
  if (matchesSearch([row.interfaceName, row.interfaceAlias, row.interfaceDescription], term)) {
    return true;
  }
  if (normalizeAlertSearchTerm(row.type).includes(term)) return true;
  return alertCenterTypesMatching(term).includes(row.type);
}

/**
 * Prioridade operacional (spec F9.3 §6): o que exige atencao primeiro.
 * 0 alarme ativo nao reconhecido, 1 alarme ativo reconhecido, 2 ocorrencia nao
 * reconhecida, 3 demais — desempate por `lastSeenAt` DESC e `id` ASC, nunca
 * pela ordem acidental do banco.
 */
export function alertCenterPriority(item: Pick<AlertCenterItem, 'category' | 'state'>): number {
  if (item.category === 'ALARM') {
    if (item.state === 'ACTIVE_UNACKNOWLEDGED') return 0;
    if (item.state === 'ACTIVE_ACKNOWLEDGED') return 1;
    return 3;
  }
  return item.state === 'UNACKNOWLEDGED' ? 2 : 3;
}

export function compareAlertCenterItems(left: AlertCenterItem, right: AlertCenterItem): number {
  const priority = alertCenterPriority(left) - alertCenterPriority(right);
  if (priority !== 0) return priority;
  const byLastSeen = new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime();
  if (byLastSeen !== 0) return byLastSeen;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatDbm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} dBm`;
}

function formatCount(value: bigint | number): string {
  const numeric = typeof value === 'bigint' ? bigintToSafeNumber(value) : value;
  return numeric > 0 ? `+${numeric}` : String(numeric);
}

/** Linha da coluna VALOR do alarme (nunca JSON cru). */
export function alarmValueSummary(row: AlertCenterAlarmRow): string {
  const metadata = row.metadata ?? null;
  if (row.type === 'INTERFACE_DOWN') {
    return row.endedAt ? 'NORMALIZADO' : 'DOWN';
  }
  if (row.type === 'OPTICAL_RX_DEGRADATION') {
    const parts = [formatDbm(metadata?.rxPowerDbm ?? row.currentValue ?? null)];
    if (metadata?.rxLowAlarmDbm != null) parts.push(`LOW ${formatDbm(metadata.rxLowAlarmDbm)}`);
    if (metadata?.marginDb != null) parts.push(`margem ${roundRate(metadata.marginDb)} dB`);
    if (metadata?.lane != null) parts.push(`lane ${metadata.lane}`);
    return parts.join(' · ');
  }
  const direction = metadata?.direction ?? (row.metricKey === 'FCS' ? 'RX' : null);
  const rate = metadata?.ratePerMinute ?? row.currentValue ?? null;
  const limit = metadata?.thresholdPerMinute ?? row.thresholdValue ?? null;
  const parts: string[] = [];
  if (direction) parts.push(direction);
  if (rate !== null) parts.push(`${roundRate(rate)}/min`);
  if (limit !== null && limit > 0) parts.push(`limite ${roundRate(limit)}`);
  if (metadata?.delta) parts.push(`+${metadata.delta} no período`);
  return parts.length ? parts.join(' · ') : (row.unit ?? '—');
}

/** Linha da coluna VALOR da ocorrencia (CRC/FCS x DISCARDS). */
export function occurrenceValueSummary(row: AlertCenterOccurrenceRow): string {
  const parts: string[] = [];
  if (row.crcDeltaTotal > 0n) parts.push(`${formatCount(row.crcDeltaTotal)} CRC`);
  if (row.rxDiscardDeltaTotal > 0n) parts.push(`RX ${formatCount(row.rxDiscardDeltaTotal)}`);
  if (row.txDiscardDeltaTotal > 0n) parts.push(`TX ${formatCount(row.txDiscardDeltaTotal)}`);
  if (row.currentRatePerMin > 0) parts.push(`${roundRate(row.currentRatePerMin)}/min`);
  if (!parts.length) parts.push('sem delta acumulado');
  return parts.join(' · ');
}
