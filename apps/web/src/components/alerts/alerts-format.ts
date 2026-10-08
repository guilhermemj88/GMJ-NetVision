import {
  ALERT_CENTER_OCCURRENCE_WINDOW_MS,
  alertCenterStateLabel,
  alarmResolutionReasonLabel,
  alarmSuppressionReasonLabel,
  formatAlarmDuration,
  formatAlarmDownSince,
  type AlarmSeverity,
  type AlertCenterItem,
  type AlertCenterState,
} from '@gmj/shared';

/**
 * Apresentacao da Central de Alertas (F9.3): tom visual por estado, idade do
 * item e textos da tabela. Nada aqui decide dominio — so o que o operador ve.
 */

export type AlertTone =
  | 'critical'
  | 'major'
  | 'warning'
  | 'info'
  | 'occurrence'
  | 'ack'
  | 'resolved'
  | 'suppressed';

/** Tom do chip de estado. O texto acompanha sempre: cor nunca e o unico sinal. */
export function alertStateTone(state: AlertCenterState): AlertTone {
  switch (state) {
    case 'ACTIVE_UNACKNOWLEDGED':
      return 'critical';
    case 'ACTIVE_ACKNOWLEDGED':
      return 'ack';
    case 'RESOLVED':
      return 'resolved';
    case 'SUPPRESSED':
      return 'suppressed';
    case 'UNACKNOWLEDGED':
      return 'occurrence';
    case 'ACKNOWLEDGED':
      return 'ack';
    case 'QUIET_24H':
      return 'suppressed';
    default:
      return 'resolved';
  }
}

/** Tom da severidade do alarme. Ocorrencia NUNCA usa severidade de regra. */
export function alertSeverityTone(severity: AlarmSeverity | null): AlertTone | null {
  if (!severity) return null;
  if (severity === 'CRITICAL') return 'critical';
  if (severity === 'MAJOR') return 'major';
  if (severity === 'WARNING') return 'warning';
  return 'info';
}

export const ALERT_SEVERITY_LABELS: Record<AlarmSeverity, string> = {
  CRITICAL: 'CRIT',
  MAJOR: 'MAJOR',
  WARNING: 'WARN',
  INFO: 'INFO',
};

export function alertSeverityLabel(severity: AlarmSeverity | null): string | null {
  return severity ? ALERT_SEVERITY_LABELS[severity] : null;
}

/** Badge usado no lugar da severidade quando o item nao tem regra (ocorrencia). */
export function alertCategoryBadge(item: AlertCenterItem): string {
  return item.category === 'ALARM' ? 'ALARME' : 'OCORRÊNCIA';
}

export function alertStateText(state: AlertCenterState): string {
  return alertCenterStateLabel(state);
}

/** Linha ja reconhecida nao precisa (nem deve) ser selecionavel para novo ACK. */
export function alertCanAcknowledge(item: AlertCenterItem): boolean {
  if (item.acknowledgedAt) return false;
  return item.category === 'OCCURRENCE' || item.state === 'ACTIVE_UNACKNOWLEDGED';
}

function clock(iso: string): string {
  return formatAlarmDownSince(iso);
}

/** "13:49 → 14:32 · 2h14m" (primeiro evento, ultimo evento e duracao). */
export function alertTimelineText(item: AlertCenterItem, nowMs: number): string {
  const first = clock(item.startedAt);
  const last = clock(item.lastSeenAt);
  const end = item.endedAt ?? new Date(nowMs).toISOString();
  const duration = formatAlarmDuration(item.startedAt, end);
  return first === last ? `${first} · ${duration}` : `${first} → ${last} · ${duration}`;
}

/** Idade compacta do ultimo evento ("agora", "12m", "3h05m", "2d"). */
export function alertAgeText(iso: string, nowMs: number): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '—';
  const seconds = Math.max(Math.floor((nowMs - target) / 1000), 0);
  if (seconds < 60) return 'agora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** Quem reconheceu e quando ("qa-preview 14:02"), ou "Não". */
export function alertAckText(item: AlertCenterItem): string {
  if (!item.acknowledgedAt) return 'Não';
  return `${item.acknowledgedBy ?? 'operador'} ${clock(item.acknowledgedAt)}`;
}

export function alertClock(iso: string): string {
  return clock(iso);
}

/* --- Painel compacto do mapa (F9.4) ------------------------------------- */

/** O painel NAO e a Central completa: cortes pequenos e explicitos. */
export const ALARM_PANEL_VISIBLE_ALARMS = 5;
export const ALARM_PANEL_VISIBLE_OCCURRENCES = 5;
export const ALARM_PANEL_VISIBLE_RESOLVED = 3;

const PANEL_SEVERITY_ORDER: Record<AlarmSeverity, number> = {
  CRITICAL: 0,
  MAJOR: 1,
  WARNING: 2,
  INFO: 3,
};

/**
 * Ordem operacional dos alarmes ATIVOS: nao reconhecidos por severidade,
 * depois os reconhecidos e, por fim, o mais recente. Nenhuma idade remove um
 * alarme tecnicamente ativo da lista.
 */
export function comparePanelAlarms(left: AlertCenterItem, right: AlertCenterItem): number {
  const leftAck = left.acknowledgedAt ? 1 : 0;
  const rightAck = right.acknowledgedAt ? 1 : 0;
  if (leftAck !== rightAck) return leftAck - rightAck;
  const leftSeverity = left.severity ? PANEL_SEVERITY_ORDER[left.severity] : 9;
  const rightSeverity = right.severity ? PANEL_SEVERITY_ORDER[right.severity] : 9;
  if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
  return new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime();
}

/** Occurrence so entra no painel enquanto nao reconhecida e vigente (24h). */
export function panelOccurrenceVisible(
  item: AlertCenterItem,
  nowMs: number,
  windowMs: number = ALERT_CENTER_OCCURRENCE_WINDOW_MS,
): boolean {
  if (item.category !== 'OCCURRENCE' || item.acknowledgedAt) return false;
  const lastSeen = new Date(item.lastSeenAt).getTime();
  return Number.isFinite(lastSeen) && nowMs - lastSeen <= windowMs;
}

/**
 * Resolvidos (recuperacao tecnica) e suprimidos (acao administrativa) na MESMA
 * lista recente, do mais novo para o mais antigo e sem repetir item.
 */
export function mergeRecentResolved(
  resolved: readonly AlertCenterItem[],
  suppressed: readonly AlertCenterItem[],
  limit: number = ALARM_PANEL_VISIBLE_RESOLVED,
): AlertCenterItem[] {
  const ended = [...resolved, ...suppressed]
    .filter((item) => item.endedAt != null)
    .sort(
      (left, right) =>
        new Date(right.endedAt as string).getTime() - new Date(left.endedAt as string).getTime(),
    );
  const seen = new Set<string>();
  const result: AlertCenterItem[] = [];
  for (const item of ended) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
    if (result.length === limit) break;
  }
  return result;
}

/**
 * Motivo do encerramento sem confundir recuperacao tecnica com acao
 * administrativa: sem motivo registrado, o alarme voltou ao normal sozinho.
 */
export function resolvedReasonText(item: AlertCenterItem): string {
  const alarm = item.alarm ?? null;
  if (alarm?.suppression) {
    return alarmSuppressionReasonLabel(alarm.suppression.reason) ?? 'Retirado pelo operador';
  }
  if (alarm?.resolutionReason) {
    return alarmResolutionReasonLabel(alarm.resolutionReason) ?? 'Motivo administrativo';
  }
  return 'Normalizado (recuperação técnica)';
}

function countText(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** "+17 CRC" ou "RX +23 · TX +1364": RX e TX pertencem ao MESMO episodio. */
export function occurrenceCountersText(item: AlertCenterItem): string {
  const occurrence = item.occurrence ?? null;
  if (!occurrence) return '—';
  if (item.type === 'CRC_FCS') return `${countText(occurrence.crcDeltaTotal)} CRC`;
  const parts: string[] = [];
  if (occurrence.rxDiscardDeltaTotal > 0) parts.push(`RX ${countText(occurrence.rxDiscardDeltaTotal)}`);
  if (occurrence.txDiscardDeltaTotal > 0) parts.push(`TX ${countText(occurrence.txDiscardDeltaTotal)}`);
  return parts.length ? parts.join(' · ') : '—';
}

/** Idade em palavras ("agora", "3 min", "1h05m", "2d") para o painel. */
export function alertAgeWords(iso: string, nowMs: number): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '—';
  const seconds = Math.max(Math.floor((nowMs - target) / 1000), 0);
  if (seconds < 60) return 'agora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** "Última agora" / "Última há 3 min". */
export function alertLastSeenText(iso: string, nowMs: number): string {
  const age = alertAgeWords(iso, nowMs);
  return age === 'agora' ? 'Última agora' : `Última há ${age}`;
}
