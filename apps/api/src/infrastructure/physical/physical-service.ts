import type {
  CreatePhysicalAssetInput,
  CreatePhysicalConnectionInput,
  CreatePhysicalPortInput,
  CreatePhysicalRackInput,
  CreatePhysicalSiteInput,
  PhysicalAsset,
  PhysicalInventory,
  PhysicalPath,
} from '@gmj/shared';
import {
  assertConnectionAvailable,
  assertRackPlacement,
  findAsset,
  findConnection,
  findRack,
  tracePhysicalPath,
} from './physical-domain';
import type {
  CreatePhysicalTemplateInput,
  PhysicalRepository,
  UpdatePhysicalAssetInput,
  UpdatePhysicalRackInput,
  UpdatePhysicalSiteInput,
} from './physical-repository';
import { PhysicalInventoryError } from './physical-repository';

export class PhysicalService {
  constructor(private readonly repository: PhysicalRepository) {}

  getInventory(): Promise<PhysicalInventory> {
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

  async createAsset(rackId: string, input: CreatePhysicalAssetInput) {
    const inventory = await this.repository.getInventory();
    const rack = findRack(inventory, rackId);
    if (!rack) throw new PhysicalInventoryError('Rack não encontrado', 404);
    assertRackPlacement(rack, input as PhysicalAsset);
    const created = await this.repository.createAsset(rackId, input);
    if (!created) throw new PhysicalInventoryError('Rack, Device ou template não encontrado', 404);
    return created;
  }

  async updateAsset(id: string, input: UpdatePhysicalAssetInput) {
    const inventory = await this.repository.getInventory();
    const current = findAsset(inventory, id);
    if (!current) throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
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

  async syncInterfacePorts(assetId: string) {
    const inventory = await this.repository.getInventory();
    const asset = findAsset(inventory, assetId);
    if (!asset) throw new PhysicalInventoryError('Equipamento físico não encontrado', 404);
    if (!asset.deviceId) {
      throw new PhysicalInventoryError('Vincule um Device real antes de sincronizar interfaces');
    }
    const ports = await this.repository.syncInterfacePorts(assetId);
    if (!ports) throw new PhysicalInventoryError('Device real não encontrado', 404);
    return ports;
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
