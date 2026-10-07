import {
  ALERT_CENTER_DEFAULT_LIMIT,
  ALERT_CENTER_DEFAULT_STATE,
  ALERT_CENTER_MAX_LIMIT,
  ALERT_CENTER_PERIOD_MS,
  ALERT_CENTER_TYPE_OPTIONS,
  alarmInterfaceLabel,
  alarmTypeLabel,
  bigintToSafeNumber,
  operationalOccurrenceTypeLabel,
  type AlertCenterAlarmDetail,
  type AlertCenterCategory,
  type AlertCenterItem,
  type AlertCenterListQuery as AlertCenterListQueryDto,
  type AlertCenterOccurrenceDetail,
  type AlertCenterPeriod,
  type AlertCenterResponse,
  type AlertCenterStateFilter,
  type AlertCenterSummary,
} from '@gmj/shared';
import type {
  AlertCenterAlarmRow,
  AlertCenterOccurrenceRow,
  AlertCenterQuery,
  AlertCenterRepository,
} from '../infrastructure/alarms/alert-center-repository';
import {
  alarmStateFor,
  alarmValueSummary,
  compareAlertCenterItems,
  occurrenceStateFor,
  occurrenceValueSummary,
} from '../infrastructure/alarms/alert-center-semantics';

const TYPE_CATEGORY = new Map(ALERT_CENTER_TYPE_OPTIONS.map((option) => [option.value, option.category]));

export type AlertCenterListInput = AlertCenterListQueryDto;

function isOccurrenceType(type: string): boolean {
  return TYPE_CATEGORY.get(type) === 'OCCURRENCE';
}

function clampLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? ALERT_CENTER_DEFAULT_LIMIT, 1), ALERT_CENTER_MAX_LIMIT);
}

/**
 * Central de Alertas (F9.3): funde `Alarm` e `OperationalOccurrence` em uma
 * pagina unica e ordenada, sem misturar as entidades no dominio.
 *
 * - a ordenacao e explicita (prioridade operacional, `lastSeenAt` DESC, `id`),
 *   nunca a ordem acidental do banco;
 * - o repositorio entrega janelas por fonte com um numero CONSTANTE de
 *   consultas (teste garante que a pagina nao gera consulta por item);
 * - a severidade vem do alarme; occurrence nunca ganha severidade inventada.
 */
export class AlertCenterService {
  constructor(
    private readonly repository: AlertCenterRepository,
    private readonly options: { now?: () => number } = {},
  ) {}

  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Contadores operacionais (badge da TopBar e cards) sem carregar itens. */
  async summary(): Promise<AlertCenterSummary> {
    return this.repository.summaryCounts(new Date(this.nowMs()));
  }

  async list(input: AlertCenterListInput = {}): Promise<AlertCenterResponse> {
    const nowMs = this.nowMs();
    const now = new Date(nowMs);
    const state: AlertCenterStateFilter = input.state ?? ALERT_CENTER_DEFAULT_STATE;
    const period: AlertCenterPeriod | undefined = input.period;
    const fromMs = period ? nowMs - ALERT_CENTER_PERIOD_MS[period] : null;
    const limit = clampLimit(input.limit);
    const offset = Math.max(input.offset ?? 0, 0);
    const types = input.types?.length ? [...new Set(input.types)] : undefined;
    const severities = input.severities?.length ? [...new Set(input.severities)] : undefined;

    const alarmTypes = types?.filter((type) => !isOccurrenceType(type));
    const occurrenceTypes = types?.filter((type) => isOccurrenceType(type));

    // Fonte sem tipo pedido nao e consultada; severidade so existe em alarme.
    const wantAlarms = input.category !== 'OCCURRENCE' && (!types || Boolean(alarmTypes?.length));
    const wantOccurrences =
      input.category !== 'ALARM' &&
      !severities?.length &&
      state !== 'RESOLVED' &&
      state !== 'SUPPRESSED' &&
      (!types || Boolean(occurrenceTypes?.length));

    const query: AlertCenterQuery = {
      now,
      state,
      fromMs,
      ...(alarmTypes?.length ? { alarmTypes } : {}),
      ...(occurrenceTypes?.length ? { occurrenceTypes } : {}),
      ...(severities ? { severities } : {}),
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.interfaceId ? { interfaceId: input.interfaceId } : {}),
      ...(input.search?.trim() ? { search: input.search.trim() } : {}),
      take: offset + limit,
    };

    const [alarmRows, alarmsTotal, occurrenceRows, occurrencesTotal, summary] = await Promise.all([
      wantAlarms ? this.repository.listAlarms(query) : Promise.resolve([]),
      wantAlarms ? this.repository.countAlarms(query) : Promise.resolve(0),
      wantOccurrences ? this.repository.listOccurrences(query) : Promise.resolve([]),
      wantOccurrences ? this.repository.countOccurrences(query) : Promise.resolve(0),
      this.repository.summaryCounts(now),
    ]);

    const mapIds = await this.repository.mapIdsByDevice([
      ...new Set([...alarmRows, ...occurrenceRows].map((row) => row.deviceId)),
    ]);

    const items = [
      ...alarmRows.map((row) => toAlarmItem(row, mapIds.get(row.deviceId) ?? [])),
      ...occurrenceRows.map((row) => toOccurrenceItem(row, mapIds.get(row.deviceId) ?? [])),
    ]
      .sort(compareAlertCenterItems)
      .slice(offset, offset + limit);

    const total = alarmsTotal + occurrencesTotal;
    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
      state,
      summary,
      generatedAt: now.toISOString(),
    };
  }
}

function alarmDetail(row: AlertCenterAlarmRow): AlertCenterAlarmDetail {
  const metadata = row.metadata ?? null;
  const suppression = row.suppression;
  return {
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    metricKey: row.metricKey,
    direction: metadata?.direction ?? null,
    currentValue: row.currentValue,
    thresholdValue: row.thresholdValue,
    unit: row.unit,
    message: row.message,
    linkId: row.linkId,
    linkLabel: row.linkLabel,
    resolutionReason: metadata?.resolutionReason ?? null,
    suppression: suppression
      ? {
          id: suppression.id,
          mode: suppression.mode,
          reason: suppression.reason,
          note: suppression.note,
          suppressedBy: suppression.suppressedBy,
          suppressedAt: suppression.suppressedAt.toISOString(),
          expiresAt: suppression.expiresAt ? suppression.expiresAt.toISOString() : null,
        }
      : null,
    optical:
      row.type === 'OPTICAL_RX_DEGRADATION'
        ? {
            lane: metadata?.lane ?? null,
            rxPowerDbm: metadata?.rxPowerDbm ?? row.currentValue ?? null,
            rxLowAlarmDbm: metadata?.rxLowAlarmDbm ?? null,
            rxHighAlarmDbm: metadata?.rxHighAlarmDbm ?? null,
            marginDb: metadata?.marginDb ?? null,
            proximityPercent: metadata?.proximityPercent ?? null,
            trendDropDb: metadata?.trendDropDb ?? null,
            trendWindowMinutes: metadata?.trendWindowMinutes ?? null,
            triggerReasons: metadata?.triggerReasons ?? [],
            thresholdSource: metadata?.thresholdSource ?? null,
            currentPowerSource: metadata?.currentPowerSource ?? null,
          }
        : null,
  };
}

export function toAlarmItem(row: AlertCenterAlarmRow, mapIds: readonly string[]): AlertCenterItem {
  const state = alarmStateFor({
    endedAt: row.endedAt,
    acknowledgedAt: row.acknowledgedAt,
    suppressionReason: row.metadata?.resolutionReason ?? null,
  });
  return {
    id: row.id,
    category: 'ALARM' as AlertCenterCategory,
    state,
    severity: row.severity,
    type: row.type,
    typeLabel: alarmTypeLabel(row.type),
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    deviceHostname: row.deviceHostname,
    site: row.site,
    interfaceId: row.interfaceId,
    interfaceName: row.interfaceName,
    interfaceAlias: row.interfaceAlias,
    interfaceLabel: row.interfaceName
      ? alarmInterfaceLabel(
          row.interfaceAlias,
          row.interfaceDescription,
          row.interfaceName,
          row.ifIndex ?? 0,
        )
      : null,
    ifIndex: row.ifIndex,
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.updatedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    acknowledgedBy: row.acknowledgedBy,
    valueSummary: alarmValueSummary(row),
    mapIds: [...mapIds],
    alarm: alarmDetail(row),
  };
}

function occurrenceDetail(row: AlertCenterOccurrenceRow): AlertCenterOccurrenceDetail {
  return {
    occurrenceCount: row.occurrenceCount,
    crcDeltaTotal: bigintToSafeNumber(row.crcDeltaTotal),
    rxDiscardDeltaTotal: bigintToSafeNumber(row.rxDiscardDeltaTotal),
    txDiscardDeltaTotal: bigintToSafeNumber(row.txDiscardDeltaTotal),
    currentRatePerMin: row.currentRatePerMin,
    peakRatePerMin: row.peakRatePerMin,
    closeReason: (row.closeReason as AlertCenterOccurrenceDetail['closeReason']) ?? null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    mediaAvailable: false,
  };
}

export function toOccurrenceItem(
  row: AlertCenterOccurrenceRow,
  mapIds: readonly string[],
): AlertCenterItem {
  return {
    id: row.id,
    category: 'OCCURRENCE' as AlertCenterCategory,
    state: occurrenceStateFor({
      acknowledgedAt: row.acknowledgedAt,
      closedAt: row.closedAt,
      closeReason: row.closeReason,
    }),
    // Occurrence nao tem severidade de regra: nunca inventar WARNING/MAJOR.
    severity: null,
    type: row.type,
    typeLabel: operationalOccurrenceTypeLabel(row.type as never),
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    deviceHostname: row.deviceHostname,
    site: row.site,
    interfaceId: row.interfaceId,
    interfaceName: row.interfaceName,
    interfaceAlias: row.interfaceAlias,
    interfaceLabel: alarmInterfaceLabel(
      row.interfaceAlias,
      row.interfaceDescription,
      row.interfaceName,
      row.ifIndex,
    ),
    ifIndex: row.ifIndex,
    startedAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    endedAt: row.closedAt ? row.closedAt.toISOString() : null,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    acknowledgedBy: row.acknowledgedBy,
    valueSummary: occurrenceValueSummary(row),
    mapIds: [...mapIds],
    occurrence: occurrenceDetail(row),
  };
}
