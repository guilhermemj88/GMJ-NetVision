import {
  aggregateLinkMetrics,
  automaticLinkCapacity,
  createLocalId,
  defaultPppTotalSettings,
  defaultVisualPaths,
  type AddDeviceResult,
  type CreateGenericNodeInput,
  type CreateLinkInput,
  type CreateMapInput,
  type HostRecord,
  type LinkInterfaceResolver,
  type LinkMetricSource,
  type LinkVisualPath,
  type MapNode,
  type MapPlaylist,
  type MapSettings,
  type MapSummary,
  type MapWidget,
  type NetworkInterface,
  type NetworkLink,
  type NetworkMap,
  type PppDisplayMode,
  type PppLabelPosition,
  type PppTotalWidgetSettings,
  type Position,
  type UpdateMapInput,
  type UpdateLinkInput,
  type UpdateMapNodePppInput,
  type UpdateMapWidgetInput,
  type UpsertMapWidgetInput,
} from '@gmj/shared';
import { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import type { HostRepository } from './host-repository';
import type { NodePositionUpdate } from './demo-map-repository';

const blankSettings: MapSettings = {
  nodeDisplayMode: 'ICON_2D',
  linkDisplayStyle: 'HYBRID',
  linkMetricDisplay: 'BOTH',
  trafficLabelMode: 'CARD',
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
  trafficLabelMode: string;
  nodeScale: number;
  linkScale: number;
  labelScale: number;
  viewport: unknown;
  filters: unknown;
}): MapSettings {
  const viewport =
    row.viewport && typeof row.viewport === 'object'
      ? (row.viewport as Partial<MapSettings['viewport']>)
      : {};
  const filters =
    row.filters && typeof row.filters === 'object'
      ? (row.filters as Partial<MapSettings['filters']>)
      : {};
  return {
    nodeDisplayMode: row.nodeDisplayMode as MapSettings['nodeDisplayMode'],
    linkDisplayStyle: row.linkDisplayStyle as MapSettings['linkDisplayStyle'],
    linkMetricDisplay: row.linkMetricDisplay as MapSettings['linkMetricDisplay'],
    trafficLabelMode: row.trafficLabelMode as MapSettings['trafficLabelMode'],
    nodeScale: row.nodeScale,
    linkScale: row.linkScale,
    labelScale: row.labelScale,
    viewport: { ...blankSettings.viewport, ...viewport },
    filters: { ...blankSettings.filters, ...filters },
  };
}

function normalizePppDisplayMode(value: unknown): PppDisplayMode {
  return value === 'SHOW' || value === 'HIDE' ? value : 'AUTO';
}

function normalizePppPosition(value: unknown): PppLabelPosition {
  return value === 'TOP' || value === 'LEFT' || value === 'RIGHT' || value === 'CENTER'
    ? value
    : 'BOTTOM';
}

function normalizePppColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function normalizePppFontSize(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(size)) return 14;
  return Math.min(32, Math.max(8, Math.trunc(size)));
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
  pppDisplayMode: string | null;
  pppPosition: string | null;
  pppColor: string | null;
  pppFontSize: number | null;
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
    pppDisplayMode: normalizePppDisplayMode(row.pppDisplayMode),
    pppPosition: normalizePppPosition(row.pppPosition),
    pppColor: normalizePppColor(row.pppColor),
    pppFontSize: normalizePppFontSize(row.pppFontSize),
  };
}

function normalizeWidgetSettings(value: unknown): PppTotalWidgetSettings {
  const defaults = defaultPppTotalSettings();
  if (typeof value !== 'object' || value === null) return defaults;
  const candidate = value as Record<string, unknown>;
  const selectedHostIds = Array.isArray(candidate.selectedHostIds)
    ? candidate.selectedHostIds.filter((item): item is string => typeof item === 'string')
    : defaults.selectedHostIds;
  const fontSize = Number(candidate.fontSize);
  const backgroundOpacity = Number(candidate.backgroundOpacity);
  return {
    mode: candidate.mode === 'MANUAL' ? 'MANUAL' : 'AUTO',
    selectedHostIds,
    title: typeof candidate.title === 'string' && candidate.title.trim()
      ? candidate.title
      : defaults.title,
    fontColor: normalizePppColor(candidate.fontColor),
    fontSize: Number.isFinite(fontSize)
      ? Math.min(64, Math.max(10, Math.trunc(fontSize)))
      : defaults.fontSize,
    backgroundColor: normalizePppColor(candidate.backgroundColor),
    backgroundOpacity: Number.isFinite(backgroundOpacity)
      ? Math.min(100, Math.max(0, Math.trunc(backgroundOpacity)))
      : defaults.backgroundOpacity,
    showHostCount: candidate.showHostCount !== false,
    showFreshness: candidate.showFreshness !== false,
  };
}

function widgetFromRow(row: {
  id: string;
  mapId: string;
  type: string;
  positionX: number;
  positionY: number;
  enabled: boolean;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}): MapWidget {
  return {
    id: row.id,
    mapId: row.mapId,
    type: 'PPP_TOTAL',
    positionX: row.positionX,
    positionY: row.positionY,
    enabled: row.enabled,
    settings: normalizeWidgetSettings(row.settings),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function findLinkInterface(
  devices: HostRecord[],
  deviceId: string | null,
  interfaceId: string | null,
): NetworkInterface | undefined {
  if (!interfaceId) return undefined;
  const scoped = deviceId
    ? devices
        .find((device) => device.id === deviceId)
        ?.interfaces.find((item) => item.id === interfaceId)
    : undefined;
  return (
    scoped ?? devices.flatMap((device) => device.interfaces).find((item) => item.id === interfaceId)
  );
}

function normalizeMetricSources(value: unknown): LinkMetricSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const candidate = entry as { interfaceId?: unknown; side?: unknown };
    const interfaceId = typeof candidate.interfaceId === 'string' ? candidate.interfaceId : '';
    const side =
      candidate.side === 'TARGET' ? 'TARGET' : candidate.side === 'SOURCE' ? 'SOURCE' : null;
    return interfaceId && side ? [{ interfaceId, side }] : [];
  });
}

function normalizeVisualPaths(value: unknown): LinkVisualPath[] {
  if (!Array.isArray(value)) return defaultVisualPaths(1);
  const paths = value.map((entry) => {
    const candidate = (typeof entry === 'object' && entry !== null ? entry : {}) as {
      order?: unknown;
      label?: unknown;
      customColor?: unknown;
      curvature?: unknown;
      enabled?: unknown;
    };
    return {
      order: typeof candidate.order === 'number' ? candidate.order : 0,
      label: typeof candidate.label === 'string' ? candidate.label : null,
      customColor:
        typeof candidate.customColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate.customColor)
          ? candidate.customColor
          : null,
      curvature:
        typeof candidate.curvature === 'number' && Number.isFinite(candidate.curvature)
          ? candidate.curvature
          : 0,
      enabled: candidate.enabled !== false,
    } satisfies LinkVisualPath;
  });
  return paths.length ? paths : defaultVisualPaths(1);
}

const INLINE_LABEL_POSITION_MIN = 0.1;
const INLINE_LABEL_POSITION_MAX = 0.9;

function normalizeInlineLabelPosition(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(INLINE_LABEL_POSITION_MAX, Math.max(INLINE_LABEL_POSITION_MIN, value));
}

function normalizeTrafficColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function asJson<T>(value: T): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
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
    const row = await this.prisma.map.findUnique({
      where: { id: mapId },
      include: { nodes: true, links: true, widgets: true },
    });
    return row ? this.materialize(row) : null;
  }

  async getDefaultMap(): Promise<NetworkMap | null> {
    const row = await this.prisma.map.findFirst({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { nodes: true, links: true, widgets: true },
    });
    return row ? this.materialize(row) : null;
  }

  async createMap(input: CreateMapInput): Promise<NetworkMap> {
    const source = input.sourceMapId
      ? await this.prisma.map.findUnique({
          where: { id: input.sourceMapId },
          include: { nodes: true, links: true },
        })
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
          ...(source
            ? {
                nodeDisplayMode: source.nodeDisplayMode,
                linkDisplayStyle: source.linkDisplayStyle,
                linkMetricDisplay: source.linkMetricDisplay,
                trafficLabelMode: source.trafficLabelMode,
                nodeScale: source.nodeScale,
                linkScale: source.linkScale,
                labelScale: source.labelScale,
              }
            : {}),
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
              trafficMode: link.trafficMode,
              customColor: link.customColor,
              trafficColorAToB: link.trafficColorAToB,
              trafficColorBToA: link.trafficColorBToA,
              inlineLabelPositionAToB: link.inlineLabelPositionAToB,
              inlineLabelPositionBToA: link.inlineLabelPositionBToA,
              animationEnabled: link.animationEnabled,
              label: link.label,
              status: link.status,
              discoverySource: link.discoverySource,
              metricSource: link.metricSource,
              visualStyle: link.visualStyle,
              metricDisplay: link.metricDisplay,
              aggregationMode: link.aggregationMode,
              metricSources: asJson(normalizeMetricSources(link.metricSources)),
              visualPaths: asJson(normalizeVisualPaths(link.visualPaths)),
            },
          });
        }
      }
      return tx.map.findUniqueOrThrow({
        where: { id: map.id },
        include: { nodes: true, links: true, widgets: true },
      });
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
          ...(settings?.nodeDisplayMode !== undefined
            ? { nodeDisplayMode: settings.nodeDisplayMode }
            : {}),
          ...(settings?.linkDisplayStyle !== undefined
            ? { linkDisplayStyle: settings.linkDisplayStyle }
            : {}),
          ...(settings?.linkMetricDisplay !== undefined
            ? { linkMetricDisplay: settings.linkMetricDisplay }
            : {}),
          ...(settings?.trafficLabelMode !== undefined
            ? { trafficLabelMode: settings.trafficLabelMode }
            : {}),
          ...(settings?.nodeScale !== undefined ? { nodeScale: settings.nodeScale } : {}),
          ...(settings?.linkScale !== undefined ? { linkScale: settings.linkScale } : {}),
          ...(settings?.labelScale !== undefined ? { labelScale: settings.labelScale } : {}),
          ...(settings?.viewport !== undefined
            ? { viewport: { ...((existing.viewport as object) ?? {}), ...settings.viewport } }
            : {}),
          ...(settings?.filters !== undefined
            ? { filters: { ...((existing.filters as object) ?? {}), ...settings.filters } }
            : {}),
        },
      });
    });
    return this.getMap(mapId);
  }

  async deleteMap(mapId: string): Promise<boolean> {
    if ((await this.prisma.map.count()) <= 1) return false;
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
    const rows = await this.prisma.mapPlaylist.findMany({
      include: { items: { orderBy: { order: 'asc' } } },
      orderBy: { name: 'asc' },
    });
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

  async savePlaylist(input: {
    id?: string;
    name: string;
    rotationIntervalSeconds: number;
    mapIds: string[];
    isDefault: boolean;
  }): Promise<MapPlaylist> {
    const id = input.id ?? createLocalId('playlist');
    const row = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.mapPlaylist.updateMany({ data: { isDefault: false } });
      await tx.mapPlaylist.upsert({
        where: { id },
        create: {
          id,
          name: input.name,
          rotationIntervalSeconds: input.rotationIntervalSeconds,
          isDefault: input.isDefault,
        },
        update: {
          name: input.name,
          rotationIntervalSeconds: input.rotationIntervalSeconds,
          isDefault: input.isDefault,
        },
      });
      await tx.mapPlaylistItem.deleteMany({ where: { playlistId: id } });
      if (input.mapIds.length)
        await tx.mapPlaylistItem.createMany({
          data: input.mapIds.map((mapId, order) => ({ playlistId: id, mapId, order })),
        });
      return tx.mapPlaylist.findUniqueOrThrow({
        where: { id },
        include: { items: { orderBy: { order: 'asc' } } },
      });
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
    if (!(await this.prisma.map.findUnique({ where: { id: mapId }, select: { id: true } })))
      return null;
    await this.prisma.$transaction(
      updates.map((update) =>
        this.prisma.mapNode.updateMany({
          where: { id: update.nodeId, mapId },
          data: {
            x: update.position.x,
            y: update.position.y,
            positionSource: update.positionSource ?? 'MANUAL',
            ...(update.locked === undefined ? {} : { locked: update.locked }),
          },
        }),
      ),
    );
    return this.getMap(mapId);
  }

  async setNodeLocked(mapId: string, nodeId: string, locked: boolean): Promise<NetworkMap | null> {
    const result = await this.prisma.mapNode.updateMany({
      where: { id: nodeId, mapId },
      data: { locked },
    });
    return result.count ? this.getMap(mapId) : null;
  }

  async addHostToMap(
    hostId: string,
    mapId: string,
    position: Position,
  ): Promise<AddDeviceResult | null> {
    const [host, map] = await Promise.all([
      this.hosts.getHost(hostId),
      this.prisma.map.findUnique({ where: { id: mapId }, select: { id: true } }),
    ]);
    if (!host || !map) return null;
    const node = await this.prisma.mapNode.upsert({
      where: { mapId_deviceId: { mapId, deviceId: hostId } },
      create: {
        mapId,
        deviceId: hostId,
        x: position.x,
        y: position.y,
        locked: false,
        positionSource: 'MANUAL',
      },
      update: {},
    });
    const refreshedHost = (await this.hosts.getHost(hostId)) ?? host;
    return { device: refreshedHost, node: nodeFromRow(node) };
  }

  async addHostsToMap(
    mapId: string,
    deviceIds: string[],
    seedPosition: Position = { x: 520, y: 340 },
  ): Promise<AddDeviceResult[]> {
    const created: AddDeviceResult[] = [];
    for (const [index, deviceId] of deviceIds.entries()) {
      const exists = await this.prisma.mapNode.findUnique({
        where: { mapId_deviceId: { mapId, deviceId } },
      });
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
        ...(input.trafficMode === undefined ? {} : { trafficMode: input.trafficMode }),
        ...(input.customColor === undefined ? {} : { customColor: input.customColor }),
        ...(input.trafficColorAToB === undefined
          ? {}
          : { trafficColorAToB: normalizeTrafficColor(input.trafficColorAToB) }),
        ...(input.trafficColorBToA === undefined
          ? {}
          : { trafficColorBToA: normalizeTrafficColor(input.trafficColorBToA) }),
        ...(input.inlineLabelPositionAToB === undefined
          ? {}
          : { inlineLabelPositionAToB: normalizeInlineLabelPosition(input.inlineLabelPositionAToB) }),
        ...(input.inlineLabelPositionBToA === undefined
          ? {}
          : { inlineLabelPositionBToA: normalizeInlineLabelPosition(input.inlineLabelPositionBToA) }),
        ...(input.animationEnabled === undefined
          ? {}
          : { animationEnabled: input.animationEnabled }),
        label: input.label,
        status: 'UNKNOWN',
        discoverySource,
        metricSource: input.metricSource,
        visualStyle: input.visualStyle,
        metricDisplay: input.metricDisplay,
        aggregationMode: input.aggregationMode ?? 'NONE',
        metricSources: asJson(input.metricSources ?? []),
        visualPaths: asJson(input.visualPaths ?? defaultVisualPaths(1)),
      },
    });
    return this.materializeLink(row, await this.hosts.listHosts());
  }

  async updateLink(
    mapId: string,
    linkId: string,
    input: UpdateLinkInput,
  ): Promise<NetworkLink | null> {
    const result = await this.prisma.link.updateMany({
      where: { id: linkId, mapId },
      data: {
        ...(input.sourceInterfaceId === undefined
          ? {}
          : { sourceInterfaceId: input.sourceInterfaceId }),
        ...(input.targetInterfaceId === undefined
          ? {}
          : { targetInterfaceId: input.targetInterfaceId }),
        capacityBps: BigInt(Math.max(1, Math.trunc(input.capacityBps))),
        autoCapacityBps: BigInt(Math.max(1, Math.trunc(input.autoCapacityBps))),
        capacitySource: input.capacitySource,
        ...(input.trafficMode === undefined ? {} : { trafficMode: input.trafficMode }),
        ...(input.customColor === undefined ? {} : { customColor: input.customColor }),
        ...(input.trafficColorAToB === undefined
          ? {}
          : { trafficColorAToB: normalizeTrafficColor(input.trafficColorAToB) }),
        ...(input.trafficColorBToA === undefined
          ? {}
          : { trafficColorBToA: normalizeTrafficColor(input.trafficColorBToA) }),
        ...(input.inlineLabelPositionAToB === undefined
          ? {}
          : { inlineLabelPositionAToB: normalizeInlineLabelPosition(input.inlineLabelPositionAToB) }),
        ...(input.inlineLabelPositionBToA === undefined
          ? {}
          : { inlineLabelPositionBToA: normalizeInlineLabelPosition(input.inlineLabelPositionBToA) }),
        ...(input.animationEnabled === undefined
          ? {}
          : { animationEnabled: input.animationEnabled }),
        label: input.label,
        metricSource: input.metricSource,
        visualStyle: input.visualStyle,
        metricDisplay: input.metricDisplay,
        ...(input.aggregationMode === undefined
          ? {}
          : { aggregationMode: input.aggregationMode }),
        ...(input.metricSources === undefined
          ? {}
          : { metricSources: asJson(input.metricSources) }),
        ...(input.visualPaths === undefined
          ? {}
          : { visualPaths: asJson(input.visualPaths) }),
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

  async updateNodePpp(
    mapId: string,
    nodeId: string,
    input: UpdateMapNodePppInput,
  ): Promise<NetworkMap | null> {
    const result = await this.prisma.mapNode.updateMany({
      where: { id: nodeId, mapId },
      data: {
        ...(input.pppDisplayMode === undefined ? {} : { pppDisplayMode: input.pppDisplayMode }),
        ...(input.pppPosition === undefined ? {} : { pppPosition: input.pppPosition }),
        ...(input.pppColor === undefined ? {} : { pppColor: input.pppColor }),
        ...(input.pppFontSize === undefined ? {} : { pppFontSize: input.pppFontSize }),
      },
    });
    return result.count ? this.getMap(mapId) : null;
  }

  async upsertWidget(mapId: string, input: UpsertMapWidgetInput): Promise<MapWidget | null> {
    const map = await this.prisma.map.findUnique({ where: { id: mapId }, select: { id: true } });
    if (!map) return null;
    const existing = await this.prisma.mapWidget.findUnique({
      where: { mapId_type: { mapId, type: input.type } },
    });
    const merged = {
      ...defaultPppTotalSettings(),
      ...(existing?.settings && typeof existing.settings === 'object' ? existing.settings : {}),
      ...(input.settings ?? {}),
    };
    const row = await this.prisma.mapWidget.upsert({
      where: { mapId_type: { mapId, type: input.type } },
      create: {
        mapId,
        type: input.type,
        positionX: input.positionX ?? 0,
        positionY: input.positionY ?? 0,
        enabled: input.enabled ?? true,
        settings: asJson(merged),
      },
      update: {
        ...(input.positionX === undefined ? {} : { positionX: input.positionX }),
        ...(input.positionY === undefined ? {} : { positionY: input.positionY }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.settings === undefined ? {} : { settings: asJson(merged) }),
      },
    });
    return widgetFromRow(row);
  }

  async updateWidget(
    mapId: string,
    widgetId: string,
    input: UpdateMapWidgetInput,
  ): Promise<MapWidget | null> {
    const existing = await this.prisma.mapWidget.findFirst({
      where: { id: widgetId, mapId },
    });
    if (!existing) return null;
    const merged = {
      ...defaultPppTotalSettings(),
      ...(existing.settings && typeof existing.settings === 'object' ? existing.settings : {}),
      ...(input.settings ?? {}),
    };
    const row = await this.prisma.mapWidget.update({
      where: { id: widgetId },
      data: {
        ...(input.positionX === undefined ? {} : { positionX: input.positionX }),
        ...(input.positionY === undefined ? {} : { positionY: input.positionY }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.settings === undefined ? {} : { settings: asJson(merged) }),
      },
    });
    return widgetFromRow(row);
  }

  async deleteWidget(mapId: string, widgetId: string): Promise<boolean> {
    const result = await this.prisma.mapWidget.deleteMany({ where: { id: widgetId, mapId } });
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
    trafficLabelMode: string;
    nodeScale: number;
    linkScale: number;
    labelScale: number;
    viewport: unknown;
    filters: unknown;
    nodes: Array<{
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
      pppDisplayMode: string | null;
      pppPosition: string | null;
      pppColor: string | null;
      pppFontSize: number | null;
    }>;
    widgets: Array<{
      id: string;
      mapId: string;
      type: string;
      positionX: number;
      positionY: number;
      enabled: boolean;
      settings: unknown;
      createdAt: Date;
      updatedAt: Date;
    }>;
    links: Array<{
      id: string;
      mapId: string;
      sourceDeviceId: string | null;
      sourceInterfaceId: string | null;
      targetDeviceId: string | null;
      targetInterfaceId: string | null;
      sourceNodeId: string | null;
      targetNodeId: string | null;
      capacityBps: bigint;
      autoCapacityBps: bigint | null;
      capacitySource: string;
      trafficMode: string;
      customColor: string | null;
      trafficColorAToB: string | null;
      trafficColorBToA: string | null;
      inlineLabelPositionAToB: number | null;
      inlineLabelPositionBToA: number | null;
      animationEnabled: boolean | null;
      label: string | null;
      status: string;
      discoverySource: string;
      metricSource: string;
      visualStyle: string | null;
      metricDisplay: string | null;
      aggregationMode: string;
      metricSources: unknown;
      visualPaths: unknown;
      createdAt: Date;
      updatedAt: Date;
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
      widgets: row.widgets.map(widgetFromRow),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private materializeLink(
    row: {
      id: string;
      mapId: string;
      sourceDeviceId: string | null;
      sourceInterfaceId: string | null;
      targetDeviceId: string | null;
      targetInterfaceId: string | null;
      sourceNodeId: string | null;
      targetNodeId: string | null;
      capacityBps: bigint;
      autoCapacityBps: bigint | null;
      capacitySource: string;
      trafficMode: string;
      customColor: string | null;
      trafficColorAToB: string | null;
      trafficColorBToA: string | null;
      inlineLabelPositionAToB: number | null;
      inlineLabelPositionBToA: number | null;
      animationEnabled: boolean | null;
      label: string | null;
      status: string;
      discoverySource: string;
      metricSource: string;
      visualStyle: string | null;
      metricDisplay: string | null;
      aggregationMode: string;
      metricSources: unknown;
      visualPaths: unknown;
      createdAt: Date;
      updatedAt: Date;
    },
    devices: HostRecord[],
  ): NetworkLink {
    const referenceSource = findLinkInterface(devices, row.sourceDeviceId, row.sourceInterfaceId);
    const referenceTarget = findLinkInterface(devices, row.targetDeviceId, row.targetInterfaceId);
    const trafficMode = row.trafficMode as NetworkLink['trafficMode'];
    const storedCapacityBps = safeNumber(row.capacityBps);
    const autoCapacityBps = automaticLinkCapacity(
      referenceSource,
      referenceTarget,
      trafficMode,
      safeNumber(row.autoCapacityBps) || storedCapacityBps,
    );
    const capacityBps = row.capacitySource === 'AUTO' ? autoCapacityBps : storedCapacityBps;
    const aggregationMode = (row.aggregationMode ?? 'NONE') as NetworkLink['aggregationMode'];
    const metricSources = normalizeMetricSources(row.metricSources);
    const visualPaths = normalizeVisualPaths(row.visualPaths);
    const resolver: LinkInterfaceResolver = (deviceId, interfaceId) =>
      findLinkInterface(devices, deviceId ?? null, interfaceId ?? null);
    const metrics = aggregateLinkMetrics(
      {
        sourceDeviceId: row.sourceDeviceId,
        targetDeviceId: row.targetDeviceId,
        sourceInterfaceId: row.sourceInterfaceId,
        targetInterfaceId: row.targetInterfaceId,
        aggregationMode,
        metricSources,
        trafficMode,
        capacityBps,
      },
      resolver,
    );
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
      autoCapacityBps,
      capacitySource: row.capacitySource as NetworkLink['capacitySource'],
      trafficMode,
      customColor: row.customColor,
      trafficColorAToB: normalizeTrafficColor(row.trafficColorAToB),
      trafficColorBToA: normalizeTrafficColor(row.trafficColorBToA),
      inlineLabelPositionAToB: normalizeInlineLabelPosition(row.inlineLabelPositionAToB),
      inlineLabelPositionBToA: normalizeInlineLabelPosition(row.inlineLabelPositionBToA),
      animationEnabled: row.animationEnabled,
      label: row.label ?? '',
      status: metrics.status,
      discoverySource: row.discoverySource as NetworkLink['discoverySource'],
      metricSource: row.metricSource as NetworkLink['metricSource'],
      visualStyle: row.visualStyle as NetworkLink['visualStyle'],
      metricDisplay: row.metricDisplay as NetworkLink['metricDisplay'],
      aggregationMode,
      metricSources,
      visualPaths,
      directions: metrics.directions,
      rxBps: metrics.rxBps,
      txBps: metrics.txBps,
      rxUtilization: metrics.rxUtilization,
      txUtilization: metrics.txUtilization,
      rxErrors: metrics.rxErrors,
      txErrors: metrics.txErrors,
      rxDiscards: metrics.rxDiscards,
      txDiscards: metrics.txDiscards,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
