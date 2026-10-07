import {
  alarmSuppressionFingerprint,
  type Alarm,
  type AlarmMetadata,
  type AlarmSeverity,
  type AlertCenterSummary,
} from '@gmj/shared';
import type { AlarmRepository } from './alarm-repository';
import type { AlarmSuppressionRepository } from './alarm-suppression-repository';
import type { OperationalOccurrenceRepository } from './operational-occurrence-repository';
import type {
  AlertCenterAlarmRow,
  AlertCenterOccurrenceRow,
  AlertCenterQuery,
  AlertCenterRepository,
  AlertCenterSuppressionRow,
} from './alert-center-repository';
import {
  alarmMatchesPeriodFilter,
  alarmMatchesSearch,
  alarmMatchesStateFilter,
  occurrenceFloorMs,
  occurrenceMatchesPeriodFilter,
  occurrenceMatchesSearch,
  occurrenceMatchesStateFilter,
  occurrenceWindowMs,
} from './alert-center-semantics';

/** Teto interno do modo DEMO: sem polling real, o volume e pequeno. */
const DEMO_SCAN_LIMIT = 500;

/**
 * Identidade de exibicao usada quando o host NAO esta cadastrado localmente
 * (DEMO_MODE monta nomes sinteticos; testes injetam um catalogo real).
 */
export interface AlertCenterIdentityLookup {
  (interfaceId: string, deviceId: string):
    | {
        deviceName: string;
        deviceHostname?: string | null;
        site?: string | null;
        interfaceName: string;
        interfaceAlias?: string | null;
        interfaceDescription?: string | null;
        ifIndex: number;
      }
    | undefined;
}

/**
 * Read model em memoria (DEMO_MODE e testes): aplica exatamente as mesmas
 * regras do repositorio Prisma sobre os alarmes e ocorrencias ja existentes.
 */
export class DemoAlertCenterRepository implements AlertCenterRepository {
  constructor(
    private readonly alarms: AlarmRepository,
    private readonly occurrences?: OperationalOccurrenceRepository | undefined,
    private readonly suppressions?: AlarmSuppressionRepository | undefined,
    private readonly identity?: AlertCenterIdentityLookup | undefined,
  ) {}

  async listAlarms(query: AlertCenterQuery): Promise<AlertCenterAlarmRow[]> {
    const rows = filterAlarmRows(await this.alarmRows(), query);
    return rows.slice(0, query.take);
  }

  async countAlarms(query: AlertCenterQuery): Promise<number> {
    return filterAlarmRows(await this.alarmRows(), query).length;
  }

  async listOccurrences(query: AlertCenterQuery): Promise<AlertCenterOccurrenceRow[]> {
    const rows = filterOccurrenceRows(await this.occurrenceRows(query.now), query);
    return rows.slice(0, query.take);
  }

  async countOccurrences(query: AlertCenterQuery): Promise<number> {
    return filterOccurrenceRows(await this.occurrenceRows(query.now), query).length;
  }

  async summaryCounts(now: Date): Promise<AlertCenterSummary> {
    const activeAlarms = (await this.alarmRows()).filter((row) => row.endedAt === null);
    const occurrences = (await this.occurrenceRows(now)).filter(
      (row) => row.lastSeenAt.getTime() >= now.getTime() - occurrenceWindowMs(),
    );
    const severityCount = (severity: AlarmSeverity) =>
      activeAlarms.filter((row) => row.severity === severity).length;
    const acknowledged = activeAlarms.filter((row) => row.acknowledgedAt !== null).length;
    return {
      alarmsActive: activeAlarms.length,
      alarmsActiveCritical: severityCount('CRITICAL'),
      alarmsActiveMajor: severityCount('MAJOR'),
      alarmsActiveWarning: severityCount('WARNING'),
      alarmsActiveInfo: severityCount('INFO'),
      alarmsActiveAcknowledged: acknowledged,
      alarmsActiveUnacknowledged: activeAlarms.length - acknowledged,
      occurrencesUnacknowledged: occurrences.filter(
        (row) => row.closedAt === null && row.acknowledgedAt === null,
      ).length,
      occurrencesAcknowledged: occurrences.filter((row) => row.acknowledgedAt !== null).length,
      occurrencesQuiet24h: occurrences.filter((row) => row.closeReason === 'QUIET_24H').length,
    };
  }

  async mapIdsByDevice(): Promise<Map<string, string[]>> {
    // DEMO nao possui associacao de mapas persistida para a Central.
    return new Map();
  }

  private async alarmRows(): Promise<AlertCenterAlarmRow[]> {
    const [active, history] = await Promise.all([
      this.alarms.listActive(),
      this.alarms.listHistory(DEMO_SCAN_LIMIT),
    ]);
    const unique = new Map<string, Alarm>();
    for (const alarm of [...active, ...history]) unique.set(alarm.id, alarm);
    const suppressionIndex = await this.suppressionIndex();
    return [...unique.values()].map((alarm) => {
      const fingerprint = alarm.interfaceId
        ? alarmSuppressionFingerprint({
            interfaceId: alarm.interfaceId,
            type: alarm.type,
            ruleId: alarm.ruleId ?? null,
            metricKey: alarm.metricKey ?? null,
          })
        : null;
      const identity = alarm.interfaceId
        ? this.identity?.(alarm.interfaceId, alarm.deviceId)
        : undefined;
      return {
        id: alarm.id,
        type: alarm.type,
        severity: alarm.severity,
        startedAt: new Date(alarm.startedAt),
        endedAt: alarm.endedAt ? new Date(alarm.endedAt) : null,
        acknowledgedAt: alarm.acknowledgedAt ? new Date(alarm.acknowledgedAt) : null,
        acknowledgedBy: alarm.acknowledgedBy ?? null,
        updatedAt: new Date(alarm.endedAt ?? alarm.acknowledgedAt ?? alarm.startedAt),
        deviceId: alarm.deviceId,
        deviceName: identity?.deviceName ?? alarm.deviceName,
        deviceHostname: identity?.deviceHostname ?? null,
        site: identity?.site ?? null,
        interfaceId: alarm.interfaceId,
        interfaceName: identity?.interfaceName ?? alarm.interfaceName,
        interfaceAlias: identity?.interfaceAlias ?? null,
        interfaceDescription: identity?.interfaceDescription ?? alarm.interfaceLabel,
        ifIndex: identity?.ifIndex ?? alarm.ifIndex,
        linkId: alarm.linkId ?? null,
        linkLabel: alarm.linkLabel ?? null,
        ruleId: alarm.ruleId ?? null,
        ruleName: null,
        metricKey: alarm.metricKey ?? null,
        currentValue: alarm.currentValue ?? null,
        thresholdValue: alarm.thresholdValue ?? null,
        unit: alarm.unit ?? null,
        message: alarm.message,
        metadata: (alarm.metadata ?? null) as AlarmMetadata | null,
        suppression: (fingerprint && suppressionIndex.get(fingerprint)) || null,
      };
    });
  }

  private async suppressionIndex(): Promise<Map<string, AlertCenterSuppressionRow>> {
    if (!this.suppressions) return new Map();
    const rows = await this.suppressions.listRecent(DEMO_SCAN_LIMIT);
    const index = new Map<string, AlertCenterSuppressionRow>();
    for (const row of rows) {
      if (index.has(row.fingerprint)) continue;
      index.set(row.fingerprint, {
        id: row.id,
        mode: row.mode,
        reason: row.reason,
        note: row.note ?? null,
        suppressedBy: row.suppressedBy,
        suppressedAt: row.suppressedAt,
        expiresAt: row.expiresAt ?? null,
      });
    }
    return index;
  }

  private async occurrenceRows(now: Date): Promise<AlertCenterOccurrenceRow[]> {
    if (!this.occurrences) return [];
    const { items } = await this.occurrences.list({
      now,
      quietMs: occurrenceWindowMs(),
      limit: DEMO_SCAN_LIMIT,
      offset: 0,
    });
    return items.map((row) => {
      const identity = this.identity?.(row.interfaceId, row.deviceId);
      return {
        id: row.id,
        type: row.type,
        deviceId: row.deviceId,
        deviceName: identity?.deviceName ?? row.deviceName,
        deviceHostname: identity?.deviceHostname ?? null,
        site: identity?.site ?? null,
        interfaceId: row.interfaceId,
        interfaceName: identity?.interfaceName ?? row.interfaceName,
        interfaceAlias: identity?.interfaceAlias ?? null,
        interfaceDescription: identity?.interfaceDescription ?? row.interfaceLabel,
        ifIndex: identity?.ifIndex ?? row.ifIndex,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        occurrenceCount: row.occurrenceCount,
        crcDeltaTotal: row.crcDeltaTotal,
        rxDiscardDeltaTotal: row.rxDiscardDeltaTotal,
        txDiscardDeltaTotal: row.txDiscardDeltaTotal,
        currentRatePerMin: row.currentRatePerMin,
        peakRatePerMin: row.peakRatePerMin,
        acknowledgedAt: row.acknowledgedAt,
        acknowledgedBy: row.acknowledgedBy,
        closedAt: row.closedAt,
        closeReason: row.closeReason ?? null,
      };
    });
  }
}

function filterAlarmRows(
  rows: readonly AlertCenterAlarmRow[],
  query: AlertCenterQuery,
): AlertCenterAlarmRow[] {
  // Fonte sem nenhum tipo de alarme pedido nao devolve linha alguma.
  if (query.alarmTypes && !query.alarmTypes.length) return [];
  return rows
    .filter((row) => alarmMatchesStateFilter(row, query.state))
    .filter((row) => alarmMatchesPeriodFilter(row, query.fromMs))
    .filter((row) => !query.alarmTypes?.length || query.alarmTypes.includes(row.type))
    .filter((row) => !query.severities?.length || query.severities.includes(row.severity))
    .filter((row) => !query.deviceId || row.deviceId === query.deviceId)
    .filter((row) => !query.interfaceId || row.interfaceId === query.interfaceId)
    .filter((row) => alarmMatchesSearch(row, query.search ?? ''))
    .sort(compareAlarmRows);
}

function filterOccurrenceRows(
  rows: readonly AlertCenterOccurrenceRow[],
  query: AlertCenterQuery,
): AlertCenterOccurrenceRow[] {
  if (query.occurrenceTypes && !query.occurrenceTypes.length) return [];
  const floor = occurrenceFloorMs(query.state, query.fromMs, query.now.getTime());
  return rows
    .filter((row) => occurrenceMatchesStateFilter(row, query.state, query.now.getTime()))
    .filter((row) => occurrenceMatchesPeriodFilter(row, floor))
    .filter((row) => !query.occurrenceTypes?.length || query.occurrenceTypes.includes(row.type))
    .filter((row) => !query.deviceId || row.deviceId === query.deviceId)
    .filter((row) => !query.interfaceId || row.interfaceId === query.interfaceId)
    .filter((row) => occurrenceMatchesSearch(row, query.search ?? ''))
    .sort(compareOccurrenceRows);
}

/** Ordem do banco: o que exige atencao primeiro, depois mais recente, id estavel. */
function compareAlarmRows(left: AlertCenterAlarmRow, right: AlertCenterAlarmRow): number {
  const leftPriority = left.endedAt === null ? (left.acknowledgedAt === null ? 0 : 1) : 3;
  const rightPriority = right.endedAt === null ? (right.acknowledgedAt === null ? 0 : 1) : 3;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const byUpdated = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (byUpdated !== 0) return byUpdated;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareOccurrenceRows(
  left: AlertCenterOccurrenceRow,
  right: AlertCenterOccurrenceRow,
): number {
  const leftPriority = left.closedAt === null ? 0 : 3;
  const rightPriority = right.closedAt === null ? 0 : 3;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const byLastSeen = right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
  if (byLastSeen !== 0) return byLastSeen;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
