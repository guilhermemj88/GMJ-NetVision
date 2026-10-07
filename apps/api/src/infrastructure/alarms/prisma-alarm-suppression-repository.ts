import type { AlarmSuppressionClearReason, AlarmType } from '@gmj/shared';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type {
  AlarmSuppressionCreateInput,
  AlarmSuppressionFilter,
  AlarmSuppressionRecord,
  AlarmSuppressionRepository,
} from './alarm-suppression-repository';

type SuppressionRow = Awaited<ReturnType<PrismaClient['alarmSuppression']['findFirst']>>;

function toRecord(row: NonNullable<SuppressionRow>): AlarmSuppressionRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    deviceId: row.deviceId,
    interfaceId: row.interfaceId,
    type: row.type as AlarmType,
    ruleId: row.ruleId ?? null,
    metricKey: row.metricKey ?? null,
    mode: row.mode,
    reason: row.reason,
    note: row.note ?? null,
    suppressedAt: row.suppressedAt,
    suppressedBy: row.suppressedBy,
    expiresAt: row.expiresAt ?? null,
    clearedAt: row.clearedAt ?? null,
    clearedReason: (row.clearedReason as AlarmSuppressionClearReason | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Filtro comum de "ainda bloqueia": nao liberada e fora de janela vencida. */
function activeWhere(now: Date): Prisma.AlarmSuppressionWhereInput {
  return {
    clearedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export class PrismaAlarmSuppressionRepository implements AlarmSuppressionRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async create(input: AlarmSuppressionCreateInput): Promise<AlarmSuppressionRecord | null> {
    const existing = await this.prisma.alarmSuppression.findFirst({
      where: { fingerprint: input.fingerprint, ...activeWhere(input.suppressedAt) },
      select: { id: true },
    });
    if (existing) return null;

    const row = await this.prisma.alarmSuppression.create({
      data: {
        fingerprint: input.fingerprint,
        deviceId: input.deviceId,
        interfaceId: input.interfaceId,
        type: input.type,
        ruleId: input.ruleId ?? null,
        metricKey: input.metricKey ?? null,
        mode: input.mode,
        reason: input.reason,
        note: input.note ?? null,
        suppressedAt: input.suppressedAt,
        suppressedBy: input.suppressedBy,
        expiresAt: input.expiresAt ?? null,
      },
    });
    return toRecord(row);
  }

  async listActive(
    now: Date,
    filter?: AlarmSuppressionFilter,
  ): Promise<AlarmSuppressionRecord[]> {
    const rows = await this.prisma.alarmSuppression.findMany({
      where: {
        ...activeWhere(now),
        ...(filter?.deviceId ? { deviceId: filter.deviceId } : {}),
        ...(filter?.interfaceIds?.length ? { interfaceId: { in: [...filter.interfaceIds] } } : {}),
        ...(filter?.fingerprints?.length ? { fingerprint: { in: [...filter.fingerprints] } } : {}),
        ...(filter?.types?.length ? { type: { in: [...filter.types] } } : {}),
      },
      orderBy: { suppressedAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async listRecent(limit: number): Promise<AlarmSuppressionRecord[]> {
    const rows = await this.prisma.alarmSuppression.findMany({
      orderBy: { suppressedAt: 'desc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findById(id: string): Promise<AlarmSuppressionRecord | null> {
    const row = await this.prisma.alarmSuppression.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async clear(
    id: string,
    clearedAt: Date,
    clearedReason: AlarmSuppressionClearReason,
  ): Promise<AlarmSuppressionRecord | null> {
    const updated = await this.prisma.alarmSuppression.updateMany({
      where: { id, clearedAt: null },
      data: { clearedAt, clearedReason },
    });
    if (!updated.count) return null;
    return this.findById(id);
  }

  async clearRecovered(fingerprints: readonly string[], clearedAt: Date): Promise<number> {
    if (!fingerprints.length) return 0;
    const result = await this.prisma.alarmSuppression.updateMany({
      where: {
        fingerprint: { in: [...fingerprints] },
        clearedAt: null,
        mode: 'UNTIL_CLEAR',
      },
      data: { clearedAt, clearedReason: 'RECOVERED' },
    });
    return result.count;
  }

  async expireDue(now: Date): Promise<number> {
    const result = await this.prisma.alarmSuppression.updateMany({
      where: { clearedAt: null, expiresAt: { not: null, lte: now } },
      data: { clearedAt: now, clearedReason: 'EXPIRED' },
    });
    return result.count;
  }
}
