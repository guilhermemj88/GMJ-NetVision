import { randomUUID } from 'node:crypto';
import type {
  CreatePhysicalAssetInput,
  CreatePhysicalConnectionInput,
  CreatePhysicalPortInput,
  CreatePhysicalRackInput,
  CreatePhysicalSiteInput,
  HostRecord,
  NetworkInterface,
  PhysicalAsset,
  PhysicalConnection,
  PhysicalConnectionEndpoint,
  PhysicalDeviceReference,
  PhysicalEquipmentTemplate,
  PhysicalInterfaceReference,
  PhysicalInventory,
  PhysicalPort,
  PhysicalRack,
  PhysicalSite,
} from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import type {
  CreatePhysicalTemplateInput,
  PhysicalRepository,
  UpdatePhysicalAssetInput,
  UpdatePhysicalRackInput,
  UpdatePhysicalSiteInput,
} from './physical-repository';

const now = () => new Date().toISOString();
const id = (kind: string) => `${kind}-${randomUUID()}`;
const clone = <T>(value: T): T => structuredClone(value);

function deviceReference(host: HostRecord): PhysicalDeviceReference {
  return {
    id: host.id,
    displayName: host.displayName,
    hostname: host.hostname,
    vendor: host.vendor || null,
    model: host.model || null,
    status: host.status,
  };
}

function interfaceReference(item: NetworkInterface): PhysicalInterfaceReference {
  return {
    id: item.id,
    deviceId: item.deviceId,
    name: item.name,
    ifIndex: item.ifIndex,
    alias: item.alias || null,
    operStatus: item.operStatus,
  };
}

export class DemoPhysicalRepository implements PhysicalRepository {
  private readonly sites = new Map<string, PhysicalSite>();
  private readonly racks = new Map<string, PhysicalRack>();
  private readonly assets = new Map<string, PhysicalAsset>();
  private readonly ports = new Map<string, PhysicalPort>();
  private readonly templates = new Map<string, PhysicalEquipmentTemplate>();
  private readonly connections = new Map<string, PhysicalConnection>();

  constructor(private readonly hosts: HostRepository) {}

  async getInventory(): Promise<PhysicalInventory> {
    const sites = [...this.sites.values()].map((site) => ({
      ...site,
      racks: [...this.racks.values()]
        .filter((rack) => rack.siteId === site.id)
        .map((rack) => ({
          ...rack,
          assets: [...this.assets.values()]
            .filter((asset) => asset.rackId === rack.id)
            .map((asset) => ({
              ...asset,
              ports: [...this.ports.values()]
                .filter((port) => port.assetId === asset.id)
                .sort((a, b) => a.order - b.order),
            }))
            .sort((a, b) => b.startU - a.startU),
        })),
    }));
    return clone({
      sites,
      templates: [...this.templates.values()],
      connections: [...this.connections.values()],
    });
  }

  async createSite(input: CreatePhysicalSiteInput): Promise<PhysicalSite> {
    const timestamp = now();
    const site: PhysicalSite = {
      id: id('site'),
      name: input.name.trim(),
      code: input.code?.trim() ?? '',
      description: input.description?.trim() ?? '',
      racks: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sites.set(site.id, site);
    return clone(site);
  }

  async updateSite(idValue: string, input: UpdatePhysicalSiteInput): Promise<PhysicalSite | null> {
    const site = this.sites.get(idValue);
    if (!site) return null;
    Object.assign(site, {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.code === undefined ? {} : { code: input.code?.trim() ?? '' }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      updatedAt: now(),
    });
    return clone(site);
  }

  async deleteSite(idValue: string): Promise<boolean> {
    return this.sites.delete(idValue);
  }

  async createRack(siteId: string, input: CreatePhysicalRackInput): Promise<PhysicalRack | null> {
    if (!this.sites.has(siteId)) return null;
    const timestamp = now();
    const rack: PhysicalRack = {
      id: id('rack'),
      siteId,
      name: input.name.trim(),
      units: input.units ?? 42,
      description: input.description?.trim() ?? '',
      assets: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.racks.set(rack.id, rack);
    return clone(rack);
  }

  async updateRack(idValue: string, input: UpdatePhysicalRackInput): Promise<PhysicalRack | null> {
    const rack = this.racks.get(idValue);
    if (!rack) return null;
    Object.assign(rack, {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.units === undefined ? {} : { units: input.units }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      updatedAt: now(),
    });
    return clone(rack);
  }

  async deleteRack(idValue: string): Promise<boolean> {
    return this.racks.delete(idValue);
  }

  async createTemplate(input: CreatePhysicalTemplateInput): Promise<PhysicalEquipmentTemplate> {
    const timestamp = now();
    const templateId = id('template');
    const ports = (input.ports ?? []).map((port) => ({
      id: id('template-port'),
      name: port.name.trim(),
      label: port.label?.trim() ?? '',
      order: port.order,
      side: port.side ?? 'DEVICE',
      type: port.type ?? 'OTHER',
      pairedTemplatePortId: null,
    }));
    const template: PhysicalEquipmentTemplate = {
      id: templateId,
      name: input.name.trim(),
      manufacturer: input.manufacturer?.trim() ?? '',
      model: input.model?.trim() ?? '',
      kind: input.kind ?? 'GENERIC',
      heightU: input.heightU ?? 1,
      description: input.description?.trim() ?? '',
      vendorVerified: false,
      ports,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.templates.set(template.id, template);
    return clone(template);
  }

  async createAsset(
    rackId: string,
    input: CreatePhysicalAssetInput,
  ): Promise<PhysicalAsset | null> {
    if (!this.racks.has(rackId)) return null;
    const host = input.deviceId ? await this.hosts.getHost(input.deviceId) : null;
    if (input.deviceId && !host) return null;
    const template = input.templateId ? this.templates.get(input.templateId) : null;
    if (input.templateId && !template) return null;
    const timestamp = now();
    const asset: PhysicalAsset = {
      id: id('asset'),
      rackId,
      deviceId: host?.id ?? null,
      templateId: template?.id ?? null,
      name: input.name.trim(),
      kind: input.kind ?? template?.kind ?? 'GENERIC',
      startU: input.startU,
      heightU: input.heightU,
      description: input.description?.trim() ?? '',
      device: host ? deviceReference(host) : null,
      template: template ? clone(template) : null,
      ports: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.assets.set(asset.id, asset);

    if (template) {
      for (const templatePort of template.ports) {
        await this.createPort(asset.id, {
          name: templatePort.name,
          label: templatePort.label,
          order: templatePort.order,
          side: templatePort.side,
          type: templatePort.type,
        });
      }
    } else if (input.genericPorts) {
      for (let index = 1; index <= input.genericPorts.count; index += 1) {
        const prefix = input.genericPorts.prefix?.trim() ?? '';
        await this.createPort(asset.id, {
          name: `${prefix}${index}`,
          order: index,
          side: input.genericPorts.side ?? 'DEVICE',
          type: input.genericPorts.type ?? 'OTHER',
        });
      }
    }
    return clone({ ...asset, ports: [...this.ports.values()].filter((port) => port.assetId === asset.id) });
  }

  async updateAsset(idValue: string, input: UpdatePhysicalAssetInput): Promise<PhysicalAsset | null> {
    const asset = this.assets.get(idValue);
    if (!asset) return null;
    const host = input.deviceId ? await this.hosts.getHost(input.deviceId) : null;
    if (input.deviceId && !host) return null;
    const template = input.templateId ? this.templates.get(input.templateId) : null;
    if (input.templateId && !template) return null;
    Object.assign(asset, {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.startU === undefined ? {} : { startU: input.startU }),
      ...(input.heightU === undefined ? {} : { heightU: input.heightU }),
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(input.deviceId === undefined
        ? {}
        : { deviceId: host?.id ?? null, device: host ? deviceReference(host) : null }),
      ...(input.templateId === undefined
        ? {}
        : { templateId: template?.id ?? null, template: template ? clone(template) : null }),
      updatedAt: now(),
    });
    return clone(asset);
  }

  async deleteAsset(idValue: string): Promise<boolean> {
    for (const port of [...this.ports.values()]) {
      if (port.assetId === idValue) this.ports.delete(port.id);
    }
    return this.assets.delete(idValue);
  }

  private async mappedInterface(
    asset: PhysicalAsset,
    interfaceId: string | null | undefined,
  ): Promise<PhysicalInterfaceReference | null | undefined> {
    if (!interfaceId) return null;
    if (!asset.deviceId) return undefined;
    const host = await this.hosts.getHost(asset.deviceId);
    const item = host?.interfaces.find((candidate) => candidate.id === interfaceId);
    return item ? interfaceReference(item) : undefined;
  }

  async createPort(assetId: string, input: CreatePhysicalPortInput): Promise<PhysicalPort | null> {
    const asset = this.assets.get(assetId);
    if (!asset) return null;
    const mapped = await this.mappedInterface(asset, input.mappedInterfaceId);
    if (mapped === undefined) return null;
    const timestamp = now();
    const port: PhysicalPort = {
      id: id('port'),
      assetId,
      name: input.name.trim(),
      label: input.label?.trim() ?? '',
      order: input.order,
      side: input.side ?? 'DEVICE',
      type: input.type ?? 'OTHER',
      notes: input.notes?.trim() ?? '',
      pairedPortId: input.pairedPortId ?? null,
      templatePortId: null,
      mappedInterfaceId: mapped?.id ?? null,
      mappedInterface: mapped ?? null,
      connectionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.ports.set(port.id, port);
    return clone(port);
  }

  async pairPorts(portId: string, pairedPortId: string): Promise<[PhysicalPort, PhysicalPort] | null> {
    const a = this.ports.get(portId);
    const b = this.ports.get(pairedPortId);
    if (!a || !b) return null;
    a.pairedPortId = b.id;
    b.pairedPortId = a.id;
    a.updatedAt = now();
    b.updatedAt = a.updatedAt;
    return [clone(a), clone(b)];
  }

  async syncInterfacePorts(assetId: string): Promise<PhysicalPort[] | null> {
    const asset = this.assets.get(assetId);
    if (!asset?.deviceId) return null;
    const host = await this.hosts.getHost(asset.deviceId);
    if (!host) return null;
    const existing = new Map(
      [...this.ports.values()]
        .filter((port) => port.assetId === assetId && port.mappedInterfaceId)
        .map((port) => [port.mappedInterfaceId, port]),
    );
    let order = Math.max(0, ...[...this.ports.values()].filter((port) => port.assetId === assetId).map((port) => port.order));
    for (const item of [...host.interfaces].sort((a, b) => a.ifIndex - b.ifIndex)) {
      if (existing.has(item.id)) continue;
      order += 1;
      await this.createPort(assetId, {
        name: item.name,
        label: item.alias ?? '',
        order,
        side: 'DEVICE',
        type: 'OTHER',
        mappedInterfaceId: item.id,
      });
    }
    return clone([...this.ports.values()].filter((port) => port.assetId === assetId));
  }

  private endpoint(port: PhysicalPort): PhysicalConnectionEndpoint {
    const asset = this.assets.get(port.assetId)!;
    const rack = this.racks.get(asset.rackId)!;
    const site = this.sites.get(rack.siteId)!;
    return {
      portId: port.id,
      portName: port.name,
      side: port.side,
      assetId: asset.id,
      assetName: asset.name,
      rackId: rack.id,
      rackName: rack.name,
      siteId: site.id,
      siteName: site.name,
    };
  }

  async createConnection(input: CreatePhysicalConnectionInput): Promise<PhysicalConnection | null> {
    const a = this.ports.get(input.portAId);
    const b = this.ports.get(input.portBId);
    if (!a || !b || a.connectionId || b.connectionId) return null;
    const timestamp = now();
    const connection: PhysicalConnection = {
      id: id('connection'),
      portAId: a.id,
      portBId: b.id,
      medium: input.medium ?? 'UNKNOWN',
      label: input.label?.trim() ?? '',
      notes: input.notes?.trim() ?? '',
      lengthMeters: input.lengthMeters ?? null,
      a: this.endpoint(a),
      b: this.endpoint(b),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    a.connectionId = connection.id;
    b.connectionId = connection.id;
    a.updatedAt = timestamp;
    b.updatedAt = timestamp;
    this.connections.set(connection.id, connection);
    return clone(connection);
  }

  async deleteConnection(idValue: string): Promise<boolean> {
    for (const port of this.ports.values()) {
      if (port.connectionId === idValue) {
        port.connectionId = null;
        port.updatedAt = now();
      }
    }
    return this.connections.delete(idValue);
  }

  async disconnect(): Promise<void> {}
}
