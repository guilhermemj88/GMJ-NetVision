import type { Alarm, AlarmMetadata, AlarmResolutionReason, AlarmSeverity, MetricAlarmType } from '@gmj/shared';

export interface AlarmOpenInput {
  deviceId: string;
  interfaceId: string;
  ifIndex: number;
  startedAt: Date;
}

/** Entrada de um alarme metrico (errors/discards/CRC) com fingerprint. */
export interface MetricAlarmOpenInput {
  deviceId: string;
  interfaceId: string;
  ifIndex: number;
  ruleId: string;
  type: MetricAlarmType;
  severity: AlarmSeverity;
  /** Parte do fingerprint: RX/TX para errors/discards; FCS para CRC. */
  metricKey: string;
  currentValue: number;
  thresholdValue: number;
  unit: string;
  metadata: AlarmMetadata;
  message: string;
  startedAt: Date;
}

export interface AlarmHistoryOptions {
  /**
   * When true, return only resolved alarms (endedAt is not null), ordered by
   * resolution time, most recent first. Otherwise return every alarm ordered by
   * start time, most recent first.
   */
  resolvedOnly?: boolean;
}

export interface AlarmRepository {
  /** Alarms that are still open (endedAt is null). */
  listActive(): Promise<Alarm[]>;
  /** Alarms ordered by start time, most recent first (see options for resolved). */
  listHistory(limit: number, options?: AlarmHistoryOptions): Promise<Alarm[]>;
  /** Which of the given interfaces belong to at least one map link. */
  findLinkedInterfaceIds(interfaceIds: string[]): Promise<Set<string>>;
  /**
   * Persists one INTERFACE_DOWN/CRITICAL alarm per interface, ignoring any
   * interface that already has an open alarm (no duplicates).
   */
  openInterfaceDownAlarms(inputs: AlarmOpenInput[]): Promise<Alarm[]>;
  /** Closes every open INTERFACE_DOWN alarm for the given interfaces. */
  resolveInterfaceDownAlarms(interfaceIds: string[], resolvedAt: Date): Promise<void>;
  /**
   * Persists one metric alarm per fingerprint (ruleId + interfaceId + type +
   * metricKey), ignoring a fingerprint that already has an open alarm.
   */
  openMetricAlarm(input: MetricAlarmOpenInput): Promise<Alarm | null>;
  /** Open metric alarms of one device (dedupe/escalation state). */
  listOpenMetricAlarms(deviceId: string): Promise<Alarm[]>;
  /** Closes the open metric alarm of one fingerprint, when it exists. */
  resolveMetricAlarm(
    interfaceId: string,
    type: MetricAlarmType,
    metricKey: string,
    resolvedAt: Date,
  ): Promise<boolean>;
  /** Closes every open metric alarm of a rule (disable/delete), preserving history. */
  resolveOpenMetricAlarmsForRule(
    ruleId: string,
    resolvedAt: Date,
    reason: AlarmResolutionReason,
  ): Promise<number>;
}
