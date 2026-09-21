import { PrismaClient, type BgpAdminAction } from '../../generated/prisma/index.js';
import type { BgpAdminAuditEntry, BgpAdminAuditRepository } from './bgp-admin-audit';

export class PrismaBgpAdminAuditRepository implements BgpAdminAuditRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async record(entry: BgpAdminAuditEntry): Promise<void> {
    await this.prisma.bgpAdminActionLog.create({
      data: {
        bgpPeerId: entry.peerId,
        deviceId: entry.deviceId,
        userId: entry.userId,
        username: entry.username,
        peerAddress: entry.peerAddress,
        addressFamily: entry.addressFamily,
        localAs: entry.localAs,
        remoteAs: entry.remoteAs,
        action: entry.action as BgpAdminAction,
        success: entry.success,
        verified: entry.verified,
        errorSafe: entry.errorSafe,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
      },
    });
  }
}
