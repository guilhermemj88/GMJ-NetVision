import type {
  AlarmMetadata,
  AlarmResolutionReason,
  AlarmSeverity,
  AlertCenterStateFilter,
  AlertCenterSummary,
  AlarmSuppressionMode,
  AlarmSuppressionReason,
} from '@gmj/shared';

/**
 * Read model da Central de Alertas (F9.3).
 *
 * O repositorio entrega LINHAS normalizadas de cada entidade (alarme e
 * ocorrencia) com a identidade de equipamento/interface ja resolvida na mesma
 * consulta. O servico funde as duas fontes, ordena e pagina — sem N+1: por
 * pagina o repositorio faz um numero CONSTANTE de consultas, independente da
 * quantidade de itens.
 */

/** Filtro normalizado; o servico resolve periodo, limite e vigencia. */
export interface AlertCenterQuery {
  now: Date;
  state: AlertCenterStateFilter;
  /** Corte de período para HISTORICO (alarme encerrado / occurrence). */
  fromMs: number | null;
  /** Tipos ja separados por categoria (o servico evita fonte sem tipo). */
  alarmTypes?: readonly string[] | undefined;
  occurrenceTypes?: readonly string[] | undefined;
  severities?: readonly AlarmSeverity[] | undefined;
  deviceId?: string | undefined;
  interfaceId?: string | undefined;
  search?: string | undefined;
  /** Quantos itens a fonte precisa entregar para compor a pagina pedida. */
  take: number;
}

/** Supressao (F9.1) que explica um alarme encerrado administrativamente. */
export interface AlertCenterSuppressionRow {
  id: string;
  mode: AlarmSuppressionMode;
  reason: AlarmSuppressionReason;
  note: string | null;
  suppressedBy: string;
  suppressedAt: Date;
  expiresAt: Date | null;
}

export interface AlertCenterAlarmRow {
  id: string;
  type: string;
  severity: AlarmSeverity;
  startedAt: Date;
  endedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  /** Ultima mudanca de estado (escalacao, ACK ou encerramento). */
  updatedAt: Date;
  deviceId: string;
  deviceName: string;
  deviceHostname: string | null;
  site: string | null;
  interfaceId: string | null;
  interfaceName: string | null;
  interfaceAlias: string | null;
  interfaceDescription: string | null;
  ifIndex: number | null;
  linkId: string | null;
  linkLabel: string | null;
  ruleId: string | null;
  ruleName: string | null;
  metricKey: string | null;
  currentValue: number | null;
  thresholdValue: number | null;
  unit: string | null;
  message: string;
  metadata: AlarmMetadata | null;
  suppression: AlertCenterSuppressionRow | null;
}

export interface AlertCenterOccurrenceRow {
  id: string;
  type: string;
  deviceId: string;
  deviceName: string;
  deviceHostname: string | null;
  site: string | null;
  interfaceId: string;
  interfaceName: string;
  interfaceAlias: string | null;
  interfaceDescription: string | null;
  ifIndex: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  crcDeltaTotal: bigint;
  rxDiscardDeltaTotal: bigint;
  txDiscardDeltaTotal: bigint;
  currentRatePerMin: number;
  peakRatePerMin: number;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  closedAt: Date | null;
  closeReason: AlarmResolutionReason | string | null;
}

export interface AlertCenterRepository {
  /** Linhas de alarme que atendem ao filtro (janela de `take`). */
  listAlarms(query: AlertCenterQuery): Promise<AlertCenterAlarmRow[]>;
  countAlarms(query: AlertCenterQuery): Promise<number>;
  /** Linhas de ocorrencia que atendem ao filtro (janela de `take`). */
  listOccurrences(query: AlertCenterQuery): Promise<AlertCenterOccurrenceRow[]>;
  countOccurrences(query: AlertCenterQuery): Promise<number>;
  /** Contadores operacionais globais (sem filtro) para cards e badge. */
  summaryCounts(now: Date): Promise<AlertCenterSummary>;
  /** Mapas que contem cada equipamento (acao "Abrir no mapa"). */
  mapIdsByDevice(deviceIds: readonly string[]): Promise<Map<string, string[]>>;
}
