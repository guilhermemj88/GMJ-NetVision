import type { PrismaClient, MitigationTrafficObservation } from '../../generated/prisma/index.js';
import type {
  FastTrafficObservation,
  FastTrafficQuality,
  FastTrafficStore,
} from './fast-traffic-types';
import { PrismaFastObservationPurge, retentionCutoff } from './fast-observation-retention';

/**
 * OBSERVATION ONLY: separate database, no inventory mirrors and no actuator consumer.
 * The GET validates live ifName/ifIndex against the read-only operational inventory.
 * Unlike the enforce store this cannot be used as an activation source: it has no
 * transactional lock on the operational inventory (which this process cannot write).
 */
export class PrismaObserverTrafficStore implements FastTrafficStore {
  static toObservation(row: MitigationTrafficObservation): FastTrafficObservation {
    return {
      ...row,
      inOctets: BigInt(row.inOctets.toString()),
      outOctets: BigInt(row.outOctets.toString()),
      quality: row.quality as FastTrafficQuality,
    };
  }
  constructor(private readonly db: PrismaClient) {}
  async append(o: FastTrafficObservation): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${o.interfaceId})::bigint)`;
      const latest = await tx.mitigationTrafficObservation.findFirst({
        where: { interfaceId: o.interfaceId },
        orderBy: { collectedAt: 'desc' },
      });
      if (latest && latest.collectedAt >= o.collectedAt) return false;
      await tx.mitigationTrafficObservation.create({
        data: { ...o, inOctets: o.inOctets.toString(), outOctets: o.outOctets.toString() },
      });
      return true;
    });
  }
  async latest(interfaceId: string): Promise<FastTrafficObservation | null> {
    const row = await this.db.mitigationTrafficObservation.findFirst({
      where: { interfaceId },
      orderBy: { collectedAt: 'desc' },
    });
    return row
      ? {
          ...row,
          inOctets: BigInt(row.inOctets.toString()),
          outOctets: BigInt(row.outOctets.toString()),
          quality: row.quality as FastTrafficQuality,
        }
      : null;
  }
  async prune(): Promise<number> {
    // Mantido para chamadas legadas: delega à política única de retenção
    // (banco de OBSERVAÇÃO apenas, em lotes ordenados e com corte explícito).
    return new PrismaFastObservationPurge(this.db).deleteObservationsBefore(
      retentionCutoff(new Date(), 7),
      10_000,
    );
  }
}
