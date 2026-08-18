import type { PublicViewType } from '@gmj/shared';

export interface PublicViewRecord {
  id: string;
  token: string;
  name: string;
  type: PublicViewType;
  mapId: string | null;
  playlistId: string | null;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicViewRepository {
  list(): Promise<PublicViewRecord[]>;
  create(input: {
    token: string;
    name: string;
    type: PublicViewType;
    mapId?: string | null;
    playlistId?: string | null;
    expiresAt?: Date | null;
  }): Promise<PublicViewRecord>;
  update(
    id: string,
    patch: { name?: string; enabled?: boolean; expiresAt?: Date | null },
  ): Promise<PublicViewRecord | null>;
  remove(id: string): Promise<boolean>;
  findByToken(token: string): Promise<PublicViewRecord | null>;
  disconnect?(): Promise<void>;
}
