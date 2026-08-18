import { PrismaClient } from '../../generated/prisma/index.js';
import type { PublicViewRepository, PublicViewRecord } from './public-view-repository';

function fromRow(row: {
  id: string;
  token: string;
  name: string;
  type: string;
  mapId: string | null;
  playlistId: string | null;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PublicViewRecord {
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    type: row.type as PublicViewRecord['type'],
    mapId: row.mapId,
    playlistId: row.playlistId,
    enabled: row.enabled,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaPublicViewRepository implements PublicViewRepository {
  private readonly prisma = new PrismaClient();

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async list(): Promise<PublicViewRecord[]> {
    const rows = await this.prisma.publicView.findMany({ orderBy: { name: 'asc' } });
    return rows.map(fromRow);
  }

  async create(input: {
    token: string;
    name: string;
    type: PublicViewRecord['type'];
    mapId?: string | null;
    playlistId?: string | null;
    expiresAt?: Date | null;
  }): Promise<PublicViewRecord> {
    const row = await this.prisma.publicView.create({
      data: {
        token: input.token,
        name: input.name,
        type: input.type,
        mapId: input.mapId ?? null,
        playlistId: input.playlistId ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });
    return fromRow(row);
  }

  async update(
    id: string,
    patch: { name?: string; enabled?: boolean; expiresAt?: Date | null },
  ): Promise<PublicViewRecord | null> {
    const row = await this.prisma.publicView.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      },
    });
    return fromRow(row);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.prisma.publicView.deleteMany({ where: { id } });
    return result.count > 0;
  }

  async findByToken(token: string): Promise<PublicViewRecord | null> {
    const row = await this.prisma.publicView.findUnique({ where: { token } });
    return row ? fromRow(row) : null;
  }
}
