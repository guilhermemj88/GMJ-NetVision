import {
  alarmInterfaceLabel,
  formatAlarmDownSince,
  type Alarm,
  type AlarmSeverity,
  type AlarmType,
} from '@gmj/shared';
import { PrismaClient } from '../../generated/prisma/index.js';
import type { AlarmOpenInput, AlarmRepository } from './alarm-repository';

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

  async listHistory(limit: number): Promise<Alarm[]> {
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
}
