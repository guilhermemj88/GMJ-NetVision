import { PrismaClient, type Prisma } from '../../generated/prisma/index.js';
import type {
  MediaDeliveryLogFilter,
  MediaDeliveryLogInput,
  MediaDeliveryLogRecord,
  MediaDeliveryDirection,
  MediaDeliveryStatus,
  MediaInboundPatch,
  MediaIntegrationCreateInput,
  MediaIntegrationPurpose,
  MediaIntegrationRecord,
  MediaIntegrationRepository,
  MediaIntegrationType,
  MediaIntegrationUpdateInput,
  MediaOutboundPatch,
} from './media-types';

/** Persistencia real da camada de midias (Postgres). */
export class PrismaMediaRepository implements MediaIntegrationRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async list(): Promise<MediaIntegrationRecord[]> {
    const rows = await this.prisma.mediaIntegration.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(mapIntegration);
  }

  async get(id: string): Promise<MediaIntegrationRecord | null> {
    const row = await this.prisma.mediaIntegration.findUnique({ where: { id } });
    return row ? mapIntegration(row) : null;
  }

  async findByPurpose(purpose: MediaIntegrationPurpose): Promise<MediaIntegrationRecord | null> {
    const row = await this.prisma.mediaIntegration.findFirst({
      where: { purpose },
      orderBy: { createdAt: 'asc' },
    });
    return row ? mapIntegration(row) : null;
  }

  async create(input: MediaIntegrationCreateInput): Promise<MediaIntegrationRecord> {
    const row = await this.prisma.mediaIntegration.create({
      data: {
        name: input.name,
        type: input.type,
        purpose: input.purpose,
        enabled: input.enabled,
        outboundUrl: input.outboundUrl,
        outboundSecretEncrypted: toBytes(input.outboundSecretEncrypted),
        inboundEnabled: input.inboundEnabled,
        inboundSecretEncrypted: toBytes(input.inboundSecretEncrypted),
      },
    });
    return mapIntegration(row);
  }

  async update(id: string, input: MediaIntegrationUpdateInput): Promise<MediaIntegrationRecord> {
    const data: Prisma.MediaIntegrationUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.outboundUrl === undefined ? {} : { outboundUrl: input.outboundUrl }),
      ...(input.inboundEnabled === undefined ? {} : { inboundEnabled: input.inboundEnabled }),
      ...(input.outboundSecretEncrypted === undefined
        ? {}
        : { outboundSecretEncrypted: toBytes(input.outboundSecretEncrypted) }),
      ...(input.inboundSecretEncrypted === undefined
        ? {}
        : { inboundSecretEncrypted: toBytes(input.inboundSecretEncrypted) }),
    };
    const row = await this.prisma.mediaIntegration.update({ where: { id }, data });
    return mapIntegration(row);
  }

  async recordOutbound(id: string, patch: MediaOutboundPatch): Promise<void> {
    await this.prisma.mediaIntegration.update({ where: { id }, data: patch });
  }

  async recordInbound(id: string, patch: MediaInboundPatch): Promise<void> {
    await this.prisma.mediaIntegration.update({ where: { id }, data: patch });
  }

  async createLog(input: MediaDeliveryLogInput): Promise<MediaDeliveryLogRecord> {
    const row = await this.prisma.mediaDeliveryLog.create({
      data: {
        mediaIntegrationId: input.mediaIntegrationId,
        direction: input.direction,
        event: input.event,
        action: input.action,
        profileId: input.profileId,
        requestId: input.requestId,
        status: input.status,
        httpStatus: input.httpStatus,
        latencyMs: input.latencyMs,
        idempotent: input.idempotent,
        safeError: input.safeError,
        destination: input.destination,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
    return mapLog(row);
  }

  async listLogs(filter: MediaDeliveryLogFilter = {}): Promise<MediaDeliveryLogRecord[]> {
    const rows = await this.prisma.mediaDeliveryLog.findMany({
      where: {
        ...(filter.mediaIntegrationId ? { mediaIntegrationId: filter.mediaIntegrationId } : {}),
        ...(filter.direction ? { direction: filter.direction } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit ?? 50,
    });
    return rows.map(mapLog);
  }

  async trimLogs(keep: number): Promise<number> {
    const stale = await this.prisma.mediaDeliveryLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip: keep,
      select: { id: true },
    });
    if (stale.length === 0) return 0;
    const result = await this.prisma.mediaDeliveryLog.deleteMany({
      where: { id: { in: stale.map((row) => row.id) } },
    });
    return result.count;
  }

  async delete(id: string): Promise<void> {
    await this.prisma.mediaIntegration.delete({ where: { id } });
  }
}

type IntegrationRow = {
  id: string;
  name: string;
  type: string;
  purpose: string;
  enabled: boolean;
  outboundUrl: string | null;
  outboundSecretEncrypted: Uint8Array | null;
  inboundEnabled: boolean;
  inboundSecretEncrypted: Uint8Array | null;
  createdAt: Date;
  updatedAt: Date;
  lastOutboundAttemptAt: Date | null;
  lastOutboundSuccessAt: Date | null;
  lastOutboundFailureAt: Date | null;
  lastOutboundStatusCode: number | null;
  lastOutboundLatencyMs: number | null;
  lastOutboundEvent: string | null;
  lastOutboundErrorSafe: string | null;
  lastInboundAt: Date | null;
  lastInboundAction: string | null;
  lastInboundStatus: string | null;
  lastInboundRequestId: string | null;
  lastInboundErrorSafe: string | null;
};

type LogRow = {
  id: string;
  mediaIntegrationId: string | null;
  direction: string;
  event: string | null;
  action: string | null;
  profileId: string | null;
  requestId: string | null;
  status: string;
  httpStatus: number | null;
  latencyMs: number | null;
  idempotent: boolean | null;
  safeError: string | null;
  destination: string | null;
  createdAt: Date;
};

function toBytes(value: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
  if (!value) return null;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function mapIntegration(row: IntegrationRow): MediaIntegrationRecord {
  return {
    ...row,
    type: row.type as MediaIntegrationType,
    purpose: row.purpose as MediaIntegrationPurpose,
    outboundSecretEncrypted: toBytes(row.outboundSecretEncrypted),
    inboundSecretEncrypted: toBytes(row.inboundSecretEncrypted),
  };
}

function mapLog(row: LogRow): MediaDeliveryLogRecord {
  return {
    ...row,
    direction: row.direction as MediaDeliveryDirection,
    status: row.status as MediaDeliveryStatus,
  };
}
