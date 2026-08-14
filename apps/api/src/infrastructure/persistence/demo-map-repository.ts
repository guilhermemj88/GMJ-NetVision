import {
  cloneDemoMap,
  type CreateLinkInput,
  type Device,
  type DeviceType,
  type NetworkLink,
  type NetworkMap,
  type Position,
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

export class DemoMapRepository {
  private map = cloneDemoMap();

  getMap(mapId: string): NetworkMap | null {
    return mapId === this.map.id ? structuredClone(this.map) : null;
  }

  updatePositions(mapId: string, updates: NodePositionUpdate[]): NetworkMap | null {
    if (mapId !== this.map.id) return null;
    const byId = new Map(updates.map((item) => [item.nodeId, item]));
    this.map.nodes = this.map.nodes.map((node) => {
      const update = byId.get(node.id);
      if (!update) return node;
      return {
        ...node,
        position: update.position,
        positionSource: 'MANUAL',
        ...(update.locked === undefined ? {} : { locked: update.locked }),
      };
    });
    this.touch();
    return structuredClone(this.map);
  }

  setNodeLocked(mapId: string, nodeId: string, locked: boolean): NetworkMap | null {
    if (mapId !== this.map.id) return null;
    this.map.nodes = this.map.nodes.map((node) =>
      node.id === nodeId ? { ...node, locked } : node,
    );
    this.touch();
    return structuredClone(this.map);
  }

  createLink(mapId: string, input: CreateLinkInput): NetworkLink | null {
    if (mapId !== this.map.id) return null;
    const timestamp = new Date().toISOString();
    const link: NetworkLink = {
      id: `manual-${crypto.randomUUID()}`,
      mapId,
      ...input,
      status: 'UP',
      discoverySource: 'MANUAL',
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
    this.map.links.push(link);
    this.touch();
    return structuredClone(link);
  }

  updateLink(
    mapId: string,
    linkId: string,
    input: Pick<CreateLinkInput, 'capacityBps' | 'label' | 'metricSource'>,
  ): NetworkLink | null {
    if (mapId !== this.map.id) return null;
    const link = this.map.links.find((item) => item.id === linkId);
    if (!link) return null;
    Object.assign(link, input, { updatedAt: new Date().toISOString() });
    this.touch();
    return structuredClone(link);
  }

  deleteLink(mapId: string, linkId: string): boolean {
    if (mapId !== this.map.id) return false;
    const count = this.map.links.length;
    this.map.links = this.map.links.filter((item) => item.id !== linkId);
    if (count === this.map.links.length) return false;
    this.touch();
    return true;
  }

  addDevice(mapId: string, input: CreateDeviceInput): Device | null {
    if (mapId !== this.map.id) return null;
    const id = `manual-${crypto.randomUUID()}`;
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
    this.map.devices.push(device);
    this.map.nodes.push({
      id: `node-${id}`,
      mapId,
      deviceId: id,
      position: input.position,
      locked: false,
      positionSource: 'MANUAL',
    });
    this.touch();
    return structuredClone(device);
  }

  deleteDevice(mapId: string, deviceId: string): boolean {
    if (mapId !== this.map.id) return false;
    if (!this.map.devices.some((item) => item.id === deviceId)) return false;
    this.map.devices = this.map.devices.filter((item) => item.id !== deviceId);
    this.map.nodes = this.map.nodes.filter((item) => item.deviceId !== deviceId);
    this.map.links = this.map.links.filter(
      (item) => item.sourceDeviceId !== deviceId && item.targetDeviceId !== deviceId,
    );
    this.touch();
    return true;
  }

  private touch(): void {
    this.map.updatedAt = new Date().toISOString();
  }
}
