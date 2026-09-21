import type {
  CreatePhysicalAssetInput,
  CreatePhysicalConnectionInput,
  CreatePhysicalPortInput,
  CreatePhysicalRackInput,
  CreatePhysicalSiteInput,
  PhysicalAsset,
  PhysicalConnection,
  PhysicalConnectionEndpoint,
  PhysicalEquipmentTemplate,
  PhysicalInventory,
  PhysicalPort,
  PhysicalRack,
  PhysicalSite,
} from '@gmj/shared';
import { Prisma, PrismaClient } from '../../generated/prisma';
import type {
  CreatePhysicalTemplateInput,
  PhysicalRepository,
  UpdatePhysicalAssetInput,
  UpdatePhysicalRackInput,
  UpdatePhysicalSiteInput,
} from './physical-repository';

const templateInclude = {
  ports: { orderBy: [{ side: 'asc' as const }, { sortOrder: 'asc' as const }] },
} satisfies Prisma.PhysicalEquipmentTemplateInclude;

const portInclude = {
  mappedInterface: {
    select: {
      id: true,
      deviceId: true,
      name: true,
      ifIndex: true,
      alias: true,
      operStatus: true,
    },
  },
} satisfies Prisma.PhysicalPortInclude;

const inventoryArgs = Prisma.validator<Prisma.PhysicalSiteDefaultArgs>()({
  include: {
    racks: {
      orderBy: { name: 'asc' },
      include: {
        assets: {
          orderBy: { startU: 'desc' },
          include: {
            device: {
              select: {
                id: true,
                displayName: true,
                hostname: true,
                vendor: true,
                model: true,
                status: true,
              },
            },
            template: { include: templateInclude },
            ports: {
              orderBy: [{ side: 'asc' }, { sortOrder: 'asc' }],
              include: portInclude,
            },
          },
        },
      },
    },
  },
});

const connectionArgs = Prisma.validator<Prisma.PhysicalConnectionDefaultArgs>()({
  include: {
    ports: {
      orderBy: { connectionEnd: 'asc' },
      include: {
        asset: { include: { rack: { include: { site: true } } } },
      },
    },
  },
});

type DbSite = Prisma.PhysicalSiteGetPayload<typeof inventoryArgs>;
type DbAsset = DbSite['racks'][number]['assets'][number];
type DbPort = DbAsset['ports'][number];
type DbTemplate = NonNullable<DbAsset['template']>;
type DbConnection = Prisma.PhysicalConnectionGetPayload<typeof connectionArgs>;

function iso(value: Date): string {
  return value.toISOString();
}

function mapTemplate(template: DbTemplate): PhysicalEquipmentTemplate {
  return {
    id: template.id,
    name: template.name,
    manufacturer: template.manufacturer,
    model: template.model,
    kind: template.kind,
    heightU: template.heightU,
    description: template.description,
    vendorVerified: template.vendorVerified,
    ports: template.ports.map((port) => ({
      id: port.id,
      name: port.name,
      label: port.label,
      order: port.sortOrder,
      side: port.side,
      type: port.type,
      pairedTemplatePortId: port.pairedTemplatePortId,
    })),
    createdAt: iso(template.createdAt),
    updatedAt: iso(template.updatedAt),
  };
}

function mapPort(port: DbPort): PhysicalPort {
  return {
    id: port.id,
    assetId: port.assetId,
    name: port.name,
    label: port.label,
    order: port.sortOrder,
    side: port.side,
    type: port.type,
    notes: port.notes,
    pairedPortId: port.pairedPortId,
    templatePortId: port.templatePortId,
    mappedInterfaceId: port.mappedInterfaceId,
    mappedInterface: port.mappedInterface
      ? {
          ...port.mappedInterface,
          operStatus: port.mappedInterface.operStatus,
        }
      : null,
    connectionId: port.connectionId,
    createdAt: iso(port.createdAt),
    updatedAt: iso(port.updatedAt),
  };
}

function mapAsset(asset: DbAsset): PhysicalAsset {
  return {
    id: asset.id,
    rackId: asset.rackId,
    deviceId: asset.deviceId,
    templateId: asset.templateId,
    name: asset.name,
    kind: asset.kind,
    startU: asset.startU,
    heightU: asset.heightU,
    description: asset.description,
    device: asset.device ? { ...asset.device } : null,
    template: asset.template ? mapTemplate(asset.template) : null,
    ports: asset.ports.map(mapPort),
    createdAt: iso(asset.createdAt),
    updatedAt: iso(asset.updatedAt),
  };
}

function endpoint(port: DbConnection['ports'][number]): PhysicalConnectionEndpoint {
  return {
    portId: port.id,
    portName: port.name,
    side: port.side,
    assetId: port.asset.id,
    assetName: port.asset.name,
    rackId: port.asset.rack.id,
    rackName: port.asset.rack.name,
    siteId: port.asset.rack.site.id,
    siteName: port.asset.rack.site.name,
  };
}

function mapConnection(connection: DbConnection): PhysicalConnection | null {
  const a = connection.ports.find((port) => port.connectionEnd === 'A');
  const b = connection.ports.find((port) => port.connectionEnd === 'B');
  if (!a || !b) return null;
  return {
    id: connection.id,
    portAId: a.id,
    portBId: b.id,
    medium: connection.medium,
    label: connection.label,
    notes: connection.notes,
    lengthMeters: connection.lengthMeters,
    a: endpoint(a),
    b: endpoint(b),
    createdAt: iso(connection.createdAt),
    updatedAt: iso(connection.updatedAt),
  };
}

export class PrismaPhysicalRepository implements PhysicalRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma = new PrismaClient()) {
    this.prisma = prisma;
  }

  async getInventory(): Promise<PhysicalInventory> {
    const [sites, templates, dbConnections] = await Promise.all([
      this.prisma.physicalSite.findMany({ ...inventoryArgs, orderBy: { name: 'asc' } }),
      this.prisma.physicalEquipmentTemplate.findMany({
        include: templateInclude,
        orderBy: { name: 'asc' },
      }),
      this.prisma.physicalConnection.findMany({ ...connectionArgs, orderBy: { createdAt: 'asc' } }),
    ]);
    const connections = dbConnections.map(mapConnection).filter((item) => item !== null);
    return {
      sites: sites.map((site) => ({
        id: site.id,
        name: site.name,
        code: site.code ?? '',
        description: site.description,
        racks: site.racks.map((rack) => ({
          id: rack.id,
          siteId: rack.siteId,
          name: rack.name,
          units: rack.units,
          description: rack.description,
          assets: rack.assets.map(mapAsset),
          createdAt: iso(rack.createdAt),
          updatedAt: iso(rack.updatedAt),
        })),
        createdAt: iso(site.createdAt),
        updatedAt: iso(site.updatedAt),
      })),
      templates: templates.map(mapTemplate),
      connections,
    };
  }

  private async site(id: string): Promise<PhysicalSite | null> {
    return (await this.getInventory()).sites.find((site) => site.id === id) ?? null;
  }

  private async rack(id: string): Promise<PhysicalRack | null> {
    return (
      (await this.getInventory()).sites.flatMap((site) => site.racks).find((rack) => rack.id === id) ??
      null
    );
  }

  private async asset(id: string): Promise<PhysicalAsset | null> {
    return (
      (await this.getInventory()).sites
        .flatMap((site) => site.racks)
        .flatMap((rack) => rack.assets)
        .find((asset) => asset.id === id) ?? null
    );
  }

  private async port(id: string): Promise<PhysicalPort | null> {
    return (
      (await this.getInventory()).sites
        .flatMap((site) => site.racks)
        .flatMap((rack) => rack.assets)
        .flatMap((asset) => asset.ports)
        .find((port) => port.id === id) ?? null
    );
  }

  async createSite(input: CreatePhysicalSiteInput): Promise<PhysicalSite> {
    const created = await this.prisma.physicalSite.create({
      data: {
        name: input.name.trim(),
        code: input.code?.trim() || null,
        description: input.description?.trim() ?? '',
      },
    });
    return {
      ...created,
      code: created.code ?? '',
      racks: [],
      createdAt: iso(created.createdAt),
      updatedAt: iso(created.updatedAt),
    };
  }

  async updateSite(id: string, input: UpdatePhysicalSiteInput): Promise<PhysicalSite | null> {
    const result = await this.prisma.physicalSite.updateMany({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.code === undefined ? {} : { code: input.code?.trim() || null }),
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
      },
    });
    return result.count ? this.site(id) : null;
  }

  async deleteSite(id: string): Promise<boolean> {
    return (await this.prisma.physicalSite.deleteMany({ where: { id } })).count > 0;
  }

  async createRack(siteId: string, input: CreatePhysicalRackInput): Promise<PhysicalRack | null> {
    if (!(await this.prisma.physicalSite.findUnique({ where: { id: siteId }, select: { id: true } }))) {
      return null;
    }
    const created = await this.prisma.physicalRack.create({
      data: {
        siteId,
        name: input.name.trim(),
        units: input.units ?? 42,
        description: input.description?.trim() ?? '',
      },
    });
    return {
      ...created,
      assets: [],
      createdAt: iso(created.createdAt),
      updatedAt: iso(created.updatedAt),
    };
  }

  async updateRack(id: string, input: UpdatePhysicalRackInput): Promise<PhysicalRack | null> {
    const result = await this.prisma.physicalRack.updateMany({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.units === undefined ? {} : { units: input.units }),
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
      },
    });
    return result.count ? this.rack(id) : null;
  }

  async deleteRack(id: string): Promise<boolean> {
    return (await this.prisma.physicalRack.deleteMany({ where: { id } })).count > 0;
  }

  async createTemplate(input: CreatePhysicalTemplateInput): Promise<PhysicalEquipmentTemplate> {
    const created = await this.prisma.physicalEquipmentTemplate.create({
      data: {
        name: input.name.trim(),
        manufacturer: input.manufacturer?.trim() ?? '',
        model: input.model?.trim() ?? '',
        kind: input.kind ?? 'GENERIC',
        heightU: input.heightU ?? 1,
        description: input.description?.trim() ?? '',
        vendorVerified: false,
        ports: {
          create: (input.ports ?? []).map((port) => ({
            name: port.name.trim(),
            label: port.label?.trim() ?? '',
            sortOrder: port.order,
            side: port.side ?? 'DEVICE',
            type: port.type ?? 'OTHER',
          })),
        },
      },
      include: templateInclude,
    });
    return mapTemplate(created);
  }

  async createAsset(
    rackId: string,
    input: CreatePhysicalAssetInput,
  ): Promise<PhysicalAsset | null> {
    const [rack, device, template] = await Promise.all([
      this.prisma.physicalRack.findUnique({ where: { id: rackId }, select: { id: true } }),
      input.deviceId
        ? this.prisma.device.findUnique({ where: { id: input.deviceId }, select: { id: true } })
        : Promise.resolve(null),
      input.templateId
        ? this.prisma.physicalEquipmentTemplate.findUnique({
            where: { id: input.templateId },
            include: { ports: true },
          })
        : Promise.resolve(null),
    ]);
    if (!rack || (input.deviceId && !device) || (input.templateId && !template)) return null;

    const portData = template
      ? template.ports.map((port) => ({
          name: port.name,
          label: port.label,
          sortOrder: port.sortOrder,
          side: port.side,
          type: port.type,
          templatePortId: port.id,
        }))
      : Array.from({ length: input.genericPorts?.count ?? 0 }, (_, index) => ({
          name: `${input.genericPorts?.prefix?.trim() ?? ''}${index + 1}`,
          label: '',
          sortOrder: index + 1,
          side: input.genericPorts?.side ?? ('DEVICE' as const),
          type: input.genericPorts?.type ?? ('OTHER' as const),
        }));
    const created = await this.prisma.physicalAsset.create({
      data: {
        rackId,
        deviceId: input.deviceId || null,
        templateId: input.templateId || null,
        name: input.name.trim(),
        kind: input.kind ?? template?.kind ?? 'GENERIC',
        startU: input.startU,
        heightU: input.heightU,
        description: input.description?.trim() ?? '',
        ports: { create: portData },
      },
      select: { id: true },
    });
    return this.asset(created.id);
  }

  async updateAsset(id: string, input: UpdatePhysicalAssetInput): Promise<PhysicalAsset | null> {
    if (
      input.deviceId &&
      !(await this.prisma.device.findUnique({ where: { id: input.deviceId }, select: { id: true } }))
    ) {
      return null;
    }
    if (
      input.templateId &&
      !(await this.prisma.physicalEquipmentTemplate.findUnique({
        where: { id: input.templateId },
        select: { id: true },
      }))
    ) {
      return null;
    }
    const result = await this.prisma.physicalAsset.updateMany({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.startU === undefined ? {} : { startU: input.startU }),
        ...(input.heightU === undefined ? {} : { heightU: input.heightU }),
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId || null }),
        ...(input.templateId === undefined ? {} : { templateId: input.templateId || null }),
      },
    });
    return result.count ? this.asset(id) : null;
  }

  async deleteAsset(id: string): Promise<boolean> {
    return (await this.prisma.physicalAsset.deleteMany({ where: { id } })).count > 0;
  }

  async createPort(assetId: string, input: CreatePhysicalPortInput): Promise<PhysicalPort | null> {
    const asset = await this.prisma.physicalAsset.findUnique({
      where: { id: assetId },
      select: { deviceId: true },
    });
    if (!asset) return null;
    if (input.mappedInterfaceId) {
      const mapped = await this.prisma.interface.findUnique({
        where: { id: input.mappedInterfaceId },
        select: { deviceId: true },
      });
      if (!mapped || mapped.deviceId !== asset.deviceId) return null;
    }
    const created = await this.prisma.physicalPort.create({
      data: {
        assetId,
        name: input.name.trim(),
        label: input.label?.trim() ?? '',
        sortOrder: input.order,
        side: input.side ?? 'DEVICE',
        type: input.type ?? 'OTHER',
        notes: input.notes?.trim() ?? '',
        mappedInterfaceId: input.mappedInterfaceId || null,
        pairedPortId: input.pairedPortId || null,
      },
      select: { id: true },
    });
    return this.port(created.id);
  }

  async pairPorts(portId: string, pairedPortId: string): Promise<[PhysicalPort, PhysicalPort] | null> {
    const count = await this.prisma.$transaction(async (tx) => {
      const a = await tx.physicalPort.updateMany({
        where: { id: portId, pairedPortId: null },
        data: { pairedPortId },
      });
      const b = await tx.physicalPort.updateMany({
        where: { id: pairedPortId, pairedPortId: null },
        data: { pairedPortId: portId },
      });
      if (a.count !== 1 || b.count !== 1) throw new Error('PAIR_CONFLICT');
      return a.count + b.count;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'PAIR_CONFLICT') return 0;
      throw error;
    });
    if (count !== 2) return null;
    const [a, b] = await Promise.all([this.port(portId), this.port(pairedPortId)]);
    return a && b ? [a, b] : null;
  }

  async syncInterfacePorts(assetId: string): Promise<PhysicalPort[] | null> {
    const asset = await this.prisma.physicalAsset.findUnique({
      where: { id: assetId },
      include: { ports: true, device: { include: { interfaces: { orderBy: { ifIndex: 'asc' } } } } },
    });
    if (!asset?.device) return null;
    const names = new Set(asset.ports.filter((port) => port.side === 'DEVICE').map((port) => port.name));
    const mappedIds = new Set(asset.ports.map((port) => port.mappedInterfaceId).filter(Boolean));
    let order = Math.max(0, ...asset.ports.map((port) => port.sortOrder));
    for (const item of asset.device.interfaces) {
      if (mappedIds.has(item.id) || names.has(item.name)) continue;
      order += 1;
      await this.prisma.physicalPort.create({
        data: {
          assetId,
          name: item.name,
          label: item.alias ?? '',
          sortOrder: order,
          side: 'DEVICE',
          type: 'OTHER',
          mappedInterfaceId: item.id,
        },
      });
    }
    return (await this.asset(assetId))?.ports ?? null;
  }

  async createConnection(input: CreatePhysicalConnectionInput): Promise<PhysicalConnection | null> {
    const connectionId = await this.prisma.$transaction(async (tx) => {
      const ports = await tx.physicalPort.findMany({
        where: { id: { in: [input.portAId, input.portBId] } },
        select: { id: true, connectionId: true },
      });
      if (ports.length !== 2 || ports.some((port) => port.connectionId)) {
        throw new Error('PORT_OCCUPIED');
      }
      const connection = await tx.physicalConnection.create({
        data: {
          medium: input.medium ?? 'UNKNOWN',
          label: input.label?.trim() ?? '',
          notes: input.notes?.trim() ?? '',
          lengthMeters: input.lengthMeters ?? null,
        },
      });
      const a = await tx.physicalPort.updateMany({
        where: { id: input.portAId, connectionId: null },
        data: { connectionId: connection.id, connectionEnd: 'A' },
      });
      const b = await tx.physicalPort.updateMany({
        where: { id: input.portBId, connectionId: null },
        data: { connectionId: connection.id, connectionEnd: 'B' },
      });
      if (a.count !== 1 || b.count !== 1) throw new Error('PORT_OCCUPIED');
      return connection.id;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'PORT_OCCUPIED') return null;
      throw error;
    });
    if (!connectionId) return null;
    const created = await this.prisma.physicalConnection.findUnique({
      where: { id: connectionId },
      ...connectionArgs,
    });
    return created ? mapConnection(created) : null;
  }

  async deleteConnection(id: string): Promise<boolean> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.physicalPort.updateMany({
        where: { connectionId: id },
        data: { connectionId: null, connectionEnd: null },
      });
      return tx.physicalConnection.deleteMany({ where: { id } });
    });
    return result.count > 0;
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
