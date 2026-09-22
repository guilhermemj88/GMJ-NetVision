import type {
  CreatePhysicalAssetInput,
  CreatePhysicalConnectionInput,
  CreatePhysicalModuleInput,
  CreatePhysicalPortInput,
  CreatePhysicalRackInput,
  CreatePhysicalSiteInput,
  LldpTopologyPreview,
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalInventory,
  PhysicalLldpSuggestion,
  PhysicalPath,
} from '@gmj/shared';
import {
  assertConnectionAvailable,
  assertRackPlacement,
  buildLldpSuggestions,
  findAsset,
  findConnection,
  findRack,
  findReconcilablePorts,
  moduleIsRemovable,
  tracePhysicalPath,
} from './physical-domain';
import { PHYSICAL_CATALOG } from './physical-catalog';
import {
  loadPhysicalCatalog,
  PhysicalCatalogError,
  type CatalogLoadResult,
} from './physical-catalog-yaml';
import type {
  CreatePhysicalTemplateInput,
  PhysicalCatalogSyncResult,
  PhysicalLldpAdjacencyInput,
  PhysicalRepository,
  UpdatePhysicalAssetInput,
  UpdatePhysicalPortInput,
  UpdatePhysicalRackInput,
  UpdatePhysicalSiteInput,
} from './physical-repository';
import { PhysicalInventoryError } from './physical-repository';

export class PhysicalService {
  private catalogResolution: CatalogLoadResult | null = null;

  constructor(
    private readonly repository: PhysicalRepository,
    /**
     * Future switch for auto-confirming LLDP adjacencies. It is intentionally
     * disabled: the first version only registers a cable after a human confirms
     * the suggestion. `confirmLldpSuggestion` refuses the AUTO origin below.
     */
    private readonly autoConfirmLldp: boolean = false,
  ) {}

  /**
   * Inventory enriched with the LLDP snapshot: ports receive their derived
   * state (CONNECTED / LLDP_DETECTED / MAPPED / FREE) plus the raw observation.
   */
  async getInventory(): Promise<PhysicalInventory> {
    const [inventory, adjacencies] = await Promise.all([
      this.repository.getInventory(),
      this.repository.listLldpAdjacencies(),
    ]);
    const byInterface = new Map<string, (typeof adjacencies)[number]>();
    for (const adjacency of adjacencies) {
      if (!adjacency.localInterfaceId) continue;
      const current = byInterface.get(adjacency.localInterfaceId);
      if (!current || current.observedAt < adjacency.observedAt) {
        byInterface.set(adjacency.localInterfaceId, adjacency);
      }
    }
    const sites = inventory.sites.map((site) => ({
      ...site,
      racks: site.racks.map((rack) => ({
        ...rack,
        assets: rack.assets.map((asset) => this.withPortState(asset, byInterface)),
      })),
    }));
    const enriched: PhysicalInventory = {
      ...inventory,
      sites,
      lldpSuggestions: [],
      lldpObservedAt: adjacencies.map((row) => row.observedAt).sort().at(-1) ?? null,
    };
    return { ...enriched, lldpSuggestions: buildLldpSuggestions(enriched, adjacencies) };
  }

  /** Derives port state and attaches the LLDP observation per mapped interface. */
  private withPortState(
    asset: PhysicalAsset,
    byInterface: Map<string, { id: string; remoteHostname: string; remotePortName: string; confidence: string; resolved: boolean; ambiguous: boolean; source: string; observedAt: string }>,
  ): PhysicalAsset {
    const ports = asset.ports.map((port) => {
      const adjacency = port.mappedInterfaceId ? byInterface.get(port.mappedInterfaceId) : undefined;
      const lldp = adjacency
        ? {
            adjacencyId: adjacency.id,
            remoteHostname: adjacency.remoteHostname,
            remotePortName: adjacency.remotePortName,
            confidence: adjacency.confidence,
            resolved: adjacency.resolved,
            ambiguous: adjacency.ambiguous,
            source: adjacency.source,
            observedAt: adjacency.observedAt,
          }
        : null;
      const state = port.connectionId
        ? ('CONNECTED' as const)
        : lldp
          ? ('LLDP_DETECTED' as const)
          : port.mappedInterfaceId
            ? ('MAPPED' as const)
            : ('FREE' as const);
      return { ...port, lldp, state };
    });
    const byId = new Map(ports.map((port) => [port.id, port]));
    return {
      ...asset,
      ports,
      slots: asset.slots.map((slot) => ({
        ...slot,
        module: slot.module ? { ...slot.module, ports: slot.module.ports.map((port) => byId.get(port.id) ?? port) } : null,
        ports: slot.ports.map((port) => byId.get(port.id) ?? port),
      })),
      modules: asset.modules.map((module) => ({
        ...module,
        ports: module.ports.map((port) => byId.get(port.id) ?? port),
      })),
    };
  }

  /**
   * Catalog actually in use: `physical-catalog-v1.yaml` when present (merged by
   * `catalogKey`), otherwise the built-in TypeScript catalog.
   */
  getCatalogResolution(): CatalogLoadResult {
    this.catalogResolution ??= loadPhysicalCatalog(PHYSICAL_CATALOG);
    return this.catalogResolution;
  }

  /** Static, versioned catalog (identity + confirmed structure when available). */
  getCatalog(): readonly PhysicalCatalogEntry[] {
    return this.getCatalogResolution().entries;
  }

  /** Where the catalog came from, with warnings/errors — used by the API report/UI. */
  getCatalogSource(): {
    source: 'yaml' | 'builtin' | 'invalid';
    path: string | null;
    warnings: string[];
    errors: string[];
    schemaVersion: string | null;
    /** YAML fields the importer does not represent yet. */
    unsupportedFields: string[];
    counts: CatalogLoadResult['counts'];
    total: number;
  } {
    const resolution = this.getCatalogResolution();
    return {
      source: resolution.source,
      path: resolution.path,
      warnings: resolution.warnings,
      errors: resolution.errors,
      schemaVersion: resolution.schemaVersion,
      unsupportedFields: resolution.unsupportedFields,
      counts: resolution.counts,
      total: resolution.entries.length,
    };
  }

  /**
   * Idempotent SYSTEM template bootstrap. Never duplicates or overwrites CUSTOM.
   *
   * When the YAML exists but is invalid the bootstrap fails with
   * `PhysicalCatalogError` instead of silently loading the built-in catalog.
   */
  async bootstrapCatalog(): Promise<
    PhysicalCatalogSyncResult &
      Pick<CatalogLoadResult, 'source' | 'path' | 'warnings' | 'unsupportedFields' | 'counts'>
  > {
    const resolution = this.getCatalogResolution();
    if (resolution.source === 'invalid') {
      throw new PhysicalCatalogError(
        `physical-catalog-v1.yaml inválido em ${resolution.path ?? 'caminho desconhecido'}: o catálogo SYSTEM não foi carregado`,
        resolution.errors,
      );
    }
    const result = await this.repository.syncCatalog(resolution.entries);
    return {
      ...result,
      source: resolution.source,
      path: resolution.path,
      warnings: resolution.warnings,
      unsupportedFields: resolution.unsupportedFields,
      counts: resolution.counts,
    };
  }

  getInventoryRaw(): Promise<PhysicalInventory> {
    return this.repository.getInventory();
  }

  createSite(input: CreatePhysicalSiteInput) {
    return this.repository.createSite(input);
  }

  async updateSite(id: string, input: UpdatePhysicalSiteInput) {
    const updated = await this.repository.updateSite(id, input);
    if (!updated) throw new PhysicalInventoryError('POP não encontrado', 404);
    return updated;
  }

  async deleteSite(id: string): Promise<void> {
    const inventory = await this.repository.getInventory();
    const site = inventory.sites.find((candidate) => candidate.id === id);
    if (!site) throw new PhysicalInventoryError('POP não encontrado', 404);
    if (site.racks.length) throw new PhysicalInventoryError('Remova os racks antes de excluir o POP', 409);
    await this.repository.deleteSite(id);
  }

  async createRack(siteId: string, input: CreatePhysicalRackInput) {
    const inventory = await this.repository.getInventory();
    if (!inventory.sites.some((site) => site.id === siteId)) {
      throw new PhysicalInventoryError('POP não encontrado', 404);
    }
    const rack = await this.repository.createRack(siteId, input);
    if (!rack) throw new PhysicalInventoryError('POP não encontrado', 404);
    return rack;
  }

  async updateRack(id: string, input: UpdatePhysicalRackInput) {
    const inventory = await this.repository.getInventory();
    const rack = findRack(inventory, id);
    if (!rack) throw new PhysicalInventoryError('Rack não encontrado', 404);
    if (input.units !== undefined) {
      const highest = rack.assets.reduce(
        (maximum, asset) => Math.max(maximum, asset.startU + asset.heightU - 1),
        0,
      );
      if (highest > input.units) {
        throw new PhysicalInventoryError(`O rack possui equipamento ocupando até U${highest}`, 409);
      }
    }
    const updated = await this.repository.updateRack(id, input);
    if (!updated) throw new PhysicalInventoryError('Rack não encontrado', 404);
    return updated;
  }

  async deleteRack(id: string): Promise<void> {
    const inventory = await this.repository.getInventory();
    const rack = findRack(inventory, id);
    if (!rack) throw new PhysicalInventoryError('Rack não encontrado', 404);
    if (rack.assets.length) {
      throw new PhysicalInventoryError('Remova os equipamentos antes de excluir o rack', 409);
    }
    await this.repository.deleteRack(id);
  }

  createTemplate(input: CreatePhysicalTemplateInput) {
    return this.repository.createTemplate({ ...input, vendorVerified: false });
  }

  /**
   * A real Device belongs to at most one physical asset (the link is 1:1), so a
   * second equipment cannot claim a Device that is already on the rack.
   */
  private assertDeviceAvailable(
    inventory: PhysicalInventory,
    deviceId: string | null | undefined,
    ignoredAssetId?: string,
  ): void {
    if (!deviceId) return;
    const owner = inventory.sites
      .flatMap((site) => site.racks)
      .flatMap((rack) => rack.assets)
      .find((asset) => asset.deviceId === deviceId && asset.id !== ignoredAssetId);
    if (owner) {
      throw new PhysicalInventoryError(
        `Este Device já está vinculado ao equipamento físico ${owner.name}`,
        409,
      );
    }
  }

  /**
   * Creates the asset. When the resolved template has a confirmed structure it
   * is the source of truth for the chassis height; an unconfirmed structure
   * keeps whatever the operator informed, because nothing was verified.
   */
  async createAsset(rackId: string, input: CreatePhysicalAssetInput) {
    const inventory = await this.repository.getInventory();
    const rack = findRack(inventory, rackId);
    if (!rack) throw new PhysicalInventoryError('Rack não encontrado', 404);
    this.assertDeviceAvailable(inventory, input.deviceId);
    const template = input.templateId
      ? inventory.templates.find((candidate) => candidate.id === input.templateId)
      : input.catalogKey
        ? inventory.templates.find((candidate) => candidate.catalogKey === input.catalogKey)
        : undefined;
    const normalized: CreatePhysicalAssetInput =
      template && template.structureConfirmed
        ? { ...input, heightU: template.heightU, kind: input.kind ?? template.kind }
        : input;
    assertRackPlacement(rack, normalized as PhysicalAsset);
    const created = await this.repository.createAsset(rackId, normalized);
    if (!created) throw new PhysicalInventoryError('Rack, Device ou template não encontrado', 404);
    return created;
  }

  async updateAsset(id: string, input: UpdatePhysicalAssetInput) {
    const inventory = await this.repository.getInventory();
    const current = findAsset(inventory, id);
    if (!current) throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
    if (input.deviceId !== undefined && input.deviceId !== current.deviceId) {
      this.assertDeviceAvailable(inventory, input.deviceId, current.id);
    }
    const rack = findRack(inventory, current.rackId);
    if (!rack) throw new PhysicalInventoryError('Rack não encontrado', 404);
    assertRackPlacement(
      rack,
      {
        startU: input.startU ?? current.startU,
        heightU: input.heightU ?? current.heightU,
      } as PhysicalAsset,
      current.id,
    );
    const updated = await this.repository.updateAsset(id, input);
    if (!updated) throw new PhysicalInventoryError('Device ou template não encontrado', 404);
    return updated;
  }

  async deleteAsset(id: string): Promise<void> {
    const inventory = await this.repository.getInventory();
    const asset = findAsset(inventory, id);
    if (!asset) throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
    if (asset.ports.some((port) => port.connectionId)) {
      throw new PhysicalInventoryError('Desconecte os cabos antes de excluir o equipamento', 409);
    }
    await this.repository.deleteAsset(id);
  }

  async createPort(assetId: string, input: CreatePhysicalPortInput) {
    const inventory = await this.repository.getInventory();
    if (!findAsset(inventory, assetId)) {
      throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
    }
    const port = await this.repository.createPort(assetId, input);
    if (!port) throw new PhysicalInventoryError('Interface real não encontrada', 404);
    return port;
  }

  async pairPorts(portId: string, pairedPortId: string) {
    const inventory = await this.repository.getInventory();
    const ports = inventory.sites.flatMap((site) =>
      site.racks.flatMap((rack) => rack.assets.flatMap((asset) => asset.ports)),
    );
    const a = ports.find((port) => port.id === portId);
    const b = ports.find((port) => port.id === pairedPortId);
    if (!a || !b) throw new PhysicalInventoryError('Uma ou ambas as portas não existem', 404);
    if (a.id === b.id) throw new PhysicalInventoryError('Uma porta não pode ser pareada consigo mesma');
    if (a.assetId !== b.assetId) {
      throw new PhysicalInventoryError('A passagem FRONT/REAR deve pertencer ao mesmo equipamento');
    }
    if (a.pairedPortId || b.pairedPortId) {
      throw new PhysicalInventoryError('Uma das portas já possui passagem interna', 409);
    }
    if (new Set([a.side, b.side]).size !== 2 || ![a.side, b.side].every((side) => side !== 'DEVICE')) {
      throw new PhysicalInventoryError('O pareamento passivo exige uma porta FRONT e uma REAR');
    }
    const result = await this.repository.pairPorts(portId, pairedPortId);
    if (!result) throw new PhysicalInventoryError('Não foi possível parear as portas', 409);
    return result;
  }

  /**
   * Maps the Device interfaces onto physical connectors. Logical interfaces
   * (VLAN, bridge, sub-interface, lane) are reported, never turned into ports.
   */
  async syncInterfacePorts(assetId: string) {
    const inventory = await this.repository.getInventory();
    const asset = findAsset(inventory, assetId);
    if (!asset) throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
    if (!asset.deviceId) {
      throw new PhysicalInventoryError('Vincule um Device real antes de sincronizar interfaces');
    }
    const result = await this.repository.syncInterfacePorts(assetId);
    if (!result) throw new PhysicalInventoryError('Device real não encontrado', 404);
    return { ...result, badPorts: findReconcilablePorts(result.ports) };
  }

  /**
   * Removes connectors that the old sync fabricated for logical interfaces.
   * Ports with a cable, template ports and manual ports are never touched.
   */
  async reconcilePorts(assetId: string) {
    const inventory = await this.repository.getInventory();
    const asset = findAsset(inventory, assetId);
    if (!asset) throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
    const bad = findReconcilablePorts(asset.ports);
    const removable = bad.filter((item) => {
      const port = asset.ports.find((candidate) => candidate.id === item.id);
      return port ? !port.connectionId : false;
    });
    const removableIds = new Set(removable.map((item) => item.id));
    const removed = removable.length ? await this.repository.deletePorts([...removableIds]) : 0;
    return {
      removed,
      kept: bad.length - removable.length,
      removedPorts: removable,
      keptPorts: bad.filter((item) => !removableIds.has(item.id)),
    };
  }

  async createConnection(input: CreatePhysicalConnectionInput) {
    const inventory = await this.repository.getInventory();
    const ports = inventory.sites.flatMap((site) =>
      site.racks.flatMap((rack) => rack.assets.flatMap((asset) => asset.ports)),
    );
    const a = ports.find((port) => port.id === input.portAId);
    const b = ports.find((port) => port.id === input.portBId);
    assertConnectionAvailable(a, b);
    const created = await this.repository.createConnection(input);
    if (!created) throw new PhysicalInventoryError('Uma das portas foi ocupada por outra operação', 409);
    return created;
  }

  async updatePort(portId: string, input: UpdatePhysicalPortInput) {
    const updated = await this.repository.updatePort(portId, input);
    if (!updated) throw new PhysicalInventoryError('Porta física não encontrada', 404);
    return updated;
  }

  /**
   * Installs a board in an asset slot. When the template declares the modules
   * accepted by the slot, an unknown module is rejected instead of guessed.
   */
  async installModule(assetId: string, input: CreatePhysicalModuleInput) {
    const inventory = await this.repository.getInventory();
    const asset = findAsset(inventory, assetId);
    if (!asset) throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
    const slot = asset.slots.find((candidate) => candidate.id === input.slotId);
    if (!slot) throw new PhysicalInventoryError('Slot não encontrado neste equipamento', 404);
    if (slot.module) throw new PhysicalInventoryError('O slot já possui um módulo instalado', 409);
    const allowedKeys = asset.template?.slots.find((templateSlot) => templateSlot.index === slot.index)?.moduleKeys ?? [];
    if (allowedKeys.length) {
      const moduleKey = asset.template?.modules.find(
        (module) => module.id === input.moduleTemplateId,
      )?.catalogKey;
      const isGenericBoard = !input.moduleTemplateId && Boolean(input.name?.trim());
      if (!isGenericBoard && (!moduleKey || !allowedKeys.includes(moduleKey))) {
        throw new PhysicalInventoryError('Este slot não aceita o módulo selecionado', 409);
      }
    }
    const created = await this.repository.installModule(assetId, input);
    if (!created) throw new PhysicalInventoryError('Não foi possível instalar o módulo', 409);
    return created;
  }

  /**
   * Removes a board only when it breaks neither a cable nor an interface
   * mapping; module ports own both references.
   */
  async removeModule(moduleId: string): Promise<void> {
    const inventory = await this.repository.getInventory();
    const module = inventory.sites
      .flatMap((site) => site.racks)
      .flatMap((rack) => rack.assets)
      .flatMap((asset) => asset.modules)
      .find((candidate) => candidate.id === moduleId);
    if (!module) throw new PhysicalInventoryError('Módulo não encontrado', 404);
    if (!moduleIsRemovable(module)) {
      throw new PhysicalInventoryError(
        'Desconecte os cabos e remova o vínculo com Interface antes de retirar o módulo',
        409,
      );
    }
    const removed = await this.repository.removeModule(moduleId);
    if (!removed) throw new PhysicalInventoryError('Módulo não encontrado', 404);
  }

  /**
   * Persists the LLDP snapshot produced by the existing discovery pipeline.
   * The physical module never queries SNMP/SSH by itself.
   */
  async recordLldpPreview(preview: LldpTopologyPreview): Promise<number> {
    const observedAt = new Date(preview.createdAt);
    const rows: PhysicalLldpAdjacencyInput[] = preview.adjacencies.map((adjacency) => ({
      localDeviceId: adjacency.sourceHostId,
      localInterfaceId: adjacency.sourceInterfaceId,
      localPortName: adjacency.sourcePort,
      remoteDeviceId: adjacency.targetHostId,
      remoteHostname: adjacency.targetHostname,
      remotePortName: adjacency.targetPort,
      remoteInterfaceId: adjacency.targetInterfaceId,
      remoteChassisId: adjacency.targetChassisId,
      confidence: adjacency.confidence,
      resolved: Boolean(
        adjacency.sourceInterfaceId && adjacency.targetInterfaceId && adjacency.targetHostId,
      ),
      ambiguous: adjacency.confidence === 'AMBIGUOUS',
      source: adjacency.source,
      observedAt,
    }));
    if (!rows.length) return 0;
    return this.repository.recordLldpAdjacencies(rows);
  }

  listLldpSuggestions(): Promise<PhysicalLldpSuggestion[]> {
    return this.getInventory().then((inventory) => inventory.lldpSuggestions);
  }

  /**
   * Registers the cable suggested by LLDP. Only a READY suggestion (both sides
   * mapped to physical ports, correlation CONFIRMED) can be confirmed, and only
   * from an explicit human action.
   */
  async confirmLldpSuggestion(
    adjacencyId: string,
    options: { origin?: 'MANUAL' | 'AUTO'; medium?: CreatePhysicalConnectionInput['medium'] } = {},
  ) {
    if ((options.origin ?? 'MANUAL') === 'AUTO') {
      throw new PhysicalInventoryError(
        'Auto-confirmação LLDP ainda não habilitada: confirme a conexão manualmente',
        409,
      );
    }
    const inventory = await this.getInventory();
    const suggestion = inventory.lldpSuggestions.find((item) => item.adjacencyId === adjacencyId);
    if (!suggestion) throw new PhysicalInventoryError('Sugestão LLDP não encontrada', 404);
    if (suggestion.state !== 'READY' || !suggestion.local || !suggestion.remote) {
      throw new PhysicalInventoryError(
        suggestion.reason || 'Sugestão LLDP não pode ser confirmada automaticamente',
        409,
      );
    }
    if (suggestion.local.portId === suggestion.remote.portId) {
      throw new PhysicalInventoryError('Sugestão LLDP aponta para a mesma porta', 409);
    }
    const created = await this.createConnection({
      portAId: suggestion.local.portId,
      portBId: suggestion.remote.portId,
      medium: options.medium ?? 'FIBER',
      label: `LLDP ${suggestion.localPortName} ↔ ${suggestion.remoteHostname}`,
      notes: `Confirmado a partir de adjacência LLDP ${adjacencyId}`,
    });
    return { connection: created, suggestion };
  }

  /** Exposed so callers can assert the auto-confirm policy is still off. */
  isAutoConfirmEnabled(): boolean {
    return this.autoConfirmLldp;
  }

  async deleteConnection(id: string): Promise<void> {
    const inventory = await this.repository.getInventory();
    if (!findConnection(inventory, id)) {
      throw new PhysicalInventoryError('Conexão física não encontrada', 404);
    }
    await this.repository.deleteConnection(id);
  }

  async trace(portId: string): Promise<PhysicalPath> {
    return tracePhysicalPath(await this.repository.getInventory(), portId);
  }
}
