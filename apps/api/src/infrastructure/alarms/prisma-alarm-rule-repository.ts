import type { AlarmRuleRecord, AlarmRuleInput, AlarmRuleRepository } from './alarm-rule-repository';
import type { MetricAlarmType } from '@gmj/shared';
import { isBasicAlarmRuleKey } from '@gmj/shared';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import {
  isMetricAlarmType,
  parseAlarmRuleConfig,
  parseAlarmRuleScope,
} from './alarm-rule-schema';

type AlarmRuleRow = Awaited<ReturnType<PrismaClient['alarmRule']['findMany']>>[number];

export class PrismaAlarmRuleRepository implements AlarmRuleRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async list(): Promise<AlarmRuleRecord[]> {
    const rows = await this.prisma.alarmRule.findMany({ orderBy: [{ createdAt: 'desc' }] });
    return rows.flatMap((row) => this.toRecord(row) ?? []);
  }

  async listEnabled(types?: readonly MetricAlarmType[]): Promise<AlarmRuleRecord[]> {
    const rows = await this.prisma.alarmRule.findMany({
      where: {
        enabled: true,
        ...(types?.length ? { type: { in: [...types] } } : {}),
      },
    });
    return rows.flatMap((row) => this.toRecord(row) ?? []);
  }

  async get(id: string): Promise<AlarmRuleRecord | null> {
    const row = await this.prisma.alarmRule.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async create(input: AlarmRuleInput): Promise<AlarmRuleRecord> {
    const row = await this.prisma.alarmRule.create({ data: this.toData(input) });
    const record = this.toRecord(row);
    if (!record) throw new Error('AlarmRule persistida com payload invalido');
    return record;
  }

  async update(id: string, input: AlarmRuleInput): Promise<AlarmRuleRecord | null> {
    try {
      const row = await this.prisma.alarmRule.update({
        where: { id },
        // F9.6: sem `managedKey` no input o vínculo com o Básico é PRESERVADO —
        // a edição avançada nunca desfaz o slot por acidente.
        data: this.toData(input, { preserveManagedKey: input.managedKey === undefined }),
      });
      return this.toRecord(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<AlarmRuleRecord | null> {
    try {
      const row = await this.prisma.alarmRule.update({ where: { id }, data: { enabled } });
      return this.toRecord(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.prisma.alarmRule.deleteMany({ where: { id } });
    return result.count > 0;
  }

  private toData(
    input: AlarmRuleInput,
    options: { preserveManagedKey?: boolean } = {},
  ): Prisma.AlarmRuleUncheckedCreateInput {
    return {
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      severity: input.severity,
      mapLinkedOnly: input.mapLinkedOnly,
      mediaEnabled: input.mediaEnabled,
      scope: input.scope as unknown as Prisma.InputJsonValue,
      config: input.config as unknown as Prisma.InputJsonValue,
      ...(options.preserveManagedKey ? {} : { managedKey: input.managedKey ?? null }),
    };
  }

  private toRecord(row: AlarmRuleRow): AlarmRuleRecord | null {
    if (!isMetricAlarmType(row.type)) return null;
    const scope = parseAlarmRuleScope(row.scope);
    const config = parseAlarmRuleConfig(row.type, row.config);
    if (!scope || !config) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled,
      severity: row.severity,
      mapLinkedOnly: row.mapLinkedOnly,
      mediaEnabled: row.mediaEnabled,
      scope,
      config,
      managedKey: isBasicAlarmRuleKey(row.managedKey) ? row.managedKey : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
