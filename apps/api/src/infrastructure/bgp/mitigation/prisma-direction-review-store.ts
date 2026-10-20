import type { PrismaClient } from '../../../generated/prisma/index.js';
import { mapProfile, PrismaMitigationRepository } from './prisma-mitigation-repository';
import {
  directionInterfaceRevision,
  directionProfileRevision,
  DirectionReviewError,
  type DirectionReviewStore,
} from './mitigation-direction-review';

/**
 * Persistencia da revisao de direcao (perfil e interface) em UMA transacao
 * serializavel, com auditoria transacional (autor, momento, antes/depois).
 * Falha em qualquer item (revisao vencida, AUTO concorrente, banco indisponivel)
 * desfaz TODO o lote — nunca aplica metade.
 */
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
            const row = await tx.bgpMitigationProfile.findUnique({
              where: { id: change.profileId },
              include: { interface: { select: { mitigationTrafficDirection: true } } },
            });
            const p = row ? mapProfile(row) : null;
            if (!p || p.mode === 'AUTO' || directionProfileRevision(p) !== input.revisions[p.id])
              throw new DirectionReviewError('DIRECTION_PREVIEW_STALE');
            audit.push({
              target: 'PROFILE',
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
          for (const change of [...input.interfaceChanges].sort((a, b) =>
            a.interfaceId.localeCompare(b.interfaceId),
          )) {
            await tx.$queryRaw`SELECT id FROM "Interface" WHERE id = ${change.interfaceId} FOR UPDATE`;
            const iface = await tx.interface.findUnique({
              where: { id: change.interfaceId },
              select: { id: true, deviceId: true, mitigationTrafficDirection: true },
            });
            if (!iface) throw new DirectionReviewError('INTERFACE_NOT_FOUND', 404);
            const profiles = await tx.bgpMitigationProfile.findMany({
              where: { interfaceId: change.interfaceId },
              select: { id: true, mode: true },
              orderBy: { id: 'asc' },
            });
            const autoProfileIds = profiles.filter((p) => p.mode === 'AUTO').map((p) => p.id);
            if (autoProfileIds.length)
              throw new DirectionReviewError('INTERFACE_HAS_AUTO_PROFILE', 409);
            const affectedProfileIds = profiles.filter((p) => p.mode !== 'AUTO').map((p) => p.id);
            const expected = directionInterfaceRevision({
              interfaceId: iface.id,
              direction: iface.mitigationTrafficDirection,
              affectedProfileIds,
              autoProfileIds,
            });
            if (expected !== input.interfaceRevisions[iface.id])
              throw new DirectionReviewError('DIRECTION_PREVIEW_STALE');
            audit.push({
              target: 'INTERFACE',
              interfaceId: iface.id,
              deviceId: iface.deviceId,
              before: iface.mitigationTrafficDirection,
              after: change.direction,
              affectedProfileIds,
            });
            await tx.interface.update({
              where: { id: iface.id },
              data: { mitigationTrafficDirection: change.direction },
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
      const prismaCode =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
      // Transacao SERIALIZAVEL do PostgreSQL aborta com SQLSTATE 40001 (ou
      // 40P01 em deadlock). O Prisma entrega isso como P2010 carregando o codigo
      // bruto em `meta.code`; P2034/P2002 sao os conflitos ja mapeados pelo
      // Prisma. Todos significam "refaca a previa", nunca "banco indisponivel".
      const rawCode =
        error && typeof error === 'object' && 'meta' in error
          ? String((error.meta as { code?: unknown } | undefined)?.code ?? '')
          : '';
      if (
        prismaCode === 'P2034' ||
        prismaCode === 'P2002' ||
        (prismaCode === 'P2010' && (rawCode === '40001' || rawCode === '40P01'))
      )
        throw new DirectionReviewError('DIRECTION_PREVIEW_STALE');
      throw new DirectionReviewError('DIRECTION_STORE_UNAVAILABLE', 503);
    }
  }
}
