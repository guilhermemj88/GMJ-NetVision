import {
  alarmInterfaceLabel,
  formatAlarmDownSince,
  METRIC_ALARM_TYPES,
  type Alarm,
  type AlarmMetadata,
  type AlarmSeverity,
  type AlarmType,
  type MetricAlarmType,
} from '@gmj/shared';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type {
  AlarmHistoryOptions,
  AlarmOpenInput,
  AlarmRepository,
  MetricAlarmOpenInput,
} from './alarm-repository';

const alarmInclude = {
  device: { select: { id: true, name: true, displayName: true } },
  interface: { select: { id: true, name: true, alias: true, description: true, ifIndex: true } },
  link: { select: { id: true, label: true } },
} as const;

type AlarmRow = Awaited<ReturnType<PrismaClient['alarm']['findMany']>>[number] & {
  device: { id: string; name: string; displayName: string };
  interface: {
    id: string;
    name: string;
    alias: string | null;
    description: string | null;
    ifIndex: number;
  };
  link: { id: string; label: string | null } | null;
};

function toAlarm(row: AlarmRow): Alarm {
  const interfaceLabel = alarmInterfaceLabel(
    row.interface.alias,
    row.interface.description,
    row.interface.name,
    row.interface.ifIndex,
  );
  return {
    id: row.id,
    deviceId: row.device.id,
    deviceName: row.device.displayName || row.device.name,
    interfaceId: row.interface.id,
    interfaceName: row.interface.name,
    interfaceLabel,
    ifIndex: row.interface.ifIndex,
    linkId: row.link?.id ?? null,
    linkLabel: row.link?.label ?? null,
    type: row.type as AlarmType,
    severity: row.severity as AlarmSeverity,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.acknowledgedBy,
    message: row.message,
    ruleId: row.ruleId ?? null,
    metricKey: row.metricKey ?? null,
    currentValue: row.currentValue ?? null,
    thresholdValue: row.thresholdValue ?? null,
    unit: row.unit ?? null,
    metadata: (row.metadata as unknown as AlarmMetadata | null) ?? null,
  };
}

function alarmMessage(
  deviceName: string,
  interfaceLabel: string,
  interfaceName: string,
  startedAt: Date,
): string {
  return `${deviceName}: ${interfaceLabel} (${interfaceName}) DOWN desde ${formatAlarmDownSince(startedAt.toISOString())}`;
}

export class PrismaAlarmRepository implements AlarmRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async listActive(): Promise<Alarm[]> {
    const rows = await this.prisma.alarm.findMany({
      where: { endedAt: null },
      include: alarmInclude,
      orderBy: { startedAt: 'desc' },
    });
    return rows.map(toAlarm);
  }

  async listHistory(limit: number, options?: AlarmHistoryOptions): Promise<Alarm[]> {
    if (options?.resolvedOnly) {
      const rows = await this.prisma.alarm.findMany({
        where: { endedAt: { not: null } },
        include: alarmInclude,
        orderBy: { endedAt: 'desc' },
        take: limit,
      });
      return rows.map(toAlarm);
    }

    const rows = await this.prisma.alarm.findMany({
      include: alarmInclude,
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows.map(toAlarm);
  }

  async findLinkedInterfaceIds(interfaceIds: string[]): Promise<Set<string>> {
    if (!interfaceIds.length) return new Set();
    const links = await this.prisma.link.findMany({
      where: {
        OR: [
          { sourceInterfaceId: { in: interfaceIds } },
          { targetInterfaceId: { in: interfaceIds } },
        ],
      },
      select: { sourceInterfaceId: true, targetInterfaceId: true },
    });
    const linked = new Set<string>();
    for (const link of links) {
      if (link.sourceInterfaceId) linked.add(link.sourceInterfaceId);
      if (link.targetInterfaceId) linked.add(link.targetInterfaceId);
    }
    return linked;
  }

  async openInterfaceDownAlarms(inputs: AlarmOpenInput[]): Promise<Alarm[]> {
    const created: Alarm[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const input of inputs) {
        const existing = await tx.alarm.findFirst({
          where: { interfaceId: input.interfaceId, type: 'INTERFACE_DOWN', endedAt: null },
        });
        if (existing) continue;

        const networkInterface = await tx.interface.findUnique({
          where: { id: input.interfaceId },
          include: { device: { select: { id: true, name: true, displayName: true } } },
        });
        if (!networkInterface) continue;

        // Only interfaces that are actually part of a map link open alarms.
        const link = await tx.link.findFirst({
          where: {
            OR: [
              { sourceInterfaceId: input.interfaceId },
              { targetInterfaceId: input.interfaceId },
            ],
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, label: true },
        });
        if (!link) continue;

        const deviceName = networkInterface.device.displayName || networkInterface.device.name;
        const interfaceLabel = alarmInterfaceLabel(
          networkInterface.alias,
          networkInterface.description,
          networkInterface.name,
          networkInterface.ifIndex,
        );
        const row = await tx.alarm.create({
          data: {
            deviceId: input.deviceId,
            interfaceId: input.interfaceId,
            linkId: link.id,
            type: 'INTERFACE_DOWN',
            severity: 'CRITICAL',
            startedAt: input.startedAt,
            message: alarmMessage(deviceName, interfaceLabel, networkInterface.name, input.startedAt),
          },
          include: alarmInclude,
        });
        created.push(toAlarm(row as AlarmRow));
      }
    });
    return created;
  }

  async resolveInterfaceDownAlarms(interfaceIds: string[], resolvedAt: Date): Promise<void> {
    if (!interfaceIds.length) return;
    await this.prisma.alarm.updateMany({
      where: { interfaceId: { in: interfaceIds }, type: 'INTERFACE_DOWN', endedAt: null },
      data: { endedAt: resolvedAt },
    });
  }

  async openMetricAlarm(input: MetricAlarmOpenInput): Promise<Alarm | null> {
    let created: Alarm | null = null;
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.alarm.findFirst({
        where: {
          ruleId: input.ruleId,
          interfaceId: input.interfaceId,
          type: input.type,
          metricKey: input.metricKey,
          endedAt: null,
        },
      });
      if (existing) return;

      const networkInterface = await tx.interface.findUnique({
        where: { id: input.interfaceId },
        select: { id: true },
      });
      if (!networkInterface) return;

      // Link e opcional no alarme metrico: serve apenas para o foco no mapa.
      const link = await tx.link.findFirst({
        where: {
          OR: [
            { sourceInterfaceId: input.interfaceId },
            { targetInterfaceId: input.interfaceId },
          ],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      const row = await tx.alarm.create({
        data: {
          deviceId: input.deviceId,
          interfaceId: input.interfaceId,
          linkId: link?.id ?? null,
          type: input.type,
          severity: input.severity,
          startedAt: input.startedAt,
          message: input.message,
          ruleId: input.ruleId,
          metricKey: input.metricKey,
          currentValue: input.currentValue,
          thresholdValue: input.thresholdValue,
          unit: input.unit,
          metadata: input.metadata as unknown as Prisma.InputJsonValue,
        },
        include: alarmInclude,
      });
      created = toAlarm(row as AlarmRow);
    });
    return created;
  }

  async listOpenMetricAlarms(deviceId: string): Promise<Alarm[]> {
    const rows = await this.prisma.alarm.findMany({
      where: { deviceId, endedAt: null, type: { in: [...METRIC_ALARM_TYPES] } },
      include: alarmInclude,
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((row) => toAlarm(row as AlarmRow));
  }

  async resolveMetricAlarm(
    interfaceId: string,
    type: MetricAlarmType,
    metricKey: string,
    resolvedAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.alarm.updateMany({
      where: { interfaceId, type, metricKey, endedAt: null },
      data: { endedAt: resolvedAt },
    });
    return result.count > 0;
  }

  async resolveOpenMetricAlarmsForRule(ruleId: string, resolvedAt: Date): Promise<number> {
    const result = await this.prisma.alarm.updateMany({
      where: { ruleId, endedAt: null, type: { in: [...METRIC_ALARM_TYPES] } },
      data: { endedAt: resolvedAt },
    });
    return result.count;
  }
}
