import type { AlarmRuleConfig, AlarmRuleScope, AlarmSeverity, BasicAlarmRuleKey, MetricAlarmType } from '@gmj/shared';

/** Regra de alarme no dominio (scope/config ja validados por Zod). */
export interface AlarmRuleRecord {
  id: string;
  name: string;
  type: MetricAlarmType;
  enabled: boolean;
  severity: AlarmSeverity;
  mapLinkedOnly: boolean;
  mediaEnabled: boolean;
  scope: AlarmRuleScope;
  config: AlarmRuleConfig;
  /** Slot da aba BASICO (F9.6); `null` = regra custom. */
  managedKey: BasicAlarmRuleKey | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlarmRuleInput {
  name: string;
  type: MetricAlarmType;
  enabled: boolean;
  severity: AlarmSeverity;
  mapLinkedOnly: boolean;
  mediaEnabled: boolean;
  scope: AlarmRuleScope;
  config: AlarmRuleConfig;
  /**
   * Presente apenas quando a criação/edição quer mexer no slot gerenciado.
   * `undefined` no update PRESERVA o valor atual (o Avançado nunca apaga o
   * vínculo por acidente).
   */
  managedKey?: BasicAlarmRuleKey | null | undefined;
}

export interface AlarmRuleRepository {
  list(): Promise<AlarmRuleRecord[]>;
  /** Regras habilitadas (opcionalmente filtradas por tipo), para o motor. */
  listEnabled(types?: readonly MetricAlarmType[]): Promise<AlarmRuleRecord[]>;
  get(id: string): Promise<AlarmRuleRecord | null>;
  create(input: AlarmRuleInput): Promise<AlarmRuleRecord>;
  update(id: string, input: AlarmRuleInput): Promise<AlarmRuleRecord | null>;
  setEnabled(id: string, enabled: boolean): Promise<AlarmRuleRecord | null>;
  remove(id: string): Promise<boolean>;
}
