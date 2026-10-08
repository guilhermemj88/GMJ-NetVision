import { alarmInterfaceLabel, type OperationalOccurrenceCloseReason } from '@gmj/shared';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type {
  OperationalOccurrenceApplyInput,
  OperationalOccurrenceApplyResult,
  OperationalOccurrenceAcknowledgeInput,
  OperationalOccurrenceListFilter,
  OperationalOccurrenceListResult,
  OperationalOccurrenceRecord,
  OperationalOccurrenceRepository,
  OperationalOccurrenceValues,
} from './operational-occurrence-repository';

type OccurrenceRow = Prisma.OperationalOccurrenceGetPayload<{
  include: { device: true; interface: true };
}>;

function toRecord(row: OccurrenceRow): OperationalOccurrenceRecord {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    type: row.type,
    deviceId: row.deviceId,
    deviceName: row.device.displayName || row.device.name,
    interfaceId: row.interfaceId,
    interfaceName: row.interface.name,
    interfaceLabel: alarmInterfaceLabel(
      row.interface.alias,
      row.interface.description,
      row.interface.name,
      row.interface.ifIndex,
    ),
    ifIndex: row.interface.ifIndex,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastSampleAt: row.lastSampleAt,
    occurrenceCount: row.occurrenceCount,
    crcDeltaTotal: row.crcDeltaTotal,
    rxDiscardDeltaTotal: row.rxDiscardDeltaTotal,
    txDiscardDeltaTotal: row.txDiscardDeltaTotal,
    currentRatePerMin: row.currentRatePerMin,
    peakRatePerMin: row.peakRatePerMin,
    acknowledgedAt: row.acknowledgedAt ?? null,
    acknowledgedBy: row.acknowledgedBy ?? null,
    closedAt: row.closedAt ?? null,
    closeReason: (row.closeReason as OperationalOccurrenceCloseReason | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWriteData(values: OperationalOccurrenceValues) {
  return {
    firstSeenAt: new Date(values.firstSeenAtMs),
    lastSeenAt: new Date(values.lastSeenAtMs),
    lastSampleAt: new Date(values.lastSampleAtMs),
    occurrenceCount: values.occurrenceCount,
    crcDeltaTotal: values.crcDeltaTotal,
    rxDiscardDeltaTotal: values.rxDiscardDeltaTotal,
    txDiscardDeltaTotal: values.txDiscardDeltaTotal,
    currentRatePerMin: values.currentRatePerMin,
    peakRatePerMin: values.peakRatePerMin,
  };
}

export class PrismaOperationalOccurrenceRepository implements OperationalOccurrenceRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /**
   * A transacao garante a idempotencia da F9.2: a associacao da amostra entra
   * na MESMA transacao do episodio. Replay (chave unica violada ou linha ja
   * existente) desfaz tudo, inclusive os totais — nunca soma o delta duas vezes.
   */
  async apply(input: OperationalOccurrenceApplyInput): Promise<OperationalOccurrenceApplyResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await tx.operationalOccurrenceSource.findUnique({
          where: {
            interfaceId_sourceTimestamp_type: {
              interfaceId: input.interfaceId,
              sourceTimestamp: input.sourceTimestamp,
              type: input.type,
            },
          },
          select: { id: true },
        });
        if (replay) return { applied: false, record: null };

        let row: OccurrenceRow;
        if (input.action === 'UPDATE' && input.targetId) {
          row = await tx.operationalOccurrence.update({
            where: { id: input.targetId },
            data: toWriteData(input.values),
            include: { device: true, interface: true },
          });
        } else {
          if (input.close) {
            await tx.operationalOccurrence.updateMany({
              where: { id: input.close.id, closedAt: null },
              data: { closedAt: new Date(input.close.closedAtMs), closeReason: input.close.reason },
            });
          }
          row = await tx.operationalOccurrence.create({
            data: {
              fingerprint: input.fingerprint,
              type: input.type,
              deviceId: input.deviceId,
              interfaceId: input.interfaceId,
              ...toWriteData(input.values),
            },
            include: { device: true, interface: true },
          });
        }

        await tx.operationalOccurrenceSource.create({
          data: {
            occurrenceId: row.id,
            interfaceId: input.interfaceId,
            type: input.type,
            sourceTimestamp: input.sourceTimestamp,
          },
        });
        return { applied: true, record: toRecord(row) };
      });
    } catch (error) {
      // Corrida entre dois polls da mesma amostra: o segundo nao aplica nada.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { applied: false, record: null };
      }
      throw error;
    }
  }

  async findById(id: string): Promise<OperationalOccurrenceRecord | null> {
    const row = await this.prisma.operationalOccurrence.findUnique({
      where: { id },
      include: { device: true, interface: true },
    });
    return row ? toRecord(row) : null;
  }

  async findLatestByFingerprint(fingerprint: string): Promise<OperationalOccurrenceRecord | null> {
    const row = await this.prisma.operationalOccurrence.findFirst({
      where: { fingerprint },
      orderBy: [{ lastSampleAt: 'desc' }, { createdAt: 'desc' }],
      include: { device: true, interface: true },
    });
    return row ? toRecord(row) : null;
  }

  async list(filter: OperationalOccurrenceListFilter): Promise<OperationalOccurrenceListResult> {
    const where: Prisma.OperationalOccurrenceWhereInput = {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
      ...(filter.interfaceId ? { interfaceId: filter.interfaceId } : {}),
      ...(filter.unacknowledged ? { acknowledgedAt: null } : {}),
      ...(filter.from || filter.to
        ? {
            lastSeenAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
      ...(filter.active
        ? { closedAt: null, acknowledgedAt: null, lastSeenAt: { gte: new Date(filter.now.getTime() - filter.quietMs) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.operationalOccurrence.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        skip: filter.offset,
        take: filter.limit,
        include: { device: true, interface: true },
      }),
      this.prisma.operationalOccurrence.count({ where }),
    ]);
    return { items: rows.map(toRecord), total };
  }

  async acknowledge(
    id: string,
    input: OperationalOccurrenceAcknowledgeInput,
  ): Promise<OperationalOccurrenceRecord | null> {
    // Idempotente: o primeiro operador fica registrado; o encerramento so ocorre
    // se o episodio ainda estiver aberto (um episodio expirado por 24h mantem o
    // motivo real do fim).
    await this.prisma.operationalOccurrence.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedAt: input.acknowledgedAt, acknowledgedBy: input.acknowledgedBy },
    });
    await this.prisma.operationalOccurrence.updateMany({
      where: { id, closedAt: null },
      data: { closedAt: input.acknowledgedAt, closeReason: input.closeReason },
    });
    return this.findById(id);
  }

  async closeQuiet(input: {
    now: Date;
    before: Date;
    quietMs: number;
    limit?: number;
  }): Promise<number> {
    const candidates = await this.prisma.operationalOccurrence.findMany({
      where: { closedAt: null, lastSeenAt: { lt: input.before } },
      orderBy: { lastSeenAt: 'asc' },
      take: input.limit ?? 500,
      select: { id: true, lastSeenAt: true },
    });
    let closed = 0;
    for (const row of candidates) {
      const updated = await this.prisma.operationalOccurrence.updateMany({
        where: { id: row.id, closedAt: null },
        data: {
          closedAt: new Date(row.lastSeenAt.getTime() + input.quietMs),
          closeReason: 'QUIET_24H',
        },
      });
      closed += updated.count;
    }
    return closed;
  }
}
