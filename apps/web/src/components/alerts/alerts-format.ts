import {
  alertCenterStateLabel,
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
