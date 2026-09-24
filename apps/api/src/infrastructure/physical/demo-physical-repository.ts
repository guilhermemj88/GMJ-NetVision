import { randomUUID } from 'node:crypto';
import type {
  CreatePhysicalAssetInput,
  CreatePhysicalConnectionInput,
  UpdatePhysicalConnectionInput,
  CreatePhysicalModuleInput,
  CreatePhysicalPortInput,
  CreatePhysicalRackInput,
  CreatePhysicalSiteInput,
  HostRecord,
  NetworkInterface,
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalConnection,
  PhysicalConnectionEndpoint,
  PhysicalDeviceReference,
  PhysicalEquipmentTemplate,
  PhysicalInterfaceReference,
  PhysicalInventory,
  PhysicalLldpSuggestion,
  PhysicalModule,
  PhysicalPort,
  PhysicalRack,
  PhysicalSite,
  PhysicalSlot,
} from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import { materializeTemplate, isVendorTemplate, planInterfaceSync, portState, syncDiagnostics } from './physical-domain';
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
  private readonly slots = new Map<string, PhysicalSlot>();
  private readonly modules = new Map<string, PhysicalModule>();
  private readonly connections = new Map<string, PhysicalConnection>();
  private readonly lldp = new Map<string, PhysicalLldpAdjacencyRecord>();

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
            .map((asset) => this.assetView(asset))
            .sort((a, b) => b.startU - a.startU),
        })),
    }));
    const observedAt = [...this.lldp.values()]
      .map((row) => row.observedAt)
      .sort()
      .at(-1) ?? null;
    return clone({
      sites,
      templates: [...this.templates.values()],
      connections: [...this.connections.values()],
      lldpSuggestions: [] as PhysicalLldpSuggestion[],
      lldpObservedAt: observedAt,
    });
  }

  /** Rebuilds the asset view with its live ports, slots and modules. */
  private assetView(asset: PhysicalAsset): PhysicalAsset {
    const ports = [...this.ports.values()]
      .filter((port) => port.assetId === asset.id)
      .sort((a, b) => a.order - b.order)
      .map((port) => this.portView(port));
    const modules = [...this.modules.values()]
      .filter((module) => module.assetId === asset.id)
      .map((module) => ({
        ...module,
        ports: ports.filter((port) => port.moduleId === module.id),
      }));
    const slots = [...this.slots.values()]
      .filter((slot) => slot.assetId === asset.id)
      .sort((a, b) => a.index - b.index)
      .map((slot) => ({
        ...slot,
        module: modules.find((module) => module.slotId === slot.id) ?? null,
        ports: ports.filter((port) => port.slotId === slot.id),
      }));
    return { ...asset, ports, slots, modules };
  }

  /** Attaches derived state and the LLDP snapshot to a port. */
  private portView(port: PhysicalPort): PhysicalPort {
    const lldpRow = port.mappedInterfaceId
      ? [...this.lldp.values()].find((row) => row.localInterfaceId === port.mappedInterfaceId)
      : undefined;
    const lldp = lldpRow
      ? {
          adjacencyId: lldpRow.id,
          remoteHostname: lldpRow.remoteHostname,
          remotePortName: lldpRow.remotePortName,
          confidence: lldpRow.confidence,
          resolved: lldpRow.resolved,
          ambiguous: lldpRow.ambiguous,
          source: lldpRow.source,
          observedAt: lldpRow.observedAt,
        }
      : null;
    return {
      ...port,
      lldp,
      operStatus: port.mappedInterface?.operStatus ?? null,
      state: portState({ connectionId: port.connectionId, mappedInterfaceId: port.mappedInterfaceId, lldp }),
    };
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
      catalogKey: null,
      name: input.name.trim(),
      category: null,
      manufacturer: input.manufacturer?.trim() ?? '',
      family: '',
      model: input.model?.trim() ?? '',
      kind: input.kind ?? 'GENERIC',
      heightU: input.heightU ?? 1,
      description: input.description?.trim() ?? '',
      vendorVerified: false,
      structureConfirmed: false,
      referenceUrl: null,
      origin: 'CUSTOM',
      ports,
      slots: [],
      modules: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.templates.set(template.id, template);
    return clone(template);
  }

  /** Idempotent bootstrap: CUSTOM templates are never touched. */
  async syncCatalog(entries: readonly PhysicalCatalogEntry[]): Promise<PhysicalCatalogSyncResult> {
    let created = 0;
    let updated = 0;
    for (const entry of entries) {
      const existing = [...this.templates.values()].find(
        (template) => template.catalogKey === entry.catalogKey,
      );
      const moduleDtos = entry.modules.map((module) => ({
        id: id('template-module'),
        // the module key declared by the catalog is authoritative
        catalogKey: module.key,
        name: module.name,
        model: module.model,
        description: module.description,
        slotsRequired: module.slotsRequired,
        ports: module.ports.map((port) => ({ ...port })),
      }));
      const slotDtos = entry.slots.map((slot) => ({
        id: id('template-slot'),
        index: slot.index,
        label: slot.label,
        description: slot.description,
        moduleKeys: [...slot.moduleKeys],
      }));
      if (!existing) {
        const timestamp = now();
        const template: PhysicalEquipmentTemplate = {
          id: id('template'),
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
          ports: entry.ports.map((port) => ({
            id: id('template-port'),
            name: port.name,
            label: port.label,
            order: port.order,
            side: port.side,
            type: port.type,
            pairedTemplatePortId: null,
          })),
          slots: slotDtos,
          modules: moduleDtos,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.templates.set(template.id, template);
        created += 1;
        continue;
      }
      if (existing.origin === 'CUSTOM') continue;
      const knownPorts = new Set(existing.ports.map((port) => `${port.side}:${port.name}`));
      existing.name = entry.name;
      existing.category = entry.category;
      existing.manufacturer = entry.manufacturer;
      existing.family = entry.family;
      existing.model = entry.model;
      existing.kind = entry.kind;
      existing.heightU = entry.heightU;
      existing.description = entry.description;
      existing.vendorVerified = entry.vendorVerified;
      existing.structureConfirmed = entry.structureConfirmed;
      existing.referenceUrl = entry.referenceUrl;
      existing.slots = slotDtos.map((slot, index) => existing.slots[index] ?? slot);
      existing.modules = moduleDtos.map((module) =>
        existing.modules.find((item) => item.catalogKey === module.catalogKey) ?? module,
      );
      for (const port of entry.ports) {
        if (knownPorts.has(`${port.side}:${port.name}`)) continue;
        existing.ports.push({
          id: id('template-port'),
          name: port.name,
          label: port.label,
          order: port.order,
          side: port.side,
          type: port.type,
          pairedTemplatePortId: null,
        });
      }
      existing.updatedAt = now();
      updated += 1;
    }
    return { created, updated, total: entries.length };
  }

  async createAsset(
    rackId: string,
    input: CreatePhysicalAssetInput,
  ): Promise<PhysicalAsset | null> {
    if (!this.racks.has(rackId)) return null;
    const host = input.deviceId ? await this.hosts.getHost(input.deviceId) : null;
    if (input.deviceId && !host) return null;
    const template =
      (input.templateId ? this.templates.get(input.templateId) : null) ??
      (input.catalogKey
        ? [...this.templates.values()].find((item) => item.catalogKey === input.catalogKey) ?? null
        : null);
    if ((input.templateId || input.catalogKey) && !template) return null;
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
      slots: [],
      modules: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.assets.set(asset.id, asset);

    const applyTemplate = input.applyTemplate ?? true;
    const materialized = materializeTemplate(
      applyTemplate && template
        ? { structureConfirmed: template.structureConfirmed, slots: template.slots, ports: template.ports.map((port) => ({ ...port })) }
        : { structureConfirmed: false, slots: [], ports: [] },
      { genericPorts: input.genericPorts },
    );
    for (const slot of materialized.slots) {
      const slotDto: PhysicalSlot = {
        id: id('slot'),
        assetId: asset.id,
        index: slot.index,
        label: slot.label,
        module: null,
        ports: [],
      };
      this.slots.set(slotDto.id, slotDto);
    }
    const slotByIndex = new Map(
      [...this.slots.values()].filter((slot) => slot.assetId === asset.id).map((slot) => [slot.index, slot]),
    );
    const templatePortByName = new Map(
      (template?.ports ?? []).map((item) => [item.name, item.id]),
    );
    for (const port of materialized.ports) {
      const created = await this.createPort(asset.id, {
        name: port.name,
        label: port.label,
        order: port.sortOrder,
        side: port.side,
        type: port.type,
      });
      if (!created) continue;
      const stored = this.ports.get(created.id)!;
      stored.role = port.role;
      /** Vínculo estável com a declaração do catálogo (mesma semântica do Prisma). */
      if (port.templatePortName) {
        stored.templatePortId = templatePortByName.get(port.templatePortName) ?? null;
      }
      if (port.slotIndex !== null) {
        const slot = slotByIndex.get(port.slotIndex);
        if (slot) stored.slotId = slot.id;
      }
    }
    return clone(this.assetView(asset));
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
      slotId: null,
      moduleId: null,
      name: input.name.trim(),
      label: input.label?.trim() ?? '',
      order: input.order,
      side: input.side ?? 'DEVICE',
      type: input.type ?? 'OTHER',
      role: 'MANUAL',
      notes: input.notes?.trim() ?? '',
      pairedPortId: input.pairedPortId ?? null,
      templatePortId: null,
      mappedInterfaceId: mapped?.id ?? null,
      mappedInterface: mapped ?? null,
      connectionId: null,
      state: mapped ? 'MAPPED' : 'FREE',
      operStatus: mapped?.operStatus ?? null,
      lldp: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.ports.set(port.id, port);
    return clone(port);
  }

  async updatePort(idValue: string, input: UpdatePhysicalPortInput): Promise<PhysicalPort | null> {
    const port = this.ports.get(idValue);
    if (!port) return null;
    if (input.mappedInterfaceId !== undefined && input.mappedInterfaceId) {
      const asset = this.assets.get(port.assetId);
      const mapped = asset ? await this.mappedInterface(asset, input.mappedInterfaceId) : undefined;
      if (!mapped) return null;
      port.mappedInterfaceId = mapped.id;
      port.mappedInterface = mapped;
    } else if (input.mappedInterfaceId === null) {
      port.mappedInterfaceId = null;
      port.mappedInterface = null;
    }
    if (input.name !== undefined) port.name = input.name.trim();
    if (input.label !== undefined) port.label = input.label.trim();
    if (input.type !== undefined) port.type = input.type;
    if (input.notes !== undefined) port.notes = input.notes.trim();
    port.updatedAt = now();
    return clone(this.portView(port));
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

  /** Maps existing interfaces first, keeps template/manual ports, never deletes cables. */
  /**
   * Maps the real chassis connectors of the Device and ignores every logical
   * interface. Only PHYSICAL interfaces may create a connector; UNKNOWN names
   * may fill an existing port but never fabricate one.
   */
  async syncInterfacePorts(assetId: string): Promise<InterfaceSyncExecution | null> {
    const asset = this.assets.get(assetId);
    if (!asset?.deviceId) return null;
    const host = await this.hosts.getHost(asset.deviceId);
    if (!host) return null;
    const assetPorts = [...this.ports.values()].filter((port) => port.assetId === assetId);
    /** Nome de interface declarado no catálogo para a porta (via template port). */
    const templatePortNameById = new Map(
      (asset.template?.ports ?? []).map((item) => [item.id, item.name]),
    );
    const catalogInterfaceNameOf = (port: { templatePortId: string | null }) =>
      port.templatePortId ? (templatePortNameById.get(port.templatePortId) ?? null) : null;
    const plan = planInterfaceSync(
      assetPorts.map((port) => ({
        id: port.id,
        name: port.name,
        side: port.side,
        mappedInterfaceId: port.mappedInterfaceId,
        catalogInterfaceName: catalogInterfaceNameOf(port),
      })),
      host.interfaces.map((item) => ({ id: item.id, name: item.name })),
      {
        vendorTemplate: isVendorTemplate(asset.template),
        catalogKey: asset.template?.catalogKey ?? null,
      },
    );
    let order = Math.max(0, ...assetPorts.map((port) => port.order));
    const interfaceById = new Map(host.interfaces.map((item) => [item.id, item]));
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
        const port = this.ports.get(entry.portId);
        if (port) {
          port.mappedInterfaceId = item.id;
          port.mappedInterface = interfaceReference(item);
          port.updatedAt = now();
          mapped += 1;
        }
        continue;
      }
      order += 1;
      const createdPort = await this.createPort(assetId, {
        name: entry.portName ?? item.name,
        label: item.alias ?? '',
        order,
        side: 'DEVICE',
        type: 'OTHER',
        mappedInterfaceId: item.id,
      });
      if (createdPort) {
        const stored = this.ports.get(createdPort.id)!;
        stored.role = 'DISCOVERED';
        created += 1;
      }
    }
    return {
      ports: clone([...this.ports.values()].filter((port) => port.assetId === assetId)),
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
    let removed = 0;
    for (const portId of portIds) {
      if (this.ports.delete(portId)) removed += 1;
    }
    return removed;
  }

  async installModule(
    assetId: string,
    input: CreatePhysicalModuleInput,
  ): Promise<PhysicalModule | null> {
    const asset = this.assets.get(assetId);
    const slot = [...this.slots.values()].find(
      (candidate) => candidate.id === input.slotId && candidate.assetId === assetId,
    );
    if (!asset || !slot || slot.module) return null;
    const moduleTemplate = input.moduleTemplateId
      ? asset.template?.modules.find((item) => item.id === input.moduleTemplateId) ?? null
      : null;
    if (input.moduleTemplateId && !moduleTemplate) return null;

    let order = Math.max(0, ...[...this.ports.values()].filter((port) => port.assetId === assetId).map((port) => port.order));
    const module: PhysicalModule = {
      id: id('module'),
      assetId,
      slotId: slot.id,
      slotIndex: slot.index,
      moduleTemplateId: moduleTemplate?.id ?? null,
      name: input.name.trim(),
      model: input.model?.trim() || moduleTemplate?.model || '',
      serial: input.serial?.trim() ?? '',
      ports: [],
    };
    this.modules.set(module.id, module);
    slot.module = module;
    for (const templatePort of moduleTemplate?.ports ?? []) {
      order += 1;
      const created = await this.createPort(assetId, {
        name: templatePort.name,
        label: templatePort.label,
        order,
        side: 'DEVICE',
        type: templatePort.type,
      });
      if (!created) continue;
      const stored = this.ports.get(created.id)!;
      stored.moduleId = module.id;
      stored.slotId = slot.id;
      stored.role = 'TEMPLATE';
      module.ports.push(stored);
    }
    return clone(module);
  }

  async removeModule(moduleId: string): Promise<boolean> {
    const module = this.modules.get(moduleId);
    if (!module) return false;
    for (const port of [...this.ports.values()]) {
      if (port.moduleId === moduleId) this.ports.delete(port.id);
    }
    const slot = this.slots.get(module.slotId);
    if (slot) slot.module = null;
    return this.modules.delete(moduleId);
  }

  async recordLldpAdjacencies(rows: readonly PhysicalLldpAdjacencyInput[]): Promise<number> {
    for (const row of rows) {
      const key = `${row.localDeviceId}|${row.localPortName}|${row.remoteHostname}|${row.remotePortName}`;
      const existing = [...this.lldp.values()].find(
        (item) =>
          item.localDeviceId === row.localDeviceId &&
          item.localPortName === row.localPortName &&
          item.remoteHostname === row.remoteHostname &&
          item.remotePortName === row.remotePortName,
      );
      const record: PhysicalLldpAdjacencyRecord = {
        ...row,
        id: existing?.id ?? id('lldp'),
        observedAt: row.observedAt.toISOString(),
      };
      this.lldp.set(key, record);
    }
    return rows.length;
  }

  async listLldpAdjacencies(): Promise<PhysicalLldpAdjacencyRecord[]> {
    return clone([...this.lldp.values()]);
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

  async updateConnection(
    idValue: string,
    input: UpdatePhysicalConnectionInput,
  ): Promise<PhysicalConnection | null> {
    const connection = this.connections.get(idValue);
    if (!connection) return null;
    const timestamp = now();
    if (input.medium !== undefined) connection.medium = input.medium;
    if (input.label !== undefined) connection.label = input.label.trim();
    if (input.notes !== undefined) connection.notes = input.notes.trim();
    if (input.lengthMeters !== undefined) connection.lengthMeters = input.lengthMeters;
    connection.updatedAt = timestamp;
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
