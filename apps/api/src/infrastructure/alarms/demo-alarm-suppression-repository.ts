import { randomUUID } from 'node:crypto';
import { isAlarmSuppressionActiveAt, type AlarmSuppressionClearReason } from '@gmj/shared';
import type {
  AlarmSuppressionCreateInput,
  AlarmSuppressionFilter,
  AlarmSuppressionRecord,
  AlarmSuppressionRepository,
} from './alarm-suppression-repository';

/**
 * Repositorio em memoria (DEMO_MODE / testes): mesma semantica do Prisma, sem
 * banco. Uma supressao expirada continua visivel no historico, mas `listActive`
 * nunca a devolve.
 */
export class DemoAlarmSuppressionRepository implements AlarmSuppressionRepository {
  private readonly suppressions: AlarmSuppressionRecord[] = [];

  async create(input: AlarmSuppressionCreateInput): Promise<AlarmSuppressionRecord | null> {
    const existing = this.suppressions.find(
      (row) => row.fingerprint === input.fingerprint && isActive(row, input.suppressedAt),
    );
    if (existing) return null;

    const now = input.suppressedAt;
    const record: AlarmSuppressionRecord = {
      id: randomUUID(),
      fingerprint: input.fingerprint,
      deviceId: input.deviceId,
      interfaceId: input.interfaceId,
      type: input.type,
      ruleId: input.ruleId ?? null,
      metricKey: input.metricKey ?? null,
      mode: input.mode,
      reason: input.reason,
      note: input.note ?? null,
      suppressedAt: now,
      suppressedBy: input.suppressedBy,
      expiresAt: input.expiresAt ?? null,
      clearedAt: null,
      clearedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.suppressions.push(record);
    return record;
  }

  async listActive(
    now: Date,
    filter?: AlarmSuppressionFilter,
  ): Promise<AlarmSuppressionRecord[]> {
    return this.suppressions
      .filter((row) => isActive(row, now))
      .filter((row) => !filter?.deviceId || row.deviceId === filter.deviceId)
      .filter((row) => !filter?.interfaceIds?.length || filter.interfaceIds.includes(row.interfaceId))
      .filter((row) => !filter?.fingerprints?.length || filter.fingerprints.includes(row.fingerprint))
      .filter(
        (row) =>
          !filter?.types?.length ||
          (filter.types as readonly string[]).includes(row.type),
      )
      .sort((left, right) => right.suppressedAt.getTime() - left.suppressedAt.getTime())
      .map(clone);
  }

  async listRecent(limit: number): Promise<AlarmSuppressionRecord[]> {
    return [...this.suppressions]
      .sort((left, right) => right.suppressedAt.getTime() - left.suppressedAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async findById(id: string): Promise<AlarmSuppressionRecord | null> {
    const row = this.suppressions.find((item) => item.id === id);
    return row ? clone(row) : null;
  }

  async clear(
    id: string,
    clearedAt: Date,
    clearedReason: AlarmSuppressionClearReason,
  ): Promise<AlarmSuppressionRecord | null> {
    const row = this.suppressions.find((item) => item.id === id && !item.clearedAt);
    if (!row) return null;
    row.clearedAt = clearedAt;
    row.clearedReason = clearedReason;
    row.updatedAt = clearedAt;
    return clone(row);
  }

  async clearRecovered(fingerprints: readonly string[], clearedAt: Date): Promise<number> {
    let cleared = 0;
    for (const row of this.suppressions) {
      if (row.clearedAt || row.mode !== 'UNTIL_CLEAR') continue;
      if (!fingerprints.includes(row.fingerprint)) continue;
      row.clearedAt = clearedAt;
      row.clearedReason = 'RECOVERED';
      row.updatedAt = clearedAt;
      cleared += 1;
    }
    return cleared;
  }

  async expireDue(now: Date): Promise<number> {
    let expired = 0;
    for (const row of this.suppressions) {
      if (row.clearedAt || !row.expiresAt) continue;
      if (row.expiresAt.getTime() > now.getTime()) continue;
      row.clearedAt = now;
      row.clearedReason = 'EXPIRED';
      row.updatedAt = now;
      expired += 1;
    }
    return expired;
  }
}

function isActive(row: AlarmSuppressionRecord, now: Date): boolean {
  return isAlarmSuppressionActiveAt(row, now.getTime());
}

function clone(row: AlarmSuppressionRecord): AlarmSuppressionRecord {
  return { ...row };
}
