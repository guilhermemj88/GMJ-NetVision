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
 * Escolhe o destino da camada de midias em tempo de chamada:
 *   - schema da Fase 9 aplicado -> Postgres
 *   - schema ausente            -> espelho em memoria do processo
 *
 * Diferente da mitigacao, aqui CADA METODO decide sozinho: uma leitura que
 * falha no primario nao pode deixar o cadastro de midia indisponivel.
 */
export class RoutingMediaRepository implements MediaIntegrationRepository {
  constructor(
    private readonly primary: MediaIntegrationRepository,
    private readonly fallback: MediaIntegrationRepository,
    private readonly usePrimary: () => Promise<boolean>,
  ) {}

  private async target(): Promise<MediaIntegrationRepository> {
    try {
      return (await this.usePrimary()) ? this.primary : this.fallback;
    } catch {
      return this.fallback;
    }
  }

  async list(): Promise<MediaIntegrationRecord[]> {
    const target = await this.target();
    try {
      return await target.list();
    } catch {
      return this.fallback.list();
    }
  }

  async get(id: string): Promise<MediaIntegrationRecord | null> {
    const target = await this.target();
    try {
      return await target.get(id);
    } catch {
      return this.fallback.get(id);
    }
  }

  async findByPurpose(purpose: MediaIntegrationPurpose): Promise<MediaIntegrationRecord | null> {
    const target = await this.target();
    try {
      return await target.findByPurpose(purpose);
    } catch {
      return this.fallback.findByPurpose(purpose);
    }
  }

  async create(input: MediaIntegrationCreateInput): Promise<MediaIntegrationRecord> {
    const target = await this.target();
    try {
      return await target.create(input);
    } catch {
      return this.fallback.create(input);
    }
  }

  async update(id: string, input: MediaIntegrationUpdateInput): Promise<MediaIntegrationRecord> {
    const target = await this.target();
    try {
      return await target.update(id, input);
    } catch {
      return this.fallback.update(id, input);
    }
  }

  async recordOutbound(id: string, patch: MediaOutboundPatch): Promise<void> {
    const target = await this.target();
    try {
      await target.recordOutbound(id, patch);
    } catch {
      await this.fallback.recordOutbound(id, patch);
    }
  }

  async recordInbound(id: string, patch: MediaInboundPatch): Promise<void> {
    const target = await this.target();
    try {
      await target.recordInbound(id, patch);
    } catch {
      await this.fallback.recordInbound(id, patch);
    }
  }

  async createLog(input: MediaDeliveryLogInput): Promise<MediaDeliveryLogRecord> {
    const target = await this.target();
    try {
      return await target.createLog(input);
    } catch {
      return this.fallback.createLog(input);
    }
  }

  async listLogs(filter?: MediaDeliveryLogFilter): Promise<MediaDeliveryLogRecord[]> {
    const target = await this.target();
    try {
      return await target.listLogs(filter);
    } catch {
      return this.fallback.listLogs(filter);
    }
  }

  async trimLogs(keep: number): Promise<number> {
    const target = await this.target();
    try {
      return await target.trimLogs(keep);
    } catch {
      return this.fallback.trimLogs(keep);
    }
  }

  async delete(id: string): Promise<void> {
    const target = await this.target();
    try {
      await target.delete(id);
    } catch {
      await this.fallback.delete(id);
    }
  }
}
