import { PrismaClient, type BgpState } from '../../generated/prisma/index.js';
import {
  decideBgpDiscoveryState,
  decideBgpPollingUpdate,
  discoveryInterfaceUpdate,
  type ExistingBgpPeerState,
} from './bgp-persistence';
import type { BgpDiscoveryPeerInput, BgpRepository } from './bgp-repository';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';

const existingPeerSelect = {
  id: true,
  stateCode: true,
  state: true,
  established: true,
  establishedSince: true,
  lastStateChangedAt: true,
  lastPollingAt: true,
  monitoringEnabled: true,
} as const;

function existingState(row: {
  id: string;
  stateCode: number;
  state: BgpState;
  established: boolean;
  establishedSince: Date | null;
  lastStateChangedAt: Date | null;
  lastPollingAt: Date | null;
  monitoringEnabled: boolean;
}): ExistingBgpPeerState {
  return row;
}

export class PrismaBgpRepository implements BgpRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async saveCollection(deviceId: string, collection: HuaweiBgpCollection): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const current of collection.peers) {
        const key = { deviceId, peerAddress: current.peerAddress };
        const existingRow = await tx.bgpPeer.findUnique({
          where: { deviceId_peerAddress: key },
          select: existingPeerSelect,
        });
        const existing = existingRow ? existingState(existingRow) : null;
        const decision = decideBgpPollingUpdate(existing, current, collection.collectedAt);
        const peer = existing
          ? await tx.bgpPeer.update({
              where: { id: existing.id },
              data: {
                stateCode: decision.stateCode,
                state: decision.state,
                established: decision.established,
                receivedPrefixes: decision.receivedPrefixes,
                lastPollingAt: collection.collectedAt,
                ...(decision.establishedSince === undefined
                  ? {}
                  : { establishedSince: decision.establishedSince }),
                ...(decision.lastStateChangedAt
                  ? { lastStateChangedAt: decision.lastStateChangedAt }
                  : {}),
              },
              select: { id: true, monitoringEnabled: true },
            })
          : await tx.bgpPeer.upsert({
              where: { deviceId_peerAddress: key },
              create: {
                ...key,
                role: 'OTHER',
                monitoringEnabled: true,
                stateCode: decision.stateCode,
                state: decision.state,
                established: decision.established,
                receivedPrefixes: decision.receivedPrefixes,
                establishedSince: decision.establishedSince ?? null,
                lastPollingAt: collection.collectedAt,
              },
              update: {
                stateCode: decision.stateCode,
                state: decision.state,
                established: decision.established,
                receivedPrefixes: decision.receivedPrefixes,
                lastPollingAt: collection.collectedAt,
              },
              select: { id: true, monitoringEnabled: true },
            });

        if (decision.event) {
          await tx.bgpPeerStateEvent.create({
            data: {
              bgpPeerId: peer.id,
              ...decision.event,
              occurredAt: collection.collectedAt,
            },
          });
        }
        if (peer.monitoringEnabled) {
          await tx.bgpPeerSample.create({
            data: {
              bgpPeerId: peer.id,
              timestamp: collection.collectedAt,
              stateCode: decision.stateCode,
              state: decision.state,
              established: decision.established,
              receivedPrefixes: decision.receivedPrefixes,
            },
          });
        }
      }
    });
  }

  async saveDiscovery(
    deviceId: string,
    peers: readonly BgpDiscoveryPeerInput[],
    discoveredAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const discovered of peers) {
        const key = { deviceId, peerAddress: discovered.peerAddress };
        const existingRow = await tx.bgpPeer.findUnique({
          where: { deviceId_peerAddress: key },
          select: existingPeerSelect,
        });
        const existing = existingRow ? existingState(existingRow) : null;
        const state = decideBgpDiscoveryState(existing, discovered, discoveredAt);
        const interfaceUpdate = discoveryInterfaceUpdate(discovered);
        if (!existing) {
          await tx.bgpPeer.upsert({
            where: { deviceId_peerAddress: key },
            create: {
              ...key,
              remoteAs: discovered.remoteAs,
              interfaceId: interfaceUpdate.interfaceId ?? null,
              role: 'OTHER',
              monitoringEnabled: true,
              stateCode: state.stateCode ?? 0,
              state: state.state ?? 'UNKNOWN',
              established: state.established ?? false,
              establishedSince: state.establishedSince ?? null,
              lastDiscoveryAt: discoveredAt,
            },
            update: {
              ...(discovered.remoteAs === null ? {} : { remoteAs: discovered.remoteAs }),
              ...interfaceUpdate,
              lastDiscoveryAt: discoveredAt,
            },
          });
          continue;
        }
        await tx.bgpPeer.update({
          where: { id: existing.id },
          data: {
            ...(discovered.remoteAs === null ? {} : { remoteAs: discovered.remoteAs }),
            ...interfaceUpdate,
            ...state,
            lastDiscoveryAt: discoveredAt,
          },
        });
      }
    });
  }
}
