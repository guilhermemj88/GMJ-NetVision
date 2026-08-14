import {
  calculateUtilization,
  cloneDemoMaps,
  createLocalId,
  type AddDeviceResult,
  type CreateLinkInput,
  type CreateMapInput,
  type Device,
  type DeviceType,
  type MapPlaylist,
  type MapSettings,
  type MapSummary,
  type NetworkLink,
  type NetworkMap,
  type Position,
  type UpdateMapInput,
} from '@gmj/shared';

export interface NodePositionUpdate {
  nodeId: string;
  position: Position;
  locked?: boolean;
}

export interface CreateDeviceInput {
  name: string;
  hostname: string;
  ip: string;
  vendor: string;
  model: string;
  site: string;
  deviceType: DeviceType;
  position: Position;
}

type StoredMap = Omit<NetworkMap, 'devices'>;

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
  },
  viewport: { x: 0, y: 0, zoom: 1 },
};

export class DemoMapRepository {
  private readonly devices: Device[];
  private maps: StoredMap[];
  private playlists: MapPlaylist[];

  constructor() {
    const maps = cloneDemoMaps();
    this.devices = structuredClone(maps[0]?.devices ?? []);
    this.maps = maps.map(({ devices: _devices, ...map }) => map);
    const timestamp = new Date().toISOString();
    this.playlists = [
      {
        id: 'noc-main',
        name: 'NOC Principal',
        rotationIntervalSeconds: 60,
        isDefault: true,
        items: this.maps.map((map, order) => ({ mapId: map.id, order })),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
  }

  listMaps(): MapSummary[] {
    return this.maps.map((map) => this.summary(map));
  }

  getMap(mapId: string): NetworkMap | null {
    const map = this.findMap(mapId);
    return map ? this.materialize(map) : null;
  }

  getDefaultMap(): NetworkMap | null {
    const map = this.maps.find((item) => item.isDefault) ?? this.maps[0];
    return map ? this.materialize(map) : null;
  }

  createMap(input: CreateMapInput): NetworkMap {
    const timestamp = new Date().toISOString();
    const id = createLocalId('map');
    const source = input.sourceMapId ? this.findMap(input.sourceMapId) : undefined;
    const map: StoredMap = source
      ? {
          ...structuredClone(source),
          id,
          name: input.name,
          description: input.description,
          mode: input.mode,
          isDefault: false,
          nodes: source.nodes.map((node) => ({
            ...node,
            id: createLocalId('node'),
            mapId: id,
          })),
          links: source.links.map((link) => ({
            ...link,
            id: createLocalId('link'),
            mapId: id,
            createdAt: timestamp,
            updatedAt: timestamp,
          })),
          createdAt: timestamp,
          updatedAt: timestamp,
        }
      : {
          id,
          name: input.name,
          description: input.description,
          mode: input.mode,
          isDefault: this.maps.length === 0,
          settings: structuredClone(blankSettings),
          nodes: [],
          links: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    this.maps.push(map);
    return this.materialize(map);
  }

  updateMap(mapId: string, input: UpdateMapInput): NetworkMap | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    if (input.name !== undefined) map.name = input.name;
    if (input.description !== undefined) map.description = input.description;
    if (input.mode !== undefined) map.mode = input.mode;
    if (input.settings) {
      map.settings = {
        ...map.settings,
        ...input.settings,
        filters: { ...map.settings.filters, ...input.settings.filters },
        viewport: { ...map.settings.viewport, ...input.settings.viewport },
      };
    }
    if (input.isDefault) {
      this.maps.forEach((item) => {
        item.isDefault = item.id === mapId;
      });
    }
    this.touch(map);
    return this.materialize(map);
  }

  deleteMap(mapId: string): boolean {
    if (this.maps.length <= 1) return false;
    const map = this.findMap(mapId);
    if (!map) return false;
    this.maps = this.maps.filter((item) => item.id !== mapId);
    this.playlists = this.playlists.map((playlist) => ({
      ...playlist,
      items: playlist.items
        .filter((item) => item.mapId !== mapId)
        .map((item, order) => ({ ...item, order })),
      updatedAt: new Date().toISOString(),
    }));
    if (map.isDefault && this.maps[0]) this.maps[0].isDefault = true;
    return true;
  }

  listPlaylists(): MapPlaylist[] {
    return structuredClone(this.playlists);
  }

  savePlaylist(input: {
    id?: string;
    name: string;
    rotationIntervalSeconds: number;
    mapIds: string[];
    isDefault: boolean;
  }): MapPlaylist {
    const timestamp = new Date().toISOString();
    const existing = input.id ? this.playlists.find((item) => item.id === input.id) : undefined;
    if (input.isDefault) {
      this.playlists = this.playlists.map((item) => ({ ...item, isDefault: false }));
    }
    const playlist: MapPlaylist = {
      id: existing?.id ?? createLocalId('playlist'),
      name: input.name,
      rotationIntervalSeconds: input.rotationIntervalSeconds,
      isDefault: input.isDefault,
      items: input.mapIds.map((mapId, order) => ({ mapId, order })),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.playlists = existing
      ? this.playlists.map((item) => (item.id === existing.id ? playlist : item))
      : [...this.playlists, playlist];
    return structuredClone(playlist);
  }

  updatePositions(mapId: string, updates: NodePositionUpdate[]): NetworkMap | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const byId = new Map(updates.map((item) => [item.nodeId, item]));
    map.nodes = map.nodes.map((node) => {
      const update = byId.get(node.id);
      if (!update) return node;
      return {
        ...node,
        position: update.position,
        positionSource: 'MANUAL',
        ...(update.locked === undefined ? {} : { locked: update.locked }),
      };
    });
    this.touch(map);
    return this.materialize(map);
  }

  setNodeLocked(mapId: string, nodeId: string, locked: boolean): NetworkMap | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    map.nodes = map.nodes.map((node) => (node.id === nodeId ? { ...node, locked } : node));
    this.touch(map);
    return this.materialize(map);
  }

  createLink(mapId: string, input: CreateLinkInput): NetworkLink | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const timestamp = new Date().toISOString();
    const link: NetworkLink = {
      id: createLocalId('link'),
      mapId,
      ...input,
      status: 'UP',
      discoverySource: 'MANUAL',
      directions: {
        A_TO_B: { bps: 0, utilization: 0 },
        B_TO_A: { bps: 0, utilization: 0 },
      },
      rxBps: 0,
      txBps: 0,
      rxUtilization: 0,
      txUtilization: 0,
      rxErrors: 0,
      txErrors: 0,
      rxDiscards: 0,
      txDiscards: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    map.links.push(link);
    this.touch(map);
    return structuredClone(link);
  }

  updateLink(
    mapId: string,
    linkId: string,
    input: Pick<
      CreateLinkInput,
      | 'capacityBps'
      | 'autoCapacityBps'
      | 'capacitySource'
      | 'label'
      | 'metricSource'
      | 'visualStyle'
      | 'metricDisplay'
    >,
  ): NetworkLink | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const link = map.links.find((item) => item.id === linkId);
    if (!link) return null;
    Object.assign(link, input, { updatedAt: new Date().toISOString() });
    link.directions = {
      A_TO_B: {
        ...link.directions.A_TO_B,
        utilization: calculateUtilization(link.directions.A_TO_B.bps, link.capacityBps),
      },
      B_TO_A: {
        ...link.directions.B_TO_A,
        utilization: calculateUtilization(link.directions.B_TO_A.bps, link.capacityBps),
      },
    };
    link.txUtilization = link.directions.A_TO_B.utilization;
    link.rxUtilization = link.directions.B_TO_A.utilization;
    this.touch(map);
    return structuredClone(link);
  }

  deleteLink(mapId: string, linkId: string): boolean {
    const map = this.findMap(mapId);
    if (!map) return false;
    const count = map.links.length;
    map.links = map.links.filter((item) => item.id !== linkId);
    if (count === map.links.length) return false;
    this.touch(map);
    return true;
  }

  addDevice(mapId: string, input: CreateDeviceInput): AddDeviceResult | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const id = createLocalId('device');
    const timestamp = new Date().toISOString();
    const device: Device = {
      id,
      name: input.name,
      hostname: input.hostname,
      ip: input.ip,
      vendor: input.vendor,
      model: input.model,
      site: input.site,
      status: 'UNKNOWN',
      deviceType: input.deviceType,
      source: 'MANUAL',
      discoveryMethod: 'MANUAL',
      uptimeSeconds: 0,
      updatedAt: timestamp,
      interfaces: Array.from({ length: 2 }, (_, index) => ({
        id: `${id}-if-${index + 1}`,
        deviceId: id,
        name: `GE0/0/${index + 1}`,
        alias: '',
        description: 'Manual interface',
        ifIndex: index + 1,
        mac: '',
        mtu: 1500,
        speedBps: 1_000_000_000,
        adminStatus: 'UP',
        operStatus: 'UNKNOWN',
        rxBps: 0,
        txBps: 0,
        rxUtilization: 0,
        txUtilization: 0,
        rxErrors: 0,
        txErrors: 0,
        rxDiscards: 0,
        txDiscards: 0,
      })),
    };
    this.devices.push(device);
    const node = {
      id: createLocalId('node'),
      mapId,
      deviceId: id,
      position: input.position,
      locked: false,
      positionSource: 'MANUAL' as const,
    };
    map.nodes.push(node);
    this.touch(map);
    return structuredClone({ device, node });
  }

  deleteDevice(mapId: string, deviceId: string): boolean {
    const map = this.findMap(mapId);
    if (!map || !map.nodes.some((item) => item.deviceId === deviceId)) return false;
    // Device is global; removing it here only removes its membership from this map.
    map.nodes = map.nodes.filter((item) => item.deviceId !== deviceId);
    map.links = map.links.filter(
      (item) => item.sourceDeviceId !== deviceId && item.targetDeviceId !== deviceId,
    );
    this.touch(map);
    return true;
  }

  private findMap(mapId: string): StoredMap | undefined {
    return this.maps.find((item) => item.id === mapId);
  }

  private materialize(map: StoredMap): NetworkMap {
    return structuredClone({ ...map, devices: this.devices });
  }

  private summary(map: StoredMap): MapSummary {
    return {
      id: map.id,
      name: map.name,
      description: map.description,
      mode: map.mode,
      isDefault: map.isDefault,
      nodeCount: map.nodes.length,
      linkCount: map.links.length,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    };
  }

  private touch(map: StoredMap): void {
    map.updatedAt = new Date().toISOString();
  }
}
