import { randomUUID } from 'node:crypto';
import type {
  MediaDeliveryLogFilter,
  MediaDeliveryLogInput,
  MediaDeliveryLogRecord,
  MediaInboundPatch,
  MediaIntegrationCreateInput,
  MediaIntegrationPurpose,
  MediaIntegrationRecord,
  MediaIntegrationRepository,
  MediaIntegrationUpdateInput,
  MediaOutboundPatch,
} from './media-types';

/**
 * Espelho em memoria da camada de midias.
 *
 * Usado em DEMO_MODE/testes e como fallback enquanto a migration da Fase 9 nao
 * esta aplicada: a tela de MIDIAS continua funcionando (cadastro, teste,
 * rotacao e logs) sem tocar no schema do Postgres.
 */
export class InMemoryMediaRepository implements MediaIntegrationRepository {
  private readonly integrations = new Map<string, MediaIntegrationRecord>();
  private readonly logs: MediaDeliveryLogRecord[] = [];

  async list(): Promise<MediaIntegrationRecord[]> {
    return [...this.integrations.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async get(id: string): Promise<MediaIntegrationRecord | null> {
    return this.integrations.get(id) ?? null;
  }

  async findByPurpose(purpose: MediaIntegrationPurpose): Promise<MediaIntegrationRecord | null> {
    return [...this.integrations.values()].find((item) => item.purpose === purpose) ?? null;
  }

  async create(input: MediaIntegrationCreateInput): Promise<MediaIntegrationRecord> {
    const existing = await this.findByPurpose(input.purpose);
    if (existing) {
      return this.update(existing.id, {
        name: input.name,
        enabled: input.enabled,
        outboundUrl: input.outboundUrl,
        inboundEnabled: input.inboundEnabled,
        outboundSecretEncrypted: input.outboundSecretEncrypted,
        inboundSecretEncrypted: input.inboundSecretEncrypted,
      });
    }
    const now = new Date();
    const record: MediaIntegrationRecord = {
      id: `media_${randomUUID()}`,
      ...input,
      createdAt: now,
      updatedAt: now,
      lastOutboundAttemptAt: null,
      lastOutboundSuccessAt: null,
      lastOutboundFailureAt: null,
      lastOutboundStatusCode: null,
      lastOutboundLatencyMs: null,
      lastOutboundEvent: null,
      lastOutboundErrorSafe: null,
      lastInboundAt: null,
      lastInboundAction: null,
      lastInboundStatus: null,
      lastInboundRequestId: null,
      lastInboundErrorSafe: null,
    };
    this.integrations.set(record.id, record);
    return record;
  }

  async update(id: string, input: MediaIntegrationUpdateInput): Promise<MediaIntegrationRecord> {
    const current = this.integrations.get(id);
    if (!current) throw new Error('Integração de mídia não encontrada');
    const next: MediaIntegrationRecord = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.outboundUrl === undefined ? {} : { outboundUrl: input.outboundUrl }),
      ...(input.inboundEnabled === undefined ? {} : { inboundEnabled: input.inboundEnabled }),
      ...(input.outboundSecretEncrypted === undefined
        ? {}
        : { outboundSecretEncrypted: input.outboundSecretEncrypted }),
      ...(input.inboundSecretEncrypted === undefined
        ? {}
        : { inboundSecretEncrypted: input.inboundSecretEncrypted }),
      updatedAt: new Date(),
    };
    this.integrations.set(id, next);
    return next;
  }

  async recordOutbound(id: string, patch: MediaOutboundPatch): Promise<void> {
    const current = this.integrations.get(id);
    if (!current) return;
    this.integrations.set(id, {
      ...current,
      ...(patch.lastOutboundAttemptAt === undefined
        ? {}
        : { lastOutboundAttemptAt: patch.lastOutboundAttemptAt }),
      ...(patch.lastOutboundSuccessAt === undefined
        ? {}
        : { lastOutboundSuccessAt: patch.lastOutboundSuccessAt }),
      ...(patch.lastOutboundFailureAt === undefined
        ? {}
        : { lastOutboundFailureAt: patch.lastOutboundFailureAt }),
      ...(patch.lastOutboundStatusCode === undefined
        ? {}
        : { lastOutboundStatusCode: patch.lastOutboundStatusCode }),
      ...(patch.lastOutboundLatencyMs === undefined
        ? {}
        : { lastOutboundLatencyMs: patch.lastOutboundLatencyMs }),
      ...(patch.lastOutboundEvent === undefined
        ? {}
        : { lastOutboundEvent: patch.lastOutboundEvent }),
      ...(patch.lastOutboundErrorSafe === undefined
        ? {}
        : { lastOutboundErrorSafe: patch.lastOutboundErrorSafe }),
    });
  }

  async recordInbound(id: string, patch: MediaInboundPatch): Promise<void> {
    const current = this.integrations.get(id);
    if (!current) return;
    this.integrations.set(id, {
      ...current,
      ...(patch.lastInboundAt === undefined ? {} : { lastInboundAt: patch.lastInboundAt }),
      ...(patch.lastInboundAction === undefined ? {} : { lastInboundAction: patch.lastInboundAction }),
      ...(patch.lastInboundStatus === undefined ? {} : { lastInboundStatus: patch.lastInboundStatus }),
      ...(patch.lastInboundRequestId === undefined
        ? {}
        : { lastInboundRequestId: patch.lastInboundRequestId }),
      ...(patch.lastInboundErrorSafe === undefined
        ? {}
        : { lastInboundErrorSafe: patch.lastInboundErrorSafe }),
    });
  }

  async createLog(input: MediaDeliveryLogInput): Promise<MediaDeliveryLogRecord> {
    const record: MediaDeliveryLogRecord = {
      ...input,
      id: `medialog_${randomUUID()}`,
      createdAt: input.createdAt ?? new Date(),
    };
    this.logs.push(record);
    return record;
  }

  async listLogs(filter: MediaDeliveryLogFilter = {}): Promise<MediaDeliveryLogRecord[]> {
    const limit = filter.limit ?? 50;
    return this.logs
      .filter((log) => (filter.mediaIntegrationId ? log.mediaIntegrationId === filter.mediaIntegrationId : true))
      .filter((log) => (filter.direction ? log.direction === filter.direction : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async trimLogs(keep: number): Promise<number> {
    if (this.logs.length <= keep) return 0;
    const ordered = [...this.logs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const drop = new Set(ordered.slice(keep).map((log) => log.id));
    const before = this.logs.length;
    for (let index = this.logs.length - 1; index >= 0; index -= 1) {
      const log = this.logs[index];
      if (log && drop.has(log.id)) this.logs.splice(index, 1);
    }
    return before - this.logs.length;
  }

  async delete(id: string): Promise<void> {
    this.integrations.delete(id);
    for (let index = this.logs.length - 1; index >= 0; index -= 1) {
      if (this.logs[index]?.mediaIntegrationId === id) this.logs.splice(index, 1);
    }
  }
}
