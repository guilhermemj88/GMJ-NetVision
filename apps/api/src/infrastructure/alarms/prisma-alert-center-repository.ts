import {
  alarmSuppressionFingerprint,
  alertCenterTypesForCategory,
  alertCenterTypesMatching,
  type AlarmMetadata,
  type AlarmSeverity,
  type AlertCenterSummary,
} from '@gmj/shared';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type {
  AlertCenterAlarmRow,
  AlertCenterOccurrenceRow,
  AlertCenterQuery,
  AlertCenterRepository,
  AlertCenterSuppressionRow,
} from './alert-center-repository';
import {
  SUPPRESSION_RESOLUTION_REASONS,
  occurrenceFloorMs,
  occurrenceWindowMs,
} from './alert-center-semantics';

/**
 * Read model Prisma da Central de Alertas.
 *
 * Cada chamada usa um numero FIXO de consultas (list + count por fonte, nomes de
 * regra em lote, supressoes em lote e contadores do resumo) — nunca uma consulta
 * por item.
 */

type AlarmRow = Prisma.AlarmGetPayload<{
  include: { device: true; interface: true; link: true };
}>;
type OccurrenceRow = Prisma.OperationalOccurrenceGetPayload<{
  include: { device: true; interface: true };
}>;

/** Filtro de busca textual reaproveitado por alarme e ocorrencia. */
function searchWhere(term: string): Prisma.AlarmWhereInput[] {
  const contains = { contains: term, mode: 'insensitive' as const };
  return [
    { device: { is: { name: contains } } },
    { device: { is: { displayName: contains } } },
    { device: { is: { hostname: contains } } },
    { interface: { is: { name: contains } } },
    { interface: { is: { alias: contains } } },
    { interface: { is: { description: contains } } },
  ];
}

export function buildAlarmWhere(query: AlertCenterQuery): Prisma.AlarmWhereInput {
  const where: Prisma.AlarmWhereInput = {};
  const and: Prisma.AlarmWhereInput[] = [];

  // Encerrado por retirada/supressao do operador: o motivo fica no metadata.
  const suppressedReasonFilter: Prisma.AlarmWhereInput = {
    OR: SUPPRESSION_RESOLUTION_REASONS.map((reason) => ({
      metadata: { path: ['resolutionReason'], equals: reason },
    })),
  };
  /**
   * `NOT` sobre o path JSON nao basta: com `metadata` NULL (ou sem a chave) a
   * comparacao vira NULL no SQL e a linha cai fora — alarme resolvido por
   * recuperacao tecnica ficava invisivel. Estes dois ramos explicitos cobrem
   * `metadata` NULL e a chave ausente antes da negacao.
   */
  const suppressionReasonAbsentFilter: Prisma.AlarmWhereInput = {
    OR: [
      { metadata: { equals: Prisma.DbNull } },
      { metadata: { path: ['resolutionReason'], equals: Prisma.AnyNull } },
      { NOT: suppressedReasonFilter },
    ],
  };

  switch (query.state) {
    case 'ACTIVE':
      where.endedAt = null;
      break;
    case 'UNACKNOWLEDGED':
      where.endedAt = null;
      where.acknowledgedAt = null;
      break;
    case 'ACKNOWLEDGED':
      where.endedAt = null;
      where.acknowledgedAt = { not: null };
      break;
    case 'RESOLVED':
      and.push({ endedAt: { not: null } });
      and.push(suppressionReasonAbsentFilter);
      break;
    case 'SUPPRESSED':
      and.push({ endedAt: { not: null } });
      and.push(suppressedReasonFilter);
      break;
    default:
      break;
  }

  // Período NUNCA esconde alarme ativo (spec F9.3 §20): só o histórico encerrado.
  if (query.fromMs !== null) {
    and.push({
      OR: [{ endedAt: null }, { endedAt: { gte: new Date(query.fromMs) } }],
    });
  }
  if (query.alarmTypes?.length) where.type = { in: [...query.alarmTypes] as never[] };
  if (query.severities?.length) where.severity = { in: [...query.severities] as never[] };
  if (query.deviceId) where.deviceId = query.deviceId;
  if (query.interfaceId) where.interfaceId = query.interfaceId;
  if (query.search?.trim()) {
    const term = query.search.trim();
    // Somente tipos do enum do ALARME: a busca cita as duas entidades e o
    // Prisma recusa um tipo de ocorrencia no filtro de alarme.
    const typeMatches = alertCenterTypesForCategory(alertCenterTypesMatching(term), 'ALARM');
    and.push({
      OR: [
        ...searchWhere(term),
        ...(typeMatches.length ? [{ type: { in: typeMatches as never[] } }] : []),
      ],
    });
  }
  return and.length ? { ...where, AND: and } : where;
}

function occurrenceSearchWhere(term: string): Prisma.OperationalOccurrenceWhereInput[] {
  const contains = { contains: term, mode: 'insensitive' as const };
  return [
    { device: { is: { name: contains } } },
    { device: { is: { displayName: contains } } },
    { device: { is: { hostname: contains } } },
    { interface: { is: { name: contains } } },
    { interface: { is: { alias: contains } } },
    { interface: { is: { description: contains } } },
  ];
}

/** Filtro que nunca casa (`RESOLVED`/`SUPPRESSED` nao existem em ocorrencia). */
export function buildOccurrenceWhere(
  query: AlertCenterQuery,
): Prisma.OperationalOccurrenceWhereInput {
  const and: Prisma.OperationalOccurrenceWhereInput[] = [];
  const where: Prisma.OperationalOccurrenceWhereInput = {};

  if (query.state === 'ACTIVE' || query.state === 'UNACKNOWLEDGED') {
    where.closedAt = null;
    where.acknowledgedAt = null;
  } else if (query.state === 'ACKNOWLEDGED') {
    where.acknowledgedAt = { not: null };
  } else if (query.state === 'RESOLVED' || query.state === 'SUPPRESSED') {
    and.push({ id: { in: [] } });
  }

  const floorMs = occurrenceFloorMs(query.state, query.fromMs, query.now.getTime());
  if (floorMs !== null) where.lastSeenAt = { gte: new Date(floorMs) };
  if (query.occurrenceTypes?.length) where.type = { in: [...query.occurrenceTypes] as never[] };
  if (query.deviceId) where.deviceId = query.deviceId;
  if (query.interfaceId) where.interfaceId = query.interfaceId;
  if (query.search?.trim()) {
    const term = query.search.trim();
    // Somente tipos do enum da OCORRENCIA (o inverso do alarme).
    const typeMatches = alertCenterTypesForCategory(alertCenterTypesMatching(term), 'OCCURRENCE');
    and.push({
      OR: [
        ...occurrenceSearchWhere(term),
        ...(typeMatches.length ? [{ type: { in: typeMatches as never[] } }] : []),
      ],
    });
  }
  return and.length ? { ...where, AND: and } : where;
}

/** Ordem do banco alinhada ao comparador global (ativos/nao reconhecidos primeiro). */
function alarmOrderBy(): Prisma.AlarmOrderByWithRelationInput[] {
  return [
    { endedAt: { sort: 'asc', nulls: 'first' } },
    { acknowledgedAt: { sort: 'asc', nulls: 'first' } },
    { updatedAt: 'desc' },
    { id: 'asc' },
  ];
}

function occurrenceOrderBy(): Prisma.OperationalOccurrenceOrderByWithRelationInput[] {
  return [
    { closedAt: { sort: 'asc', nulls: 'first' } },
    { acknowledgedAt: { sort: 'asc', nulls: 'first' } },
    { lastSeenAt: 'desc' },
    { id: 'asc' },
  ];
}

function toMetadata(value: Prisma.JsonValue | null): AlarmMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AlarmMetadata;
}

/** Fingerprint canonico do alarme (mesma regra da F9.1) — usado no lote de supressoes. */
function suppressionFingerprint(row: {
  interfaceId: string | null;
  type: string;
  ruleId: string | null;
  metricKey: string | null;
}): string | null {
  if (!row.interfaceId) return null;
  return alarmSuppressionFingerprint({
    interfaceId: row.interfaceId,
    type: row.type as never,
    ruleId: row.ruleId,
    metricKey: row.metricKey,
  });
}

export class PrismaAlertCenterRepository implements AlertCenterRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async listAlarms(query: AlertCenterQuery): Promise<AlertCenterAlarmRow[]> {
    const rows = await this.prisma.alarm.findMany({
      where: buildAlarmWhere(query),
      orderBy: alarmOrderBy(),
      take: query.take,
      include: { device: true, interface: true, link: true },
    });
    if (!rows.length) return [];
    const [ruleNames, suppressions] = await Promise.all([
      this.ruleNames(rows.map((row) => row.ruleId).filter((id): id is string => Boolean(id))),
      this.suppressions(rows),
    ]);
    return rows.map((row) => this.toAlarmRow(row, ruleNames, suppressions));
  }

  async countAlarms(query: AlertCenterQuery): Promise<number> {
    return this.prisma.alarm.count({ where: buildAlarmWhere(query) });
  }

  async listOccurrences(query: AlertCenterQuery): Promise<AlertCenterOccurrenceRow[]> {
    const rows = await this.prisma.operationalOccurrence.findMany({
      where: buildOccurrenceWhere(query),
      orderBy: occurrenceOrderBy(),
      take: query.take,
      include: { device: true, interface: true },
    });
    return rows.map((row) => this.toOccurrenceRow(row));
  }

  async countOccurrences(query: AlertCenterQuery): Promise<number> {
    return this.prisma.operationalOccurrence.count({ where: buildOccurrenceWhere(query) });
  }

  /** Contadores operacionais em 5 consultas fixas (nunca por item). */
  async summaryCounts(now: Date): Promise<AlertCenterSummary> {
    const [bySeverity, acknowledged, occurrencesUnacknowledged, occurrencesAcknowledged, quiet] =
      await Promise.all([
        this.prisma.alarm.groupBy({
          by: ['severity'],
          where: { endedAt: null },
          _count: { _all: true },
        }),
        this.prisma.alarm.count({ where: { endedAt: null, acknowledgedAt: { not: null } } }),
        this.prisma.operationalOccurrence.count({
          where: {
            closedAt: null,
            acknowledgedAt: null,
            lastSeenAt: { gte: new Date(now.getTime() - occurrenceWindowMs()) },
          },
        }),
        this.prisma.operationalOccurrence.count({
          where: {
            acknowledgedAt: { not: null },
            lastSeenAt: { gte: new Date(now.getTime() - occurrenceWindowMs()) },
          },
        }),
        this.prisma.operationalOccurrence.count({
          where: {
            closeReason: 'QUIET_24H',
            closedAt: { gte: new Date(now.getTime() - occurrenceWindowMs()) },
          },
        }),
      ]);

    const severityCount = (severity: AlarmSeverity): number =>
      bySeverity.find((group) => group.severity === severity)?._count._all ?? 0;
    const alarmsActive = bySeverity.reduce((total, group) => total + group._count._all, 0);
    return {
      alarmsActive,
      alarmsActiveCritical: severityCount('CRITICAL'),
      alarmsActiveMajor: severityCount('MAJOR'),
      alarmsActiveWarning: severityCount('WARNING'),
      alarmsActiveInfo: severityCount('INFO'),
      alarmsActiveAcknowledged: acknowledged,
      alarmsActiveUnacknowledged: Math.max(alarmsActive - acknowledged, 0),
      occurrencesUnacknowledged,
      occurrencesAcknowledged,
      occurrencesQuiet24h: quiet,
    };
  }

  async mapIdsByDevice(deviceIds: readonly string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (!deviceIds.length) return result;
    const nodes = await this.prisma.mapNode.findMany({
      where: { deviceId: { in: [...deviceIds] } },
      select: { deviceId: true, mapId: true },
    });
    for (const node of nodes) {
      if (!node.deviceId) continue;
      const list = result.get(node.deviceId) ?? [];
      if (!list.includes(node.mapId)) list.push(node.mapId);
      result.set(node.deviceId, list);
    }
    return result;
  }

  /** Nome da regra em UMA consulta para toda a pagina. */
  private async ruleNames(ruleIds: readonly string[]): Promise<Map<string, string>> {
    if (!ruleIds.length) return new Map();
    const rules = await this.prisma.alarmRule.findMany({
      where: { id: { in: [...new Set(ruleIds)] } },
      select: { id: true, name: true },
    });
    return new Map(rules.map((rule) => [rule.id, rule.name]));
  }

  /** Supressoes que explicam os alarmes encerrados da pagina (UMA consulta). */
  private async suppressions(rows: AlarmRow[]): Promise<Map<string, AlertCenterSuppressionRow>> {
    const fingerprints = new Set<string>();
    for (const row of rows) {
      if (!row.endedAt) continue;
      const fingerprint = suppressionFingerprint({
        interfaceId: row.interfaceId,
        type: row.type,
        ruleId: row.ruleId,
        metricKey: row.metricKey,
      });
      if (fingerprint) fingerprints.add(fingerprint);
    }
    if (!fingerprints.size) return new Map();
    const found = await this.prisma.alarmSuppression.findMany({
      where: { fingerprint: { in: [...fingerprints] } },
      orderBy: { suppressedAt: 'desc' },
    });
    const map = new Map<string, AlertCenterSuppressionRow>();
    for (const row of found) {
      if (map.has(row.fingerprint)) continue;
      map.set(row.fingerprint, {
        id: row.id,
        mode: row.mode,
        reason: row.reason,
        note: row.note ?? null,
        suppressedBy: row.suppressedBy,
        suppressedAt: row.suppressedAt,
        expiresAt: row.expiresAt ?? null,
      });
    }
    return map;
  }

  private toAlarmRow(
    row: AlarmRow,
    ruleNames: Map<string, string>,
    suppressions: Map<string, AlertCenterSuppressionRow>,
  ): AlertCenterAlarmRow {
    const metadata = toMetadata(row.metadata);
    const fingerprint = suppressionFingerprint({
      interfaceId: row.interfaceId,
      type: row.type,
      ruleId: row.ruleId,
      metricKey: row.metricKey,
    });
    return {
      id: row.id,
      type: row.type,
      severity: row.severity,
      startedAt: row.startedAt,
      endedAt: row.endedAt ?? null,
      acknowledgedAt: row.acknowledgedAt ?? null,
      acknowledgedBy: row.acknowledgedBy ?? null,
      updatedAt: row.updatedAt,
      deviceId: row.deviceId,
      deviceName: row.device.displayName || row.device.name,
      deviceHostname: row.device.hostname ?? null,
      site: row.device.site ?? null,
      interfaceId: row.interfaceId ?? null,
      interfaceName: row.interface?.name ?? null,
      interfaceAlias: row.interface?.alias ?? null,
      interfaceDescription: row.interface?.description ?? null,
      ifIndex: row.interface?.ifIndex ?? null,
      linkId: row.linkId ?? null,
      linkLabel: row.link?.label ?? null,
      ruleId: row.ruleId ?? null,
      ruleName: row.ruleId ? (ruleNames.get(row.ruleId) ?? null) : null,
      metricKey: row.metricKey ?? null,
      currentValue: row.currentValue ?? null,
      thresholdValue: row.thresholdValue ?? null,
      unit: row.unit ?? null,
      message: row.message,
      metadata,
      suppression: (fingerprint && suppressions.get(fingerprint)) || null,
    };
  }

  private toOccurrenceRow(row: OccurrenceRow): AlertCenterOccurrenceRow {
    return {
      id: row.id,
      type: row.type,
      deviceId: row.deviceId,
      deviceName: row.device.displayName || row.device.name,
      deviceHostname: row.device.hostname ?? null,
      site: row.device.site ?? null,
      interfaceId: row.interfaceId,
      interfaceName: row.interface.name,
      interfaceAlias: row.interface.alias ?? null,
      interfaceDescription: row.interface.description ?? null,
      ifIndex: row.interface.ifIndex,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      occurrenceCount: row.occurrenceCount,
      crcDeltaTotal: row.crcDeltaTotal,
      rxDiscardDeltaTotal: row.rxDiscardDeltaTotal,
      txDiscardDeltaTotal: row.txDiscardDeltaTotal,
      currentRatePerMin: row.currentRatePerMin,
      peakRatePerMin: row.peakRatePerMin,
      acknowledgedAt: row.acknowledgedAt ?? null,
      acknowledgedBy: row.acknowledgedBy ?? null,
      closedAt: row.closedAt ?? null,
      closeReason: row.closeReason ?? null,
    };
  }
}
