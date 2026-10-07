import { createLocalId, type Alarm, type AlarmResolutionReason, type MetricAlarmType } from '@gmj/shared';
import type {
  AlarmHistoryOptions,
  AlarmOpenInput,
  AlarmRepository,
  MetricAlarmEscalationInput,
  MetricAlarmOpenInput,
} from './alarm-repository';
import { isMetricAlarmType } from './alarm-rule-schema';

/**
 * In-memory fallback used in DEMO_MODE. Alarm detection does not run there
 * (no SNMP polling), so this mostly serves the /api/alarms endpoints.
 */
export class DemoAlarmRepository implements AlarmRepository {
  private alarms: Alarm[] = [];

  async listActive(): Promise<Alarm[]> {
    return this.alarms.filter((alarm) => !alarm.endedAt);
  }

  async listHistory(limit: number, options?: AlarmHistoryOptions): Promise<Alarm[]> {
    if (options?.resolvedOnly) {
      return this.alarms
        .filter((alarm) => alarm.endedAt)
        .sort(
          (a, b) =>
            new Date(b.endedAt as string).getTime() - new Date(a.endedAt as string).getTime(),
        )
        .slice(0, limit);
    }
    return this.alarms.slice(0, limit);
  }

  async findLinkedInterfaceIds(interfaceIds: string[]): Promise<Set<string>> {
    return new Set(interfaceIds);
  }

  async openInterfaceDownAlarms(inputs: AlarmOpenInput[]): Promise<Alarm[]> {
    const created: Alarm[] = [];
    for (const input of inputs) {
      if (this.alarms.some((alarm) => alarm.interfaceId === input.interfaceId && !alarm.endedAt)) {
        continue;
      }
      const alarm: Alarm = {
        id: createLocalId('alarm'),
        deviceId: input.deviceId,
        deviceName: input.deviceId,
        interfaceId: input.interfaceId,
        interfaceName: `ifIndex ${input.ifIndex}`,
        interfaceLabel: `ifIndex ${input.ifIndex}`,
        ifIndex: input.ifIndex,
        linkId: null,
        linkLabel: null,
        type: 'INTERFACE_DOWN',
        severity: 'CRITICAL',
        startedAt: input.startedAt.toISOString(),
        endedAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        message: `Interface ifIndex ${input.ifIndex} DOWN`,
      };
      this.alarms.unshift(alarm);
      created.push(alarm);
    }
    return created;
  }

  async resolveInterfaceDownAlarms(interfaceIds: string[], resolvedAt: Date): Promise<void> {
    for (const alarm of this.alarms) {
      if (!alarm.endedAt && interfaceIds.includes(alarm.interfaceId)) {
        alarm.endedAt = resolvedAt.toISOString();
      }
    }
  }

  async openMetricAlarm(input: MetricAlarmOpenInput): Promise<Alarm | null> {
    const exists = this.alarms.some(
      (alarm) =>
        !alarm.endedAt &&
        alarm.ruleId === input.ruleId &&
        alarm.interfaceId === input.interfaceId &&
        alarm.type === input.type &&
        alarm.metricKey === input.metricKey,
    );
    if (exists) return null;

    const alarm: Alarm = {
      id: createLocalId('alarm'),
      deviceId: input.deviceId,
      deviceName: input.deviceId,
      interfaceId: input.interfaceId,
      interfaceName: `ifIndex ${input.ifIndex}`,
      interfaceLabel: `ifIndex ${input.ifIndex}`,
      ifIndex: input.ifIndex,
      linkId: null,
      linkLabel: null,
      type: input.type,
      severity: input.severity,
      startedAt: input.startedAt.toISOString(),
      endedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      message: input.message,
      ruleId: input.ruleId,
      metricKey: input.metricKey,
      currentValue: input.currentValue,
      thresholdValue: input.thresholdValue,
      unit: input.unit,
      metadata: input.metadata,
    };
    this.alarms.unshift(alarm);
    return alarm;
  }

  async listOpenMetricAlarms(deviceId: string): Promise<Alarm[]> {
    return this.alarms.filter(
      (alarm) => !alarm.endedAt && alarm.deviceId === deviceId && isMetricAlarmType(alarm.type),
    );
  }

  async escalateMetricAlarm(
    alarmId: string,
    input: MetricAlarmEscalationInput,
  ): Promise<Alarm | null> {
    const alarm = this.alarms.find((item) => item.id === alarmId && !item.endedAt);
    if (!alarm) return null;
    alarm.severity = input.severity;
    alarm.currentValue = input.currentValue;
    alarm.thresholdValue = input.thresholdValue;
    alarm.unit = input.unit;
    alarm.metadata = input.metadata;
    alarm.message = input.message;
    return alarm;
  }

  async resolveMetricAlarm(
    interfaceId: string,
    type: MetricAlarmType,
    metricKey: string,
    resolvedAt: Date,
  ): Promise<boolean> {
    let resolved = false;
    for (const alarm of this.alarms) {
      if (
        !alarm.endedAt &&
        alarm.interfaceId === interfaceId &&
        alarm.type === type &&
        alarm.metricKey === metricKey
      ) {
        alarm.endedAt = resolvedAt.toISOString();
        resolved = true;
      }
    }
    return resolved;
  }

  async resolveOpenMetricAlarmsForRule(
    ruleId: string,
    resolvedAt: Date,
    reason: AlarmResolutionReason,
  ): Promise<number> {
    let resolved = 0;
    for (const alarm of this.alarms) {
      if (!alarm.endedAt && alarm.ruleId === ruleId) {
        alarm.endedAt = resolvedAt.toISOString();
        alarm.metadata = { ...(alarm.metadata ?? {}), resolutionReason: reason };
        resolved += 1;
      }
    }
    return resolved;
  }
}
