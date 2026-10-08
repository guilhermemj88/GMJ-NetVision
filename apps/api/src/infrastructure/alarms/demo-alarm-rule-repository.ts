import { createLocalId } from '@gmj/shared';
import type { MetricAlarmType } from '@gmj/shared';
import type { AlarmRuleInput, AlarmRuleRecord, AlarmRuleRepository } from './alarm-rule-repository';

/**
 * Fallback em memoria (DEMO_MODE / testes). Nao ha polling no demo, mas a API
 * de regras continua disponivel e descartavel.
 */
export class DemoAlarmRuleRepository implements AlarmRuleRepository {
  private readonly rules: AlarmRuleRecord[] = [];

  async list(): Promise<AlarmRuleRecord[]> {
    return [...this.rules];
  }

  async listEnabled(types?: readonly MetricAlarmType[]): Promise<AlarmRuleRecord[]> {
    return this.rules.filter(
      (rule) => rule.enabled && (!types?.length || types.includes(rule.type)),
    );
  }

  async get(id: string): Promise<AlarmRuleRecord | null> {
    return this.rules.find((rule) => rule.id === id) ?? null;
  }

  async create(input: AlarmRuleInput): Promise<AlarmRuleRecord> {
    const now = new Date();
    const record: AlarmRuleRecord = {
      ...input,
      managedKey: input.managedKey ?? null,
      id: createLocalId('alarm-rule'),
      createdAt: now,
      updatedAt: now,
    };
    this.rules.push(record);
    return record;
  }

  async update(id: string, input: AlarmRuleInput): Promise<AlarmRuleRecord | null> {
    const index = this.rules.findIndex((rule) => rule.id === id);
    const current = this.rules[index];
    if (!current) return null;
    const record: AlarmRuleRecord = {
      ...current,
      ...input,
      // Sem `managedKey` no input o slot gerenciado é preservado (F9.6).
      managedKey: input.managedKey === undefined ? current.managedKey : (input.managedKey ?? null),
      updatedAt: new Date(),
    };
    this.rules[index] = record;
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<AlarmRuleRecord | null> {
    const current = this.rules.find((rule) => rule.id === id);
    if (!current) return null;
    current.enabled = enabled;
    current.updatedAt = new Date();
    return current;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    return true;
  }
}
