/**
 * Alarm display labels and helpers.
 *
 * The friendly name of an interface follows a fixed priority:
 * `alias` (configured on the equipment, e.g. the remote peer name on Huawei)
 * > `description` (ifDescr) > technical `name` (ifName) > `ifIndex`.
 */
export function alarmInterfaceLabel(
  alias: string | null | undefined,
  description: string | null | undefined,
  name: string | null | undefined,
  ifIndex: number,
): string {
  return (
    alias?.trim() ||
    description?.trim() ||
    name?.trim() ||
    `ifIndex ${ifIndex}`
  );
}

/** Formats an ISO timestamp as a compact NOC clock (`HH:mm:ss`). */
export function formatAlarmDownSince(startedAt: string): string {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Formats the elapsed time between two ISO timestamps as a compact NOC
 * duration without milliseconds (`38s`, `2m14s`, `1h03m`).
 */
export function formatAlarmDuration(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return '0s';
  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Human-readable type label; every alarm type gets a NOC-friendly caption. */
export function alarmTypeLabel(type: string): string {
  switch (type) {
    case 'INTERFACE_DOWN':
      return 'LINK DOWN';
    case 'INTERFACE_ERRORS':
      return 'ERROS';
    case 'INTERFACE_CRC':
      return 'CRC/FCS';
    case 'INTERFACE_DISCARDS':
      return 'DESCARTES';
    case 'OPTICAL_RX_DEGRADATION':
      return 'RX OPTICO';
    default:
      return type;
  }
}

/**
 * Motivo de encerramento exibido no historico. Ausente = recuperacao tecnica
 * (a condicao normalizou); nenhum detalhe administrativo e inventado.
 */
const ALARM_RESOLUTION_REASON_LABELS: Record<string, string> = {
  RULE_DISABLED: 'regra desativada',
  RULE_DELETED: 'regra excluída',
  MANUAL_SUPPRESSION: 'suprimido pelo operador',
  INTENTIONAL_SHUTDOWN: 'desligamento intencional',
  MAINTENANCE: 'manutenção',
  FALSE_POSITIVE: 'falso positivo',
};

/** Texto do motivo administrativo; `null` quando a saida foi tecnica. */
export function alarmResolutionReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return ALARM_RESOLUTION_REASON_LABELS[reason] ?? reason;
}

const ALARM_SUPPRESSION_REASON_LABELS: Record<string, string> = {
  INTENTIONAL_SHUTDOWN: 'Desligamento intencional',
  MAINTENANCE: 'Manutenção',
  FALSE_POSITIVE: 'Falso positivo',
  OTHER: 'Outro',
};

const ALARM_SUPPRESSION_MODE_LABELS: Record<string, string> = {
  UNTIL_CLEAR: 'Até normalizar',
  UNTIL_TIME: 'Até o horário',
};

export function alarmSuppressionReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return ALARM_SUPPRESSION_REASON_LABELS[reason] ?? reason;
}

export function alarmSuppressionModeLabel(mode: string | null | undefined): string | null {
  if (!mode) return null;
  return ALARM_SUPPRESSION_MODE_LABELS[mode] ?? mode;
}
