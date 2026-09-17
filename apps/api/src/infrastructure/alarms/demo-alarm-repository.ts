import { createLocalId, type Alarm } from '@gmj/shared';
import type { AlarmHistoryOptions, AlarmOpenInput, AlarmRepository } from './alarm-repository';

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
}
