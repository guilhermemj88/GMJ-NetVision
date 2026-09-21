import { Prisma, PrismaClient, type BgpPeerRole, type BgpState, type BgpAdminState as PrismaBgpAdminState, type BgpAddressFamily as PrismaBgpAddressFamily } from '../../generated/prisma/index.js';
import {
  bigintToJsonNumber,
  bigintToJsonString,
  decideBgpDiscoverySample,
  decideBgpDiscoveryState,
  decideBgpPollingUpdate,
  deriveBgpPeerDisplayName,
  discoveryInterfaceUpdate,
  type ExistingBgpPeerState,
} from './bgp-persistence';
import type { BgpDashboardQuery, BgpDiscoveryPeerInput, BgpRepository } from './bgp-repository';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';
import { computeBgpAlerts } from './bgp-alerts';
import type {
  BgpAdminState,
  BgpAddressFamily,
  BgpAlertsResponse,
  BgpDashboardPeer,
  BgpHistoryPeriod,
  BgpPeerHistoryResponse,
  BgpPeerState,
  BgpScope,
} from '@gmj/shared';

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
        // IPv6 has no SNMP state source yet, so its history (samples and state
        // events for the 48h alert panel) is recorded from SSH discovery.
        const sampling =
          discovered.addressFamily === 'IPV6'
            ? decideBgpDiscoverySample(existing, discovered, discoveredAt)
            : null;
        const sampleData =
          sampling?.record === true
            ? {
                stateCode: sampling.stateCode,
                state: sampling.state,
                established: sampling.established,
                receivedPrefixes: sampling.receivedPrefixes,
                ...(sampling.establishedSince === undefined
                  ? {}
                  : { establishedSince: sampling.establishedSince }),
                ...(sampling.lastStateChangedAt
                  ? { lastStateChangedAt: sampling.lastStateChangedAt }
                  : {}),
              }
            : {};

        const peer = await tx.bgpPeer.upsert({
          where: { deviceId_peerAddress: key },
          create: {
            ...key,
            addressFamily: discovered.addressFamily as PrismaBgpAddressFamily,
            peerDescription: discovered.bgpPeerDescription,
            remoteAs: discovered.remoteAs,
            interfaceId: interfaceUpdate.interfaceId ?? null,
            role: 'OTHER',
            monitoringEnabled: true,
            stateCode: sampling?.record === true ? sampling.stateCode : (state.stateCode ?? 0),
            state: sampling?.record === true ? sampling.state : (state.state ?? 'UNKNOWN'),
            established: sampling?.record === true ? sampling.established : (state.established ?? false),
            establishedSince:
              sampling?.record === true
                ? (sampling.establishedSince ?? null)
                : (state.establishedSince ?? null),
            lastDiscoveryAt: discoveredAt,
          },
          update: {
            ...(discovered.remoteAs === null ? {} : { remoteAs: discovered.remoteAs }),
            ...(discovered.bgpPeerDescription === null
              ? {}
              : { peerDescription: discovered.bgpPeerDescription }),
            ...interfaceUpdate,
            ...state,
            ...sampleData,
            lastDiscoveryAt: discoveredAt,
          },
          select: { id: true },
        });

        if (sampling?.record === true) {
          if (sampling.event) {
            await tx.bgpPeerStateEvent.create({
              data: { bgpPeerId: peer.id, ...sampling.event, occurredAt: discoveredAt },
            });
          }
          await tx.bgpPeerSample.create({
            data: {
              bgpPeerId: peer.id,
              timestamp: discoveredAt,
              stateCode: sampling.stateCode,
              state: sampling.state,
              established: sampling.established,
              receivedPrefixes: sampling.receivedPrefixes,
            },
          });
        }
      }
    });
  }

  async saveDeviceLocalAs(deviceId: string, localAs: bigint, _discoveredAt: Date): Promise<void> {
    await this.prisma.device.update({ where: { id: deviceId }, data: { bgpLocalAs: localAs } });
  }

  async getDeviceLocalAs(deviceId: string): Promise<bigint | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { bgpLocalAs: true },
    });
    return device?.bgpLocalAs ?? null;
  }

  async setPeerAdminState(
    peerId: string,
    adminState: BgpAdminState,
    checkedAt: Date,
  ): Promise<void> {
    await this.prisma.bgpPeer.update({
      where: { id: peerId },
      data: { adminState: adminState as PrismaBgpAdminState, adminStateCheckedAt: checkedAt },
    });
  }

  async listDashboardPeers(query: BgpDashboardQuery): Promise<BgpDashboardPeer[]> {
    const where: Prisma.BgpPeerWhereInput = {
      ...(query.scope === 'monitored' ? { device: { bgpMonitoringEnabled: true } } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      ...(query.family && query.family !== 'all'
        ? { addressFamily: query.family as PrismaBgpAddressFamily }
        : {}),
      ...(query.state === 'up'
        ? { established: true }
        : query.state === 'down'
          ? { established: false }
          : {}),
    };
    const rows = await this.prisma.bgpPeer.findMany({
      where,
      include: {
        device: {
          select: {
            id: true,
            hostname: true,
            displayName: true,
            bgpMonitoringEnabled: true,
            bgpLocalAs: true,
          },
        },
        interface: { select: { id: true, name: true, alias: true, description: true } },
      },
      orderBy: [{ device: { hostname: 'asc' } }, { peerAddress: 'asc' }],
    });
    const interfaceIds = [
      ...new Set(
        rows.map((row) => row.interfaceId).filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const traffic = await this.loadInterfaceTraffic(interfaceIds);
    const peers = rows.map((row) => this.toDashboardPeer(row, traffic));
    const text = query.q?.trim().toLowerCase();
    if (!text) return peers;
    return peers.filter((peer) =>
      [
        peer.peerAddress,
        peer.displayName,
        peer.remoteAs ?? '',
        peer.deviceHostname,
        peer.deviceDisplayName,
      ].some((value) => value.toLowerCase().includes(text)),
    );
  }

  async getPeerDetail(peerId: string): Promise<BgpDashboardPeer | null> {
    const row = await this.prisma.bgpPeer.findUnique({
      where: { id: peerId },
      include: {
        device: {
          select: {
            id: true,
            hostname: true,
            displayName: true,
            bgpMonitoringEnabled: true,
            bgpLocalAs: true,
          },
        },
        interface: { select: { id: true, name: true, alias: true, description: true } },
      },
    });
    if (!row) return null;
    const traffic = row.interfaceId ? await this.loadInterfaceTraffic([row.interfaceId]) : new Map();
    return this.toDashboardPeer(row, traffic);
  }

  async getPeerHistory(
    peerId: string,
    period: BgpHistoryPeriod,
  ): Promise<BgpPeerHistoryResponse | null> {
    const peer = await this.prisma.bgpPeer.findUnique({
      where: { id: peerId },
      select: { id: true },
    });
    if (!peer) return null;
    const since = bgpHistoryStart(period);
    const [samples, events] = await Promise.all([
      this.prisma.bgpPeerSample.findMany({
        where: { bgpPeerId: peerId, timestamp: { gte: since } },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true, state: true, established: true, receivedPrefixes: true },
      }),
      this.prisma.bgpPeerStateEvent.findMany({
        where: { bgpPeerId: peerId, occurredAt: { gte: since } },
        orderBy: { occurredAt: 'asc' },
        select: {
          previousStateCode: true,
          previousState: true,
          currentStateCode: true,
          currentState: true,
          occurredAt: true,
        },
      }),
    ]);
    return {
      peerId,
      samples: samples.map((sample) => ({
        timestamp: sample.timestamp.toISOString(),
        state: sample.state as BgpPeerState,
        established: sample.established,
        receivedPrefixes: bigintToJsonNumber(sample.receivedPrefixes),
      })),
      events: events.map((event) => ({
        previousStateCode: event.previousStateCode,
        previousState: event.previousState as BgpPeerState,
        currentStateCode: event.currentStateCode,
        currentState: event.currentState as BgpPeerState,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }

  async listAlerts(scope: BgpScope, hours: number): Promise<BgpAlertsResponse> {
    const where: Prisma.BgpPeerWhereInput =
      scope === 'monitored' ? { device: { bgpMonitoringEnabled: true } } : {};
    const rows = await this.prisma.bgpPeer.findMany({
      where,
      include: {
        device: { select: { id: true, displayName: true } },
        interface: { select: { id: true, name: true, alias: true, description: true } },
      },
    });
    const events = await this.prisma.bgpPeerStateEvent.findMany({
      where: { bgpPeerId: { in: rows.map((row) => row.id) } },
      orderBy: { occurredAt: 'asc' },
      select: {
        bgpPeerId: true,
        previousState: true,
        previousStateCode: true,
        currentState: true,
        currentStateCode: true,
        occurredAt: true,
      },
    });
    return computeBgpAlerts(
      rows.map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        deviceName: row.device.displayName,
        peerAddress: row.peerAddress,
        addressFamily: row.addressFamily as BgpAddressFamily,
        displayName: deriveBgpPeerDisplayName(row.peerAddress, row.interface ?? null, row.peerDescription),
        state: row.state as BgpPeerState,
        established: row.established,
        lastStateChangedAt: row.lastStateChangedAt,
      })),
      events.map((event) => ({
        bgpPeerId: event.bgpPeerId,
        previousState: event.previousState as BgpPeerState,
        previousStateCode: event.previousStateCode,
        currentState: event.currentState as BgpPeerState,
        currentStateCode: event.currentStateCode,
        occurredAt: event.occurredAt,
      })),
      new Date(Date.now() - hours * 60 * 60_000),
    );
  }

  private toDashboardPeer(
    row: {
      id: string;
      deviceId: string;
      peerAddress: string;
      addressFamily: PrismaBgpAddressFamily;
      peerDescription: string | null;
      remoteAs: bigint | null;
      interfaceId: string | null;
      monitoringEnabled: boolean;
      role: BgpPeerRole;
      adminState: PrismaBgpAdminState;
      adminStateCheckedAt: Date | null;
      stateCode: number;
      state: BgpState;
      established: boolean;
      receivedPrefixes: bigint | null;
      establishedSince: Date | null;
      lastPollingAt: Date | null;
      lastDiscoveryAt: Date | null;
      device: {
        id: string;
        hostname: string;
        displayName: string;
        bgpMonitoringEnabled: boolean;
        bgpLocalAs: bigint | null;
      };
      interface: { id: string; name: string; alias: string | null; description: string | null } | null;
    },
    traffic: Map<string, { rxBps: number; txBps: number }>,
  ): BgpDashboardPeer {
    const iface = row.interface ?? null;
    const ifaceTraffic = row.interfaceId ? traffic.get(row.interfaceId) ?? null : null;
    return {
      id: row.id,
      deviceId: row.deviceId,
      deviceHostname: row.device.hostname,
      deviceDisplayName: row.device.displayName,
      bgpMonitoringEnabled: row.device.bgpMonitoringEnabled,
      peerAddress: row.peerAddress,
      displayName: deriveBgpPeerDisplayName(row.peerAddress, iface, row.peerDescription),
      addressFamily: row.addressFamily as BgpAddressFamily,
      localAs: bigintToJsonString(row.device.bgpLocalAs),
      remoteAs: bigintToJsonString(row.remoteAs),
      role: row.role as BgpPeerRole,
      monitoringEnabled: row.monitoringEnabled,
      stateCode: row.stateCode,
      state: row.state as BgpPeerState,
      established: row.established,
      adminState: row.adminState as BgpAdminState,
      adminStateCheckedAt: row.adminStateCheckedAt?.toISOString() ?? null,
      receivedPrefixes: bigintToJsonNumber(row.receivedPrefixes),
      establishedSince: row.establishedSince?.toISOString() ?? null,
      lastPollingAt: row.lastPollingAt?.toISOString() ?? null,
      lastDiscoveryAt: row.lastDiscoveryAt?.toISOString() ?? null,
      interface: iface
        ? {
            id: iface.id,
            name: iface.name,
            alias: iface.alias,
            description: iface.description,
            rxBps: ifaceTraffic?.rxBps ?? null,
            txBps: ifaceTraffic?.txBps ?? null,
          }
        : null,
    };
  }

  private async loadInterfaceTraffic(
    interfaceIds: string[],
  ): Promise<Map<string, { rxBps: number; txBps: number }>> {
    if (!interfaceIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ interfaceId: string; rxBps: number; txBps: number }>>(
      Prisma.sql`
        SELECT i."id" AS "interfaceId", s."rxBps" AS "rxBps", s."txBps" AS "txBps"
        FROM "Interface" i
        JOIN LATERAL (
          SELECT m."rxBps", m."txBps"
          FROM "InterfaceMetricSample" m
          WHERE m."interfaceId" = i."id"
          ORDER BY m."timestamp" DESC
          LIMIT 1
        ) s ON TRUE
        WHERE i."id" IN (${Prisma.join(interfaceIds)})
      `,
    );
    return new Map(rows.map((row) => [row.interfaceId, { rxBps: row.rxBps, txBps: row.txBps }]));
  }
}

function bgpHistoryStart(period: BgpHistoryPeriod): Date {
  const milliseconds: Record<BgpHistoryPeriod, number> = {
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
  };
  return new Date(Date.now() - milliseconds[period]);
}
