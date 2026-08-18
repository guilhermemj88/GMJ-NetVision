import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { LldpTopologyPreview } from '@gmj/shared';
import type { TopologyPreviewStore, TopologyRawDiscoveryResult } from '../../domain/ports';

/**
 * Persists the derived LLDP topology preview and reuses the existing
 * DiscoveryJob/DiscoveryResult models to store the raw per-device results.
 * This keeps a long discovery available after an API restart.
 */
export class PrismaTopologyPreviewStore implements TopologyPreviewStore {
  private readonly prisma = new PrismaClient();

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async save(preview: LldpTopologyPreview, rawResults: TopologyRawDiscoveryResult[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const raw of rawResults) {
        if (!raw.neighbors.length) continue;
        await tx.discoveryJob.create({
          data: {
            deviceId: raw.deviceId,
            method: raw.method,
            status: 'COMPLETED',
            results: {
              create: raw.neighbors.map((neighbor) => ({
                localPort: neighbor.localPort,
                remotePort: neighbor.remotePort,
                remoteIdentity: {
                  systemName: neighbor.remoteSystemName,
                  ...(neighbor.remoteManagementAddress
                    ? { managementAddress: neighbor.remoteManagementAddress }
                    : {}),
                  ...(neighbor.remoteChassisId ? { chassisId: neighbor.remoteChassisId } : {}),
                  ...(neighbor.remotePortDescription
                    ? { portDescription: neighbor.remotePortDescription }
                    : {}),
                  ...(neighbor.systemDescription ? { systemDescription: neighbor.systemDescription } : {}),
                  source: neighbor.source,
                },
                matchStatus: 'UNMATCHED',
              })),
            },
          },
        });
      }
      await tx.lldpTopologyPreview.upsert({
        where: { id: preview.id },
        create: {
          id: preview.id,
          mapId: preview.mapId,
          payload: preview as unknown as Prisma.InputJsonValue,
        },
        update: { payload: preview as unknown as Prisma.InputJsonValue },
      });
    });
  }

  async load(previewId: string): Promise<LldpTopologyPreview | null> {
    const row = await this.prisma.lldpTopologyPreview.findUnique({ where: { id: previewId } });
    return row ? (row.payload as unknown as LldpTopologyPreview) : null;
  }
}
