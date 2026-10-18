import type { PrismaClient } from '../../../generated/prisma/index.js';
import { PrismaMitigationRepository } from './prisma-mitigation-repository';
import {
  directionProfileRevision,
  DirectionReviewError,
  type DirectionReviewStore,
} from './mitigation-direction-review';

export class PrismaDirectionReviewStore implements DirectionReviewStore {
  constructor(private readonly db: PrismaClient) {}
  listProfiles() {
    return new PrismaMitigationRepository(this.db).listProfiles();
  }
  async apply(input: Parameters<DirectionReviewStore['apply']>[0]): Promise<void> {
    try {
      await this.db.$transaction(
        async (tx) => {
          const audit: object[] = [];
          for (const change of [...input.changes].sort((a, b) =>
            a.profileId.localeCompare(b.profileId),
          )) {
            await tx.$queryRaw`SELECT id FROM "BgpMitigationProfile" WHERE id = ${change.profileId} FOR UPDATE`;
            const p = await tx.bgpMitigationProfile.findUnique({ where: { id: change.profileId } });
            if (!p || p.mode === 'AUTO' || directionProfileRevision(p) !== input.revisions[p.id])
              throw new DirectionReviewError('DIRECTION_PREVIEW_STALE');
            audit.push({
              profileId: p.id,
              deviceId: p.deviceId,
              interfaceId: p.interfaceId,
              addressFamily: p.addressFamily,
              before: p.autoTrafficDirection,
              after: change.direction,
              mode: p.mode,
              autoPromotedBySweep: p.autoPromotedBySweep,
            });
            await tx.bgpMitigationProfile.update({
              where: { id: p.id },
              data: { autoTrafficDirection: change.direction },
            });
          }
          // Transactional audit: failure rolls back every direction change.
          await tx.mitigationDirectionAudit.create({
            data: {
              id: input.id,
              actorId: input.actorId,
              changes: JSON.parse(JSON.stringify(audit)),
            },
          });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (error instanceof DirectionReviewError) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'P2034' || error.code === 'P2002')
      )
        throw new DirectionReviewError('DIRECTION_PREVIEW_STALE');
      throw new DirectionReviewError('DIRECTION_STORE_UNAVAILABLE', 503);
    }
  }
}
