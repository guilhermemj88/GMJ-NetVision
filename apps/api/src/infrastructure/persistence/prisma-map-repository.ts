import {
  calculateUtilization,
  createLocalId,
  type AddDeviceResult,
  type CreateGenericNodeInput,
  type CreateLinkInput,
  type CreateMapInput,
  type HostRecord,
  type MapNode,
  type MapPlaylist,
  type MapSettings,
  type MapSummary,
  type NetworkInterface,
  type NetworkLink,
  type NetworkMap,
  type Position,
  type UpdateMapInput,
} from '@gmj/shared';
import { PrismaClient } from '../../generated/prisma/index.js';
import type { HostRepository } from './host-repository';
import type { NodePositionUpdate } from './demo-map-repository';

const blankSettings: MapSettings = {
  nodeDisplayMode: 'ICON_2D',
  linkDisplayStyle: 'HYBRID',
  linkMetricDisplay: 'BOTH',
  filters: {
    showTraffic: true,
    showUtilization: true,
    showLabels: true,
    showOffline: true,
    showInterfaces: false,
    showTrafficAnimation: true,
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  nodeScale: 100,
  linkScale: 100,
  labelScale: 100,
};

function safeNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

function settingsFromRow(row: {
  nodeDisplayMode: string;
  linkDisplayStyle: string;
  linkMetricDisplay: string;
  nodeScale: number;
  linkScale: number;
  labelScale: number;
  viewport: unknown;
  filters: unknown;
}): MapSettings {
  const viewport = row.viewport && typeof row.viewport === 'object'
    ? row.viewport as Partial<MapSettings['viewport']>
    : {};
  const filters = row.filters && typeof row.filters === 'object'
    ? row.filters as Partial<MapSettings['filters']>
    : {};
  return {
    nodeDisplayMode: row.nodeDisplayMode as MapSettings['nodeDisplayMode'],
    linkDisplayStyle: row.linkDisplayStyle as MapSettings['linkDisplayStyle'],
    linkMetricDisplay: row.linkMetricDisplay as MapSettings['linkMetricDisplay'],
    nodeScale: row.nodeScale,
    linkScale: row.linkScale,
    labelScale: row.labelScale,
    viewport: { ...blankSettings.viewport, ...viewport },
    filters: { ...blankSettings.filters, ...filters },
  };
}

function nodeFromRow(row: {
  id: string;
  mapId: string;
  deviceId: string | null;
  nodeKind: string;
  genericType: string | null;
  label: string | null;
  x: number;
  y: number;
  locked: boolean;
  positionSource: string;
}): MapNode {
  return {
    id: row.id,
    mapId: row.mapId,
    deviceId: row.deviceId,
    nodeKind: row.nodeKind as MapNode['nodeKind'],
    genericType: row.genericType,
    label: row.label,
    position: { x: row.x, y: row.y },
    locked: row.locked,
    positionSource: row.positionSource as MapNode['positionSource'],
  };
}

function linkStatus(source: NetworkInterface | undefined, target: NetworkInterface | undefined): NetworkLink['status'] {
  if (!source && !target) return 'UNKNOWN';
  if (source?.operStatus === 'DOWN' || source?.operStatus === 'DISABLED' || target?.operStatus === 'DOWN' || target?.operStatus === 'DISABLED') return 'DOWN';
  if (source?.operStatus === 'UP' && target?.operStatus === 'UP') return 'UP';
  return 'UNKNOWN';
}

export class PrismaMapRepository {
  private readonly prisma = new PrismaClient();

  constructor(private readonly hosts: HostRepository) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async listMaps(): Promise<MapSummary[]> {
    const rows = await this.prisma.map.findMany({
      include: { _count: { select: { nodes: true, links: true } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      mode: row.mode,
      isDefault: row.isDefault,
      nodeCount: row._count.nodes,
      linkCount: row._count.links,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getMap(mapId: string): Promise<NetworkMap | null> {
    const row = await this.prisma.map.findUnique({ where: { id: mapId }, include: { nodes: true, links: true } });
    return row ? this.materialize(row) : null;
  }

  async getDefaultMap(): Promise<NetworkMap | null> {
    const row = await this.prisma.map.findFirst({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { nodes: true, links: true },
    });
    return row ? this.materialize(row) : null;
  }

  async createMap(input: CreateMapInput): Promise<NetworkMap> {
    const source = input.sourceMapId
      ? await this.prisma.map.findUnique({ where: { id: input.sourceMapId }, include: { nodes: true, links: true } })
      : null;
    const count = await this.prisma.map.count();
    const created = await this.prisma.$transaction(async (tx) => {
      const map = await tx.map.create({
        data: {
          id: createLocalId('map'),
          name: input.name,
          description: input.description,
          mode: input.mode,
          isDefault: count === 0,
          ...(source ? {
            nodeDisplayMode: source.nodeDisplayMode,
            linkDisplayStyle: source.linkDisplayStyle,
            linkMetricDisplay: source.linkMetricDisplay,
            nodeScale: source.nodeScale,
            linkScale: source.linkScale,
            labelScale: source.labelScale,
          } : {}),
        },
      });
      if (source) {
        for (const node of source.nodes) {
          await tx.mapNode.create({
            data: {
              mapId: map.id,
              deviceId: node.deviceId,
              nodeKind: node.nodeKind,
              genericType: node.genericType,
              label: node.label,
              x: node.x,
              y: node.y,
              locked: node.locked,
              positionSource: node.positionSource,
            },
          });
        }
        for (const link of source.links) {
          await tx.link.create({
            data: {
              mapId: map.id,
              sourceDeviceId: link.sourceDeviceId,
              sourceInterfaceId: link.sourceInterfaceId,
              targetDeviceId: link.targetDeviceId,
              targetInterfaceId: link.targetInterfaceId,
              sourceNodeId: link.sourceNodeId,
              targetNodeId: link.targetNodeId,
              capacityBps: link.capacityBps,
              autoCapacityBps: link.autoCapacityBps,
              capacitySource: link.capacitySource,
              label: link.label,
              status: link.status,
              discoverySource: link.discoverySource,
              metricSource: link.metricSource,
              visualStyle: link.visualStyle,
              metricDisplay: link.metricDisplay,
            },
          });
        }
      }
      return tx.map.findUniqueOrThrow({ where: { id: map.id }, include: { nodes: true, links: true } });
    });
    return this.materialize(created);
  }

  async updateMap(mapId: string, input: UpdateMapInput): Promise<NetworkMap | null> {
    const existing = await this.prisma.map.findUnique({ where: { id: mapId } });
    if (!existing) return null;
    await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.map.updateMany({ data: { isDefault: false } });
      const settings = input.settings;
      await tx.map.update({
        where: { id: mapId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          ...(settings?.nodeDisplayMode !== undefined ? { nodeDisplayMode: settings.nodeDisplayMode } : {}),
          ...(settings?.linkDisplayStyle !== undefined ? { linkDisplayStyle: settings.linkDisplayStyle } : {}),
          ...(settings?.linkMetricDisplay !== undefined ? { linkMetricDisplay: settings.linkMetricDisplay } : {}),
          ...(settings?.nodeScale !== undefined ? { nodeScale: settings.nodeScale } : {}),
          ...(settings?.linkScale !== undefined ? { linkScale: settings.linkScale } : {}),
          ...(settings?.labelScale !== undefined ? { labelScale: settings.labelScale } : {}),
          ...(settings?.viewport !== undefined ? { viewport: { ...(existing.viewport as object ?? {}), ...settings.viewport } } : {}),
          ...(settings?.filters !== undefined ? { filters: { ...(existing.filters as object ?? {}), ...settings.filters } } : {}),
        },
      });
    });
    return this.getMap(mapId);
  }

  async deleteMap(mapId: string): Promise<boolean> {
    if (await this.prisma.map.count() <= 1) return false;
    const existing = await this.prisma.map.findUnique({ where: { id: mapId } });
    if (!existing) return false;
    await this.prisma.map.delete({ where: { id: mapId } });
    if (existing.isDefault) {
      const next = await this.prisma.map.findFirst({ orderBy: { createdAt: 'asc' } });
      if (next) await this.prisma.map.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return true;
  }

  async listPlaylists(): Promise<MapPlaylist[]> {
    const rows = await this.prisma.mapPlaylist.findMany({ include: { items: { orderBy: { order: 'asc' } } }, orderBy: { name: 'asc' } });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rotationIntervalSeconds: row.rotationIntervalSeconds,
      isDefault: row.isDefault,
      items: row.items.map((item) => ({ mapId: item.mapId, order: item.order })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async savePlaylist(input: { id?: string; name: string; rotationIntervalSeconds: number; mapIds: string[]; isDefault: boolean }): Promise<MapPlaylist> {
    const id = input.id ?? createLocalId('playlist');
    const row = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.mapPlaylist.updateMany({ data: { isDefault: false } });
      await tx.mapPlaylist.upsert({
        where: { id },
        create: { id, name: input.name, rotationIntervalSeconds: input.rotationIntervalSeconds, isDefault: input.isDefault },
        update: { name: input.name, rotationIntervalSeconds: input.rotationIntervalSeconds, isDefault: input.isDefault },
      });
      await tx.mapPlaylistItem.deleteMany({ where: { playlistId: id } });
      if (input.mapIds.length) await tx.mapPlaylistItem.createMany({ data: input.mapIds.map((mapId, order) => ({ playlistId: id, mapId, order })) });
      return tx.mapPlaylist.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { order: 'asc' } } } });
    });
    return {
      id: row.id,
      name: row.name,
      rotationIntervalSeconds: row.rotationIntervalSeconds,
      isDefault: row.isDefault,
      items: row.items.map((item) => ({ mapId: item.mapId, order: item.order })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updatePositions(mapId: string, updates: NodePositionUpdate[]): Promise<NetworkMap | null> {
    if (!await this.prisma.map.findUnique({ where: { id: mapId }, select: { id: true } })) return null;
    await this.prisma.$transaction(updates.map((update) => this.prisma.mapNode.updateMany({
      where: { id: update.nodeId, mapId },
      data: {
        x: update.position.x,
        y: update.position.y,
        positionSource: 'MANUAL',
        ...(update.locked === undefined ? {} : { locked: update.locked }),
      },
    })));
    return this.getMap(mapId);
  }

  async setNodeLocked(mapId: string, nodeId: string, locked: boolean): Promise<NetworkMap | null> {
    const result = await this.prisma.mapNode.updateMany({ where: { id: nodeId, mapId }, data: { locked } });
    return result.count ? this.getMap(mapId) : null;
  }

  async addHostToMap(hostId: string, mapId: string, position: Position): Promise<AddDeviceResult | null> {
    const [host, map] = await Promise.all([this.hosts.getHost(hostId), this.prisma.map.findUnique({ where: { id: mapId }, select: { id: true } })]);
    if (!host || !map) return null;
    const node = await this.prisma.mapNode.upsert({
      where: { mapId_deviceId: { mapId, deviceId: hostId } },
      create: { mapId, deviceId: hostId, x: position.x, y: position.y, locked: false, positionSource: 'MANUAL' },
      update: {},
    });
    const refreshedHost = await this.hosts.getHost(hostId) ?? host;
    return { device: refreshedHost, node: nodeFromRow(node) };
  }

  async addHostsToMap(mapId: string, deviceIds: string[], seedPosition: Position = { x: 520, y: 340 }): Promise<AddDeviceResult[]> {
    const created: AddDeviceResult[] = [];
    for (const [index, deviceId] of deviceIds.entries()) {
      const exists = await this.prisma.mapNode.findUnique({ where: { mapId_deviceId: { mapId, deviceId } } });
      if (exists) continue;
      const result = await this.addHostToMap(deviceId, mapId, {
        x: seedPosition.x + (index % 4) * 120 - 180,
        y: seedPosition.y + Math.floor(index / 4) * 90,
      });
      if (result) created.push(result);
    }
    return created;
  }

  async createLink(mapId: string, input: CreateLinkInput): Promise<NetworkLink | null> {
    return this.createDiscoveredLink(mapId, input, 'MANUAL');
  }

  async addGenericNode(mapId: string, input: CreateGenericNodeInput): Promise<MapNode | null> {
    const map = await this.prisma.map.findUnique({ where: { id: mapId }, select: { id: true } });
    if (!map) return null;
    const node = await this.prisma.mapNode.create({
      data: {
        mapId,
        deviceId: null,
        nodeKind: 'GENERIC',
        genericType: input.type,
        label: input.label,
        x: input.position.x,
        y: input.position.y,
        locked: false,
        positionSource: 'MANUAL',
      },
    });
    return nodeFromRow(node);
  }

  async deleteNode(mapId: string, nodeId: string): Promise<boolean> {
    const result = await this.prisma.mapNode.deleteMany({ where: { id: nodeId, mapId } });
    return result.count > 0;
  }

  async createDiscoveredLink(
    mapId: string,
    input: CreateLinkInput,
    discoverySource: NetworkLink['discoverySource'],
  ): Promise<NetworkLink | null> {
    const map = await this.prisma.map.findUnique({ where: { id: mapId }, select: { id: true } });
    if (!map) return null;
    const row = await this.prisma.link.create({
      data: {
        mapId,
        sourceDeviceId: input.sourceDeviceId ?? null,
        sourceInterfaceId: input.sourceInterfaceId ?? null,
        targetDeviceId: input.targetDeviceId ?? null,
        targetInterfaceId: input.targetInterfaceId ?? null,
        sourceNodeId: input.sourceNodeId ?? null,
        targetNodeId: input.targetNodeId ?? null,
        capacityBps: BigInt(Math.max(1, Math.trunc(input.capacityBps))),
        autoCapacityBps: BigInt(Math.max(1, Math.trunc(input.autoCapacityBps))),
        capacitySource: input.capacitySource,
        label: input.label,
        status: 'UNKNOWN',
        discoverySource,
        metricSource: input.metricSource,
        visualStyle: input.visualStyle,
        metricDisplay: input.metricDisplay,
      },
    });
    return this.materializeLink(row, await this.hosts.listHosts());
  }

  async updateLink(mapId: string, linkId: string, input: Pick<CreateLinkInput, 'capacityBps' | 'autoCapacityBps' | 'capacitySource' | 'label' | 'metricSource' | 'visualStyle' | 'metricDisplay'>): Promise<NetworkLink | null> {
    const result = await this.prisma.link.updateMany({
      where: { id: linkId, mapId },
      data: {
        capacityBps: BigInt(Math.max(1, Math.trunc(input.capacityBps))),
        autoCapacityBps: BigInt(Math.max(1, Math.trunc(input.autoCapacityBps))),
        capacitySource: input.capacitySource,
        label: input.label,
        metricSource: input.metricSource,
        visualStyle: input.visualStyle,
        metricDisplay: input.metricDisplay,
      },
    });
    if (!result.count) return null;
    const row = await this.prisma.link.findUnique({ where: { id: linkId } });
    return row ? this.materializeLink(row, await this.hosts.listHosts()) : null;
  }

  async deleteLink(mapId: string, linkId: string): Promise<boolean> {
    const result = await this.prisma.link.deleteMany({ where: { id: linkId, mapId } });
    return result.count > 0;
  }

  async deleteDevice(mapId: string, deviceId: string): Promise<boolean> {
    const result = await this.prisma.mapNode.deleteMany({ where: { mapId, deviceId } });
    return result.count > 0;
  }

  private async materialize(row: {
    id: string;
    name: string;
    description: string;
    mode: string;
    isDefault: boolean;
    nodeDisplayMode: string;
    linkDisplayStyle: string;
    linkMetricDisplay: string;
    nodeScale: number;
    linkScale: number;
    labelScale: number;
    viewport: unknown;
    filters: unknown;
    nodes: Array<{ id: string; mapId: string; deviceId: string | null; nodeKind: string; genericType: string | null; label: string | null; x: number; y: number; locked: boolean; positionSource: string }>;
    links: Array<{
      id: string; mapId: string; sourceDeviceId: string | null; sourceInterfaceId: string | null; targetDeviceId: string | null; targetInterfaceId: string | null; sourceNodeId: string | null; targetNodeId: string | null;
      capacityBps: bigint; autoCapacityBps: bigint | null; capacitySource: string; label: string | null; status: string;
      discoverySource: string; metricSource: string; visualStyle: string | null; metricDisplay: string | null; createdAt: Date; updatedAt: Date;
    }>;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<NetworkMap> {
    const devices = await this.hosts.listHosts();
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      mode: row.mode as NetworkMap['mode'],
      isDefault: row.isDefault,
      settings: settingsFromRow(row),
      nodes: row.nodes.map(nodeFromRow),
      devices,
      links: row.links.map((link) => this.materializeLink(link, devices)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private materializeLink(row: {
    id: string; mapId: string; sourceDeviceId: string | null; sourceInterfaceId: string | null; targetDeviceId: string | null; targetInterfaceId: string | null; sourceNodeId: string | null; targetNodeId: string | null;
    capacityBps: bigint; autoCapacityBps: bigint | null; capacitySource: string; label: string | null; status: string;
    discoverySource: string; metricSource: string; visualStyle: string | null; metricDisplay: string | null; createdAt: Date; updatedAt: Date;
  }, devices: HostRecord[]): NetworkLink {
    const source = row.sourceDeviceId
      ? devices.find((device) => device.id === row.sourceDeviceId)?.interfaces.find((item) => item.id === row.sourceInterfaceId)
      : undefined;
    const target = row.targetDeviceId
      ? devices.find((device) => device.id === row.targetDeviceId)?.interfaces.find((item) => item.id === row.targetInterfaceId)
      : undefined;
    const capacityBps = safeNumber(row.capacityBps);
    const aToB = source ? source.txBps : target?.rxBps ?? 0;
    const bToA = source ? source.rxBps : target?.txBps ?? 0;
    return {
      id: row.id,
      mapId: row.mapId,
      sourceDeviceId: row.sourceDeviceId,
      sourceInterfaceId: row.sourceInterfaceId,
      targetDeviceId: row.targetDeviceId,
      targetInterfaceId: row.targetInterfaceId,
      sourceNodeId: row.sourceNodeId,
      targetNodeId: row.targetNodeId,
      capacityBps,
      autoCapacityBps: safeNumber(row.autoCapacityBps) || capacityBps,
      capacitySource: row.capacitySource as NetworkLink['capacitySource'],
      label: row.label ?? '',
      status: linkStatus(source, target),
      discoverySource: row.discoverySource as NetworkLink['discoverySource'],
      metricSource: row.metricSource as NetworkLink['metricSource'],
      visualStyle: row.visualStyle as NetworkLink['visualStyle'],
      metricDisplay: row.metricDisplay as NetworkLink['metricDisplay'],
      directions: {
        A_TO_B: { bps: aToB, utilization: calculateUtilization(aToB, capacityBps) },
        B_TO_A: { bps: bToA, utilization: calculateUtilization(bToA, capacityBps) },
      },
      rxBps: bToA,
      txBps: aToB,
      rxUtilization: calculateUtilization(bToA, capacityBps),
      txUtilization: calculateUtilization(aToB, capacityBps),
      rxErrors: source?.rxErrors ?? target?.txErrors ?? 0,
      txErrors: source?.txErrors ?? target?.rxErrors ?? 0,
      rxDiscards: source?.rxDiscards ?? target?.txDiscards ?? 0,
      txDiscards: source?.txDiscards ?? target?.rxDiscards ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}