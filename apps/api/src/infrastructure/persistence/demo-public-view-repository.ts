import type { PublicViewRepository, PublicViewRecord } from './public-view-repository';

export class DemoPublicViewRepository implements PublicViewRepository {
  private readonly views = new Map<string, PublicViewRecord>();

  async list(): Promise<PublicViewRecord[]> {
    return [...this.views.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async create(input: {
    token: string;
    name: string;
    type: PublicViewRecord['type'];
    mapId?: string | null;
    playlistId?: string | null;
    expiresAt?: Date | null;
  }): Promise<PublicViewRecord> {
    const now = new Date();
    const record: PublicViewRecord = {
      id: `public-view-${input.token.slice(0, 8)}`,
      token: input.token,
      name: input.name,
      type: input.type,
      mapId: input.mapId ?? null,
      playlistId: input.playlistId ?? null,
      enabled: true,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.views.set(record.id, record);
    return record;
  }

  async update(
    id: string,
    patch: { name?: string; enabled?: boolean; expiresAt?: Date | null },
  ): Promise<PublicViewRecord | null> {
    const record = this.views.get(id);
    if (!record) return null;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.enabled !== undefined) record.enabled = patch.enabled;
    if (patch.expiresAt !== undefined) record.expiresAt = patch.expiresAt;
    record.updatedAt = new Date();
    return record;
  }

  async remove(id: string): Promise<boolean> {
    return this.views.delete(id);
  }

  async findByToken(token: string): Promise<PublicViewRecord | null> {
    for (const record of this.views.values()) {
      if (record.token === token) return record;
    }
    return null;
  }
}
