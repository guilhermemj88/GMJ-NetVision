import type {
  AlarmDirection,
  AlarmResolutionReason,
  AlarmSeverity,
  OpticalThresholdSource,
  OpticalTriggerReason,
} from './types';
import type { AlarmSuppressionMode, AlarmSuppressionReason } from './alarm-suppression';
import type { OperationalOccurrenceCloseReason } from './operational-occurrence';

/**
 * Central de Alertas (F9.3): read model UNIFICADO de `Alarm` + `OperationalOccurrence`.
 *
 * A unificação é só de APRESENTAÇÃO. Cada item continua sendo a entidade dele:
 * `category` diz qual é, `alarm`/`occurrence` carregam o detalhe específico e a
 * severidade existe apenas quando o alarme tem regra (occurrence nunca ganha
 * severidade inventada).
 */

export type AlertCenterCategory = 'ALARM' | 'OCCURRENCE';
export const ALERT_CENTER_CATEGORIES = [
  'ALARM',
  'OCCURRENCE',
] as const satisfies readonly AlertCenterCategory[];

/** Estado normalizado de um ALARM (ACK não é resolução). */
export type AlertCenterAlarmState =
  | 'ACTIVE_UNACKNOWLEDGED'
  | 'ACTIVE_ACKNOWLEDGED'
  | 'RESOLVED'
  | 'SUPPRESSED';
export const ALERT_CENTER_ALARM_STATES = [
  'ACTIVE_UNACKNOWLEDGED',
  'ACTIVE_ACKNOWLEDGED',
  'RESOLVED',
  'SUPPRESSED',
] as const satisfies readonly AlertCenterAlarmState[];

/** Estado normalizado de uma OCCURRENCE (ACK encerra o episódio na F9.2). */
export type AlertCenterOccurrenceState =
  | 'UNACKNOWLEDGED'
  | 'ACKNOWLEDGED'
  | 'QUIET_24H'
  | 'CLOSED';
export const ALERT_CENTER_OCCURRENCE_STATES = [
  'UNACKNOWLEDGED',
  'ACKNOWLEDGED',
  'QUIET_24H',
  'CLOSED',
] as const satisfies readonly AlertCenterOccurrenceState[];

export type AlertCenterState = AlertCenterAlarmState | AlertCenterOccurrenceState;

/** Filtros de estado da Central; cada categoria aplica o que faz sentido. */
export type AlertCenterStateFilter =
  | 'ACTIVE'
  | 'UNACKNOWLEDGED'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'SUPPRESSED'
  | 'ALL';
export const ALERT_CENTER_STATE_FILTERS = [
  'ACTIVE',
  'UNACKNOWLEDGED',
  'ACKNOWLEDGED',
  'RESOLVED',
  'SUPPRESSED',
  'ALL',
] as const satisfies readonly AlertCenterStateFilter[];

/** Default operacional: alarmes ativos + ocorrências vigentes não reconhecidas. */
export const ALERT_CENTER_DEFAULT_STATE: AlertCenterStateFilter = 'ACTIVE';

export type AlertCenterPeriod = '1h' | '24h' | '7d' | '30d';
export const ALERT_CENTER_PERIODS = ['1h', '24h', '7d', '30d'] as const satisfies readonly AlertCenterPeriod[];
export const ALERT_CENTER_PERIOD_MS: Record<AlertCenterPeriod, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const ALERT_CENTER_DEFAULT_LIMIT = 50;
export const ALERT_CENTER_MAX_LIMIT = 100;

/** Janela em que uma occurrence não reconhecida ainda é "vigente". */
export const ALERT_CENTER_OCCURRENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Opções de tipo REAIS do domínio (nenhum tipo inventado para a UI). */
export interface AlertCenterTypeOption {
  value: string;
  label: string;
  category: AlertCenterCategory;
}
export const ALERT_CENTER_TYPE_OPTIONS: readonly AlertCenterTypeOption[] = [
  { value: 'INTERFACE_DOWN', label: 'LINK DOWN', category: 'ALARM' },
  { value: 'INTERFACE_ERRORS', label: 'ERROS (regra)', category: 'ALARM' },
  { value: 'INTERFACE_CRC', label: 'CRC/FCS (regra)', category: 'ALARM' },
  { value: 'INTERFACE_DISCARDS', label: 'DESCARTES (regra)', category: 'ALARM' },
  { value: 'OPTICAL_RX_DEGRADATION', label: 'RX ÓPTICO (regra)', category: 'ALARM' },
  { value: 'CRC_FCS', label: 'CRC/FCS (ocorrência)', category: 'OCCURRENCE' },
  { value: 'DISCARDS', label: 'DISCARDS (ocorrência)', category: 'OCCURRENCE' },
];

/** Supressão vigente que encerrou o alarme (F9.1), quando houver. */
export interface AlertCenterSuppressionDetail {
  id: string;
  mode: AlarmSuppressionMode;
  reason: AlarmSuppressionReason;
  note: string | null;
  suppressedBy: string;
  suppressedAt: string;
  expiresAt: string | null;
}

/** Detalhe óptico (F5/F7) já normalizado para a Central. */
export interface AlertCenterOpticalDetail {
  lane: number | null;
  rxPowerDbm: number | null;
  rxLowAlarmDbm: number | null;
  rxHighAlarmDbm: number | null;
  marginDb: number | null;
  proximityPercent: number | null;
  trendDropDb: number | null;
  trendWindowMinutes: number | null;
  triggerReasons: OpticalTriggerReason[];
  thresholdSource: OpticalThresholdSource | null;
  currentPowerSource: 'SNMP' | 'SSH' | null;
}

/** Detalhe específico de ALARM (nunca JSON cru na UI). */
export interface AlertCenterAlarmDetail {
  ruleId: string | null;
  ruleName: string | null;
  metricKey: string | null;
  direction: AlarmDirection | null;
  currentValue: number | null;
  thresholdValue: number | null;
  unit: string | null;
  /** Taxa por minuto avaliada pela regra métrica (quando existir). */
  ratePerMinute: number | null;
  /** Limite por minuto avaliado pela regra métrica (quando existir). */
  thresholdPerMinute: number | null;
  /** Delta agregado no período do episódio, já em texto (nunca BigInt cru). */
  delta: string | null;
  message: string;
  linkId: string | null;
  linkLabel: string | null;
  resolutionReason: AlarmResolutionReason | null;
  suppression: AlertCenterSuppressionDetail | null;
  optical: AlertCenterOpticalDetail | null;
}

/** Detalhe específico de OCCURRENCE (F9.2). */
export interface AlertCenterOccurrenceDetail {
  occurrenceCount: number;
  crcDeltaTotal: number;
  rxDiscardDeltaTotal: number;
  txDiscardDeltaTotal: number;
  currentRatePerMin: number;
  peakRatePerMin: number;
  closeReason: OperationalOccurrenceCloseReason | null;
  closedAt: string | null;
  /** Mídia não existe para occurrence (F9.5 é de alarm) — sempre nulo hoje. */
  mediaAvailable: false;
}

export interface AlertCenterItem {
  id: string;
  category: AlertCenterCategory;
  state: AlertCenterState;
  /** Severidade REAL do alarme. `null` em occurrence (nunca inventada). */
  severity: AlarmSeverity | null;
  type: string;
  typeLabel: string;
  deviceId: string;
  deviceName: string;
  deviceHostname: string | null;
  site: string | null;
  interfaceId: string | null;
  interfaceName: string | null;
  interfaceAlias: string | null;
  interfaceLabel: string | null;
  ifIndex: number | null;
  startedAt: string;
  /** Última mudança de estado do item (base do "Último evento" e da ordem). */
  lastSeenAt: string;
  endedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  /** Resumo compacto para a coluna VALOR (nunca BigInt/JSON cru). */
  valueSummary: string;
  /** Mapas que contêm o equipamento (ação "Abrir no mapa" sem N+1 no cliente). */
  mapIds: string[];
  alarm?: AlertCenterAlarmDetail | undefined;
  occurrence?: AlertCenterOccurrenceDetail | undefined;
}

/** Filtros aceitos pela Central (mesma forma no backend e no frontend). */
export interface AlertCenterListQuery {
  state?: AlertCenterStateFilter | undefined;
  category?: AlertCenterCategory | undefined;
  /** Tipos exatos do domínio (alarme e/ou ocorrência). */
  types?: readonly string[] | undefined;
  severities?: readonly AlarmSeverity[] | undefined;
  /** Ausente = sem corte temporal (nada desaparece em silêncio). */
  period?: AlertCenterPeriod | undefined;
  search?: string | undefined;
  deviceId?: string | undefined;
  interfaceId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Resumo OPERACIONAL (sem filtros): alimenta os cards e o badge da TopBar.
 * Severidade só conta alarme ativo; occurrence tem contadores próprios.
 */
export interface AlertCenterSummary {
  alarmsActive: number;
  alarmsActiveCritical: number;
  alarmsActiveMajor: number;
  alarmsActiveWarning: number;
  alarmsActiveInfo: number;
  alarmsActiveUnacknowledged: number;
  alarmsActiveAcknowledged: number;
  /** Ocorrências não reconhecidas e vigentes (lastSeenAt nas últimas 24h). */
  occurrencesUnacknowledged: number;
  /** Ocorrências reconhecidas nas últimas 24h. */
  occurrencesAcknowledged: number;
  /** Ocorrências encerradas por 24h sem evento nas últimas 24h. */
  occurrencesQuiet24h: number;
}

export interface AlertCenterResponse {
  items: AlertCenterItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Filtro de estado realmente aplicado (o default nunca é implícito). */
  state: AlertCenterStateFilter;
  summary: AlertCenterSummary;
  generatedAt: string;
}

/** Badge da TopBar: só o que exige atenção. */
export function alertCenterAttentionCount(summary: AlertCenterSummary): number {
  return summary.alarmsActiveUnacknowledged + summary.occurrencesUnacknowledged;
}

const STATE_LABELS: Record<AlertCenterState, string> = {
  ACTIVE_UNACKNOWLEDGED: 'ATIVO',
  ACTIVE_ACKNOWLEDGED: 'ACK',
  RESOLVED: 'RESOLVIDO',
  SUPPRESSED: 'SUPRIMIDO',
  UNACKNOWLEDGED: 'NOVO',
  ACKNOWLEDGED: 'ACK',
  QUIET_24H: '24H',
  CLOSED: 'ENCERRADO',
};

const STATE_TITLES: Record<AlertCenterState, string> = {
  ACTIVE_UNACKNOWLEDGED: 'Alarme ativo, não reconhecido',
  ACTIVE_ACKNOWLEDGED: 'Alarme ativo e reconhecido',
  RESOLVED: 'Alarme resolvido pela normalização da condição',
  SUPPRESSED: 'Alarme encerrado por retirada/supressão do operador',
  UNACKNOWLEDGED: 'Ocorrência não reconhecida e vigente',
  ACKNOWLEDGED: 'Ocorrência reconhecida pelo operador',
  QUIET_24H: 'Ocorrência encerrada após 24h sem novo evento',
  CLOSED: 'Ocorrência encerrada',
};

/** Rótulo curto do estado (chip da tabela). */
export function alertCenterStateLabel(state: AlertCenterState): string {
  return STATE_LABELS[state] ?? state;
}

/** Descrição do estado para tooltip/aria-label (não depende de cor). */
export function alertCenterStateTitle(state: AlertCenterState): string {
  return STATE_TITLES[state] ?? state;
}

const STATE_FILTER_LABELS: Record<AlertCenterStateFilter, string> = {
  ACTIVE: 'Ativos',
  UNACKNOWLEDGED: 'Não reconhecidos',
  ACKNOWLEDGED: 'Reconhecidos',
  RESOLVED: 'Resolvidos',
  SUPPRESSED: 'Suprimidos',
  ALL: 'Todos',
};

export function alertCenterStateFilterLabel(filter: AlertCenterStateFilter): string {
  return STATE_FILTER_LABELS[filter] ?? filter;
}

const PERIOD_LABELS: Record<AlertCenterPeriod, string> = {
  '1h': 'Última 1h',
  '24h': 'Últimas 24h',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
};

export function alertCenterPeriodLabel(period: AlertCenterPeriod): string {
  return PERIOD_LABELS[period] ?? period;
}

/** Rótulo de categoria exibido quando o item não tem severidade de regra. */
export function alertCenterCategoryLabel(category: AlertCenterCategory): string {
  return category === 'ALARM' ? 'ALARME' : 'OCORRÊNCIA';
}

/**
 * Normalização de busca: minúsculas e sem acento, para "optico" achar
 * "RX ÓPTICO" e "manutencao" achar "manutenção" sem exigir acentuação correta.
 */
export function normalizeAlertSearchTerm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Tipos citados pela busca textual. A busca por "crc" acha tanto o alarme
 * `INTERFACE_CRC` quanto a ocorrência `CRC_FCS` (rótulo do domínio, nunca um
 * tipo inexistente).
 */
export function alertCenterTypesMatching(search: string): string[] {
  const term = normalizeAlertSearchTerm(search);
  if (!term) return [];
  const matches: string[] = [];
  for (const option of ALERT_CENTER_TYPE_OPTIONS) {
    const haystack = normalizeAlertSearchTerm(`${option.value} ${option.label}`);
    if (haystack.includes(term)) matches.push(option.value);
  }
  if ('crc'.includes(term) || 'fcs'.includes(term)) {
    for (const value of ['INTERFACE_CRC', 'CRC_FCS']) {
      if (!matches.includes(value)) matches.push(value);
    }
  }
  if ('discard'.includes(term) || 'discards'.includes(term) || 'descarte'.includes(term)) {
    for (const value of ['INTERFACE_DISCARDS', 'DISCARDS']) {
      if (!matches.includes(value)) matches.push(value);
    }
  }
  if ('down'.includes(term) || 'link down'.includes(term)) {
    if (!matches.includes('INTERFACE_DOWN')) matches.push('INTERFACE_DOWN');
  }
  return matches;
}

const TYPE_CATEGORY = new Map(ALERT_CENTER_TYPE_OPTIONS.map((option) => [option.value, option.category]));

/**
 * Tipos da busca que pertencem a categoria pedida. A busca textual cita tipos
 * das DUAS entidades (ex.: "crc" cobre `INTERFACE_CRC` e `CRC_FCS`), e cada
 * consulta so aceita os valores do proprio enum — misturar os dois derruba a
 * consulta no Prisma (`Invalid value for argument 'in'`).
 */
export function alertCenterTypesForCategory(
  types: readonly string[],
  category: AlertCenterCategory,
): string[] {
  return types.filter((type) => TYPE_CATEGORY.get(type) === category);
}
