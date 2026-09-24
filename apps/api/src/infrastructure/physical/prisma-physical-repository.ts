import type {
  CreatePhysicalAssetInput,
  CreatePhysicalConnectionInput,
  UpdatePhysicalConnectionInput,
  CreatePhysicalModuleInput,
  CreatePhysicalPortInput,
  CreatePhysicalRackInput,
  CreatePhysicalSiteInput,
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalConnection,
  PhysicalConnectionEndpoint,
  PhysicalEquipmentTemplate,
  PhysicalInventory,
  PhysicalModule,
  PhysicalPort,
  PhysicalRack,
  PhysicalSite,
  PhysicalSlot,
} from '@gmj/shared';
import { Prisma, PrismaClient } from '../../generated/prisma';
import { materializeTemplate, planInterfaceSync, portState, isVendorTemplate, syncDiagnostics } from './physical-domain';
import type {
  CreatePhysicalTemplateInput,
  InterfaceSyncExecution,
  PhysicalCatalogSyncResult,
  PhysicalLldpAdjacencyInput,
  PhysicalLldpAdjacencyRecord,
  PhysicalRepository,
  UpdatePhysicalAssetInput,
  UpdatePhysicalPortInput,
  UpdatePhysicalRackInput,
  UpdatePhysicalSiteInput,
} from './physical-repository';

const templateInclude = {
  ports: { orderBy: [{ side: 'asc' as const }, { sortOrder: 'asc' as const }] },
  slots: {
    orderBy: { index: 'asc' as const },
    include: { moduleOptions: { select: { moduleTemplate: { select: { catalogKey: true } } } } },
  },
  modules: {
    orderBy: { name: 'asc' as const },
    include: { ports: { orderBy: { sortOrder: 'asc' as const } } },
  },
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

const slotInclude = {
  module: { include: { ports: { orderBy: { sortOrder: 'asc' as const }, include: portInclude } } },
  ports: { orderBy: { sortOrder: 'asc' as const }, include: portInclude },
} satisfies Prisma.PhysicalSlotInclude;

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
            slots: { orderBy: { index: 'asc' }, include: slotInclude },
            modules: { orderBy: { name: 'asc' }, include: { slot: { select: { index: true } } } },
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
    catalogKey: template.catalogKey,
    name: template.name,
    category: (template.category || null) as PhysicalEquipmentTemplate['category'],
    manufacturer: template.manufacturer,
    family: template.family,
    model: template.model,
    kind: template.kind,
    heightU: template.heightU,
    description: template.description,
    vendorVerified: template.vendorVerified,
    structureConfirmed: template.structureConfirmed,
    referenceUrl: template.referenceUrl,
    origin: template.origin,
    ports: template.ports.map((port) => ({
      id: port.id,
      name: port.name,
      label: port.label,
      order: port.sortOrder,
      side: port.side,
      type: port.type,
      pairedTemplatePortId: port.pairedTemplatePortId,
    })),
    slots: template.slots.map((slot) => ({
      id: slot.id,
      index: slot.index,
      label: slot.label,
      description: slot.description,
      moduleKeys: slot.moduleOptions.flatMap((option) =>
        option.moduleTemplate.catalogKey ? [option.moduleTemplate.catalogKey] : [],
      ),
    })),
    modules: template.modules.map((module) => ({
      id: module.id,
      catalogKey: module.catalogKey,
      name: module.name,
      model: module.model,
      description: module.description,
      slotsRequired: module.slotsRequired,
      ports: module.ports.map((port) => ({
        name: port.name,
        label: port.label,
        order: port.sortOrder,
        side: 'DEVICE' as const,
        type: port.type,
      })),
    })),
    createdAt: iso(template.createdAt),
    updatedAt: iso(template.updatedAt),
  };
}

function mapPort(port: DbPort): PhysicalPort {
  return {
    id: port.id,
    assetId: port.assetId,
    slotId: port.slotId,
    moduleId: port.moduleId,
    name: port.name,
    label: port.label,
    order: port.sortOrder,
    side: port.side,
    type: port.type,
    role: port.role,
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
    state: portState({ ...port, lldp: null }),
    operStatus: port.mappedInterface?.operStatus ?? null,
    lldp: null,
    createdAt: iso(port.createdAt),
    updatedAt: iso(port.updatedAt),
  };
}

function mapModule(module: {
  id: string;
  assetId: string;
  slotId: string;
  moduleTemplateId: string | null;
  name: string;
  model: string;
  serial: string;
  slot?: { index: number };
  ports?: DbPort[];
}): PhysicalModule {
  return {
    id: module.id,
    assetId: module.assetId,
    slotId: module.slotId,
    slotIndex: module.slot?.index ?? -1,
    moduleTemplateId: module.moduleTemplateId,
    name: module.name,
    model: module.model,
    serial: module.serial,
    ports: (module.ports ?? []).map(mapPort),
  };
}

function mapSlot(slot: {
  id: string;
  assetId: string;
  index: number;
  label: string;
  module: Parameters<typeof mapModule>[0] | null;
  ports: DbPort[];
}): PhysicalSlot {
  return {
    id: slot.id,
    assetId: slot.assetId,
    index: slot.index,
    label: slot.label,
    // The module belongs to this slot, so its index is authoritative here.
    module: slot.module ? { ...mapModule(slot.module), slotIndex: slot.index } : null,
    ports: slot.ports.map(mapPort),
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
    slots: asset.slots.map(mapSlot),
    modules: asset.modules.map((module) => mapModule(module)),
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
      lldpSuggestions: [],
      lldpObservedAt: null,
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

  /**
   * Idempotent catalog bootstrap. SYSTEM templates are matched by `catalogKey`;
   * template ports are only added (never removed) and CUSTOM templates are left
   * untouched, so operator customizations are never overwritten silently.
   */
  async syncCatalog(entries: readonly PhysicalCatalogEntry[]): Promise<PhysicalCatalogSyncResult> {
    let created = 0;
    let updated = 0;
    for (const entry of entries) {
      const existing = await this.prisma.physicalEquipmentTemplate.findUnique({
        where: { catalogKey: entry.catalogKey },
        include: { ports: true, slots: { include: { moduleOptions: true } }, modules: true },
      });
      if (!existing) {
        await this.prisma.physicalEquipmentTemplate.create({
          data: {
            catalogKey: entry.catalogKey,
            name: entry.name,
            category: entry.category,
            manufacturer: entry.manufacturer,
            family: entry.family,
            model: entry.model,
            kind: entry.kind,
            heightU: entry.heightU,
            description: entry.description,
            vendorVerified: entry.vendorVerified,
            structureConfirmed: entry.structureConfirmed,
            referenceUrl: entry.referenceUrl,
            origin: 'SYSTEM',
            ports: {
              create: entry.ports.map((port) => ({
                name: port.name,
                label: port.label,
                sortOrder: port.order,
                side: port.side,
                type: port.type,
              })),
            },
            slots: {
              create: entry.slots.map((slot) => ({
                index: slot.index,
                label: slot.label,
                description: slot.description,
              })),
            },
            modules: {
              create: entry.modules.map((module) => ({
                catalogKey: module.key,
                name: module.name,
                model: module.model,
                description: module.description,
                slotsRequired: module.slotsRequired,
                ports: {
                  create: module.ports.map((port) => ({
                    name: port.name,
                    label: port.label,
                    sortOrder: port.order,
                    type: port.type,
                  })),
                },
              })),
            },
          },
        });
        created += 1;
        await this.linkSlotModuleOptions(entry);
        continue;
      }
      if (existing.origin === 'CUSTOM') continue;
      await this.prisma.physicalEquipmentTemplate.update({
        where: { id: existing.id },
        data: {
          name: entry.name,
          category: entry.category,
          manufacturer: entry.manufacturer,
          family: entry.family,
          model: entry.model,
          kind: entry.kind,
          heightU: entry.heightU,
          description: entry.description,
          vendorVerified: entry.vendorVerified,
          structureConfirmed: entry.structureConfirmed,
          referenceUrl: entry.referenceUrl,
        },
      });
      const existingSlots = await this.prisma.physicalTemplateSlot.findMany({
        where: { templateId: existing.id },
        select: { id: true, index: true },
      });
      for (const slot of entry.slots) {
        if (existingSlots.some((row) => row.index === slot.index)) continue;
        await this.prisma.physicalTemplateSlot.create({
          data: {
            templateId: existing.id,
            index: slot.index,
            label: slot.label,
            description: slot.description,
          },
        });
      }
      const existingNames = new Set(existing.ports.map((port) => `${port.side}:${port.name}`));
      const additions = entry.ports.filter(
        (port) => !existingNames.has(`${port.side}:${port.name}`),
      );
      if (additions.length) {
        await this.prisma.physicalTemplatePort.createMany({
          data: additions.map((port) => ({
            templateId: existing.id,
            name: port.name,
            label: port.label,
            sortOrder: port.order,
            side: port.side,
            type: port.type,
          })),
          skipDuplicates: true,
        });
      }
      await this.linkSlotModuleOptions(entry);
      updated += 1;
    }
    return { created, updated, total: entries.length };
  }

  /** Links slot ↔ module options for an already persisted SYSTEM template. */
  private async linkSlotModuleOptions(entry: PhysicalCatalogEntry): Promise<void> {
    if (!entry.slots.length || !entry.modules.length) return;
    const template = await this.prisma.physicalEquipmentTemplate.findUnique({
      where: { catalogKey: entry.catalogKey },
      select: { id: true },
    });
    if (!template) return;
    const [slots, modules] = await Promise.all([
      this.prisma.physicalTemplateSlot.findMany({
        where: { templateId: template.id },
        select: { id: true, index: true },
      }),
      this.prisma.physicalModuleTemplate.findMany({
        where: { templateId: template.id },
        select: { id: true, catalogKey: true },
      }),
    ]);
    for (const slot of entry.slots) {
      const slotRow = slots.find((row) => row.index === slot.index);
      if (!slotRow) continue;
      for (const moduleKey of slot.moduleKeys) {
        const moduleRow = modules.find((row) => row.catalogKey === moduleKey);
        if (!moduleRow) continue;
        await this.prisma.physicalTemplateSlotModule.upsert({
          where: {
            slotId_moduleTemplateId: { slotId: slotRow.id, moduleTemplateId: moduleRow.id },
          },
          create: { slotId: slotRow.id, moduleTemplateId: moduleRow.id, isDefault: true },
          update: {},
        });
      }
    }
  }

  async createAsset(
    rackId: string,
    input: CreatePhysicalAssetInput,
  ): Promise<PhysicalAsset | null> {
    const templateId = input.templateId
      ?? (input.catalogKey
        ? (
            await this.prisma.physicalEquipmentTemplate.findUnique({
              where: { catalogKey: input.catalogKey },
              select: { id: true },
            })
          )?.id ?? null
        : null);
    const [rack, device, template] = await Promise.all([
      this.prisma.physicalRack.findUnique({ where: { id: rackId }, select: { id: true } }),
      input.deviceId
        ? this.prisma.device.findUnique({ where: { id: input.deviceId }, select: { id: true } })
        : Promise.resolve(null),
      templateId
        ? this.prisma.physicalEquipmentTemplate.findUnique({
            where: { id: templateId },
            include: {
              ports: { orderBy: { sortOrder: 'asc' } },
              slots: { orderBy: { index: 'asc' } },
            },
          })
        : Promise.resolve(null),
    ]);
    if (!rack || (input.deviceId && !device) || (templateId && !template)) return null;

    const applyTemplate = input.applyTemplate ?? true;
    const materialized = template && applyTemplate
      ? materializeTemplate(
          {
            structureConfirmed: template.structureConfirmed,
            slots: template.slots.map((slot) => ({
              index: slot.index,
              label: slot.label,
              description: slot.description,
              moduleKeys: [],
            })),
            ports: template.ports.map((port) => ({
              name: port.name,
              label: port.label,
              order: port.sortOrder,
              side: port.side,
              type: port.type,
            })),
          },
          { genericPorts: input.genericPorts },
        )
      : materializeTemplate(
          { structureConfirmed: false, slots: [], ports: [] },
          { genericPorts: input.genericPorts },
        );
    const templatePortByName = new Map(
      (template?.ports ?? []).map((port) => [`${port.side}:${port.name}`, port.id]),
    );
    const created = await this.prisma.physicalAsset.create({
      data: {
        rackId,
        deviceId: input.deviceId || null,
        templateId: templateId,
        name: input.name.trim(),
        kind: input.kind ?? template?.kind ?? 'GENERIC',
        startU: input.startU,
        heightU: input.heightU,
        description: input.description?.trim() ?? '',
        ...(materialized.slots.length
          ? {
              slots: {
                create: materialized.slots.map((slot) => ({
                  index: slot.index,
                  label: slot.label,
                })),
              },
            }
          : {}),
        ports: {
          create: materialized.ports.map((port) => ({
            name: port.name,
            label: port.label,
            sortOrder: port.sortOrder,
            side: port.side,
            type: port.type,
            role: port.role,
            ...(port.templatePortName
              ? { templatePortId: templatePortByName.get(`${port.side}:${port.templatePortName}`) ?? null }
              : {}),
          })),
        },
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
        // A port created through the API is operator input, never a template port.
        role: 'MANUAL',
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

  async updatePort(id: string, input: UpdatePhysicalPortInput): Promise<PhysicalPort | null> {
    if (input.mappedInterfaceId) {
      const [port, mapped] = await Promise.all([
        this.prisma.physicalPort.findUnique({
          where: { id },
          select: { assetId: true, asset: { select: { deviceId: true } } },
        }),
        this.prisma.interface.findUnique({
          where: { id: input.mappedInterfaceId },
          select: { deviceId: true },
        }),
      ]);
      if (!port || !mapped || mapped.deviceId !== port.asset.deviceId) return null;
    }
    const result = await this.prisma.physicalPort.updateMany({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.label === undefined ? {} : { label: input.label.trim() }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.notes === undefined ? {} : { notes: input.notes.trim() }),
        ...(input.mappedInterfaceId === undefined
          ? {}
          : { mappedInterfaceId: input.mappedInterfaceId || null }),
      },
    });
    return result.count ? this.port(id) : null;
  }

  /**
   * Maps existing interfaces first, keeps template/manual ports even when the
   * Interface does not exist yet, adds unclassified ports for unknown interfaces
   * and never deletes a port or a cable. Safe to run repeatedly.
   */
  /**
   * Maps the real chassis connectors of the Device and ignores every logical
   * interface (VLAN, bridge, sub-interface, tunnel, aggregation group, breakout
   * lane). Only PHYSICAL interfaces may create a connector; UNKNOWN names may
   * fill an existing port but never fabricate one.
   */
  async syncInterfacePorts(assetId: string): Promise<InterfaceSyncExecution | null> {
    const asset = await this.prisma.physicalAsset.findUnique({
      where: { id: assetId },
      include: {
        ports: true,
        template: {
          select: {
            catalogKey: true,
            manufacturer: true,
            // Nome de interface declarado no catálogo (`interfaceNamePattern`):
            // chega aqui pelo template port da porta (nome = CLI quando existe).
            ports: { select: { id: true, name: true } },
          },
        },
        device: { include: { interfaces: { orderBy: { ifIndex: 'asc' } } } },
      },
    });
    if (!asset?.device) return null;

    const catalogPortName = new Map(
      (asset.template?.ports ?? []).map((port) => [port.id, port.name]),
    );
    const plan = planInterfaceSync(
      asset.ports.map((port) => ({
        id: port.id,
        name: port.name,
        side: port.side,
        mappedInterfaceId: port.mappedInterfaceId,
        catalogInterfaceName: port.templatePortId
          ? (catalogPortName.get(port.templatePortId) ?? null)
          : null,
      })),
      asset.device.interfaces.map((item) => ({ id: item.id, name: item.name })),
      {
        vendorTemplate: isVendorTemplate(asset.template),
        catalogKey: asset.template?.catalogKey ?? null,
      },
    );

    let order = Math.max(0, ...asset.ports.map((port) => port.sortOrder));
    const interfaceById = new Map(asset.device.interfaces.map((item) => [item.id, item]));
    let created = 0;
    let mapped = 0;
    let skippedLogical = 0;
    let skippedUnknown = 0;
    let skippedByPolicy = 0;

    for (const entry of plan) {
      if (entry.action === 'SKIP') {
        if (entry.classification === 'LOGICAL') skippedLogical += 1;
        else if (entry.classification === 'UNKNOWN') skippedUnknown += 1;
        else skippedByPolicy += 1;
        continue;
      }
      const item = interfaceById.get(entry.interfaceId);
      if (!item) continue;
      if (entry.action === 'MAP' && entry.portId) {
        await this.prisma.physicalPort.update({
          where: { id: entry.portId },
          data: { mappedInterfaceId: item.id },
        });
        mapped += 1;
        continue;
      }
      order += 1;
      await this.prisma.physicalPort.create({
        data: {
          assetId,
          name: entry.portName ?? item.name,
          label: item.alias ?? '',
          sortOrder: order,
          side: 'DEVICE',
          type: 'OTHER',
          role: 'DISCOVERED',
          mappedInterfaceId: item.id,
        },
      });
      created += 1;
    }

    const ports = (await this.asset(assetId))?.ports ?? [];
    return {
      ports,
      created,
      mapped,
      skippedLogical,
      skippedUnknown,
      skippedByPolicy,
      ...syncDiagnostics(plan),
    };
  }

  /** Deletes the given ports; cables and template/manual ports are out of scope. */
  async deletePorts(portIds: readonly string[]): Promise<number> {
    if (!portIds.length) return 0;
    const result = await this.prisma.physicalPort.deleteMany({
      where: { id: { in: [...portIds] } },
    });
    return result.count;
  }

  async installModule(
    assetId: string,
    input: CreatePhysicalModuleInput,
  ): Promise<PhysicalModule | null> {
    const [asset, slot, moduleTemplate] = await Promise.all([
      this.prisma.physicalAsset.findUnique({ where: { id: assetId }, select: { id: true } }),
      this.prisma.physicalSlot.findFirst({
        where: { id: input.slotId, assetId },
        include: { module: { select: { id: true } } },
      }),
      input.moduleTemplateId
        ? this.prisma.physicalModuleTemplate.findUnique({
            where: { id: input.moduleTemplateId },
            include: { ports: { orderBy: { sortOrder: 'asc' } } },
          })
        : Promise.resolve(null),
    ]);
    if (!asset || !slot || slot.module || (input.moduleTemplateId && !moduleTemplate)) return null;

    const lastOrder = await this.prisma.physicalPort.aggregate({
      where: { assetId },
      _max: { sortOrder: true },
    });
    let order = lastOrder._max.sortOrder ?? 0;
    const module = await this.prisma.physicalModule.create({
      data: {
        assetId,
        slotId: slot.id,
        moduleTemplateId: moduleTemplate?.id ?? null,
        name: input.name.trim(),
        model: input.model?.trim() || moduleTemplate?.model || '',
        serial: input.serial?.trim() ?? '',
        ports: {
          create: (moduleTemplate?.ports ?? []).map((port) => {
            order += 1;
            return {
              assetId,
              name: port.name,
              label: port.label,
              sortOrder: order,
              side: 'DEVICE' as const,
              type: port.type,
              role: 'TEMPLATE' as const,
            };
          }),
        },
      },
      select: { id: true },
    });
    await this.prisma.physicalPort.updateMany({
      where: { moduleId: module.id },
      data: { slotId: slot.id },
    });
    const inventory = await this.getInventory();
    const installed = inventory.sites
      .flatMap((site) => site.racks)
      .flatMap((rack) => rack.assets)
      .flatMap((item) => item.slots)
      .find((item) => item.id === slot.id)?.module;
    return installed ?? null;
  }

  async removeModule(moduleId: string): Promise<boolean> {
    const result = await this.prisma.$transaction(async (tx) => {
      const module = await tx.physicalModule.findUnique({
        where: { id: moduleId },
        select: { id: true },
      });
      if (!module) return 0;
      await tx.physicalPort.deleteMany({ where: { moduleId } });
      await tx.physicalModule.delete({ where: { id: moduleId } });
      return 1;
    });
    return result === 1;
  }

  async recordLldpAdjacencies(rows: readonly PhysicalLldpAdjacencyInput[]): Promise<number> {
    let written = 0;
    for (const row of rows) {
      await this.prisma.physicalLldpAdjacency.upsert({
        where: {
          localDeviceId_localPortName_remoteHostname_remotePortName: {
            localDeviceId: row.localDeviceId,
            localPortName: row.localPortName,
            remoteHostname: row.remoteHostname,
            remotePortName: row.remotePortName,
          },
        },
        create: { ...row },
        update: {
          localInterfaceId: row.localInterfaceId,
          remoteDeviceId: row.remoteDeviceId,
          remoteInterfaceId: row.remoteInterfaceId,
          remoteChassisId: row.remoteChassisId,
          confidence: row.confidence,
          resolved: row.resolved,
          ambiguous: row.ambiguous,
          source: row.source,
          observedAt: row.observedAt,
        },
      });
      written += 1;
    }
    return written;
  }

  async listLldpAdjacencies(): Promise<PhysicalLldpAdjacencyRecord[]> {
    const rows = await this.prisma.physicalLldpAdjacency.findMany({
      orderBy: { observedAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      localDeviceId: row.localDeviceId,
      localInterfaceId: row.localInterfaceId,
      localPortName: row.localPortName,
      remoteDeviceId: row.remoteDeviceId,
      remoteHostname: row.remoteHostname,
      remotePortName: row.remotePortName,
      remoteInterfaceId: row.remoteInterfaceId,
      remoteChassisId: row.remoteChassisId,
      confidence: row.confidence,
      resolved: row.resolved,
      ambiguous: row.ambiguous,
      source: row.source,
      observedAt: iso(row.observedAt),
    }));
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

  async updateConnection(
    id: string,
    input: UpdatePhysicalConnectionInput,
  ): Promise<PhysicalConnection | null> {
    const updated = await this.prisma.physicalConnection
      .update({
        where: { id },
        data: {
          ...(input.medium !== undefined ? { medium: input.medium } : {}),
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
          ...(input.lengthMeters !== undefined ? { lengthMeters: input.lengthMeters } : {}),
        },
        ...connectionArgs,
      })
      .catch(() => null);
    return updated ? mapConnection(updated) : null;
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
