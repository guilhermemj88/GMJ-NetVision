import type { PrismaClient } from '../../generated/prisma/index.js';
import type {
  FastTrafficObservation,
  FastTrafficQuality,
  FastTrafficStore,
} from './fast-traffic-types';

/**
 * OBSERVATION ONLY: separate database, no inventory mirrors and no actuator consumer.
 * The GET validates live ifName/ifIndex against the read-only operational inventory.
 * Unlike the enforce store this cannot be used as an activation source: it has no
 * transactional lock on the operational inventory (which this process cannot write).
 */
export class PrismaObserverTrafficStore implements FastTrafficStore {
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
    // Bounded retention in the OBSERVATION database only. Seven days, batches of 10000.
    return this.db.$executeRaw`DELETE FROM "MitigationTrafficObservation" WHERE id IN
      (SELECT id FROM "MitigationTrafficObservation" WHERE "collectedAt" < NOW() - INTERVAL '7 days'
       ORDER BY "collectedAt" LIMIT 10000)`;
  }
}
