import { PrismaClient, type MitigationTrafficObservation } from '../../generated/prisma/index.js';
import { prismaClient } from '../persistence/prisma-client.js';
import type {
  FastTrafficObservation,
  FastTrafficStore,
  FastTrafficQuality,
} from './fast-traffic-types';

/** Separate table/baseline: the conventional collector never writes this stream. */
export class PrismaFastTrafficStore implements FastTrafficStore {
  constructor(private readonly prisma: PrismaClient = prismaClient) {}

  async append(o: FastTrafficObservation): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize same-interface commits, including concurrent API instances.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${o.interfaceId})::bigint)`;
      const identities = await tx.$queryRaw<
        Array<{ deviceId: string; ifIndex: number; name: string }>
      >`
        SELECT "deviceId", "ifIndex", name FROM "Interface" WHERE id = ${o.interfaceId} FOR SHARE`;
      const identity = identities[0];
      if (
        !identity ||
        identity.deviceId !== o.deviceId ||
        identity.ifIndex !== o.ifIndex ||
        identity.name !== o.interfaceName
      )
        return false;
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
    // Do not filter invalid rows: an invalid latest observation invalidates the trigger.
    const rows = await this.prisma.$queryRaw<MitigationTrafficObservation[]>`
      SELECT o.* FROM (SELECT * FROM "MitigationTrafficObservation" WHERE "interfaceId" = ${interfaceId}
        ORDER BY "collectedAt" DESC LIMIT 1) o
      JOIN "Interface" i ON i.id = o."interfaceId" AND i."deviceId" = o."deviceId"
        AND i."ifIndex" = o."ifIndex" AND i.name = o."interfaceName"`;
    const row = rows[0];
    return row
      ? {
          ...row,
          inOctets: BigInt(row.inOctets.toString()),
          outOctets: BigInt(row.outOctets.toString()),
          quality: row.quality as FastTrafficQuality,
        }
      : null;
  }
}
