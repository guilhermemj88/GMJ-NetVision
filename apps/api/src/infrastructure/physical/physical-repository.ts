import type {
  CreatePhysicalAssetInput,
  CreatePhysicalConnectionInput,
  CreatePhysicalPortInput,
  CreatePhysicalRackInput,
  CreatePhysicalSiteInput,
  PhysicalAsset,
  PhysicalConnection,
  PhysicalEquipmentTemplate,
  PhysicalInventory,
  PhysicalPort,
  PhysicalRack,
  PhysicalSite,
} from '@gmj/shared';

export interface CreatePhysicalTemplateInput {
  name: string;
  manufacturer?: string | undefined;
  model?: string | undefined;
  kind?: PhysicalEquipmentTemplate['kind'] | undefined;
  heightU?: number | undefined;
  description?: string | undefined;
  vendorVerified?: boolean | undefined;
  ports?: Array<{
    name: string;
    label?: string | undefined;
    order: number;
    side?: PhysicalPort['side'] | undefined;
    type?: PhysicalPort['type'] | undefined;
  }> | undefined;
}

export interface UpdatePhysicalSiteInput {
  name?: string | undefined;
  code?: string | null | undefined;
  description?: string | undefined;
}

export interface UpdatePhysicalRackInput {
  name?: string | undefined;
  units?: number | undefined;
  description?: string | undefined;
}

export interface UpdatePhysicalAssetInput {
  name?: string | undefined;
  kind?: PhysicalAsset['kind'] | undefined;
  startU?: number | undefined;
  heightU?: number | undefined;
  description?: string | undefined;
  deviceId?: string | null | undefined;
  templateId?: string | null | undefined;
}

export interface PhysicalRepository {
  getInventory(): Promise<PhysicalInventory>;
  createSite(input: CreatePhysicalSiteInput): Promise<PhysicalSite>;
  updateSite(id: string, input: UpdatePhysicalSiteInput): Promise<PhysicalSite | null>;
  deleteSite(id: string): Promise<boolean>;
  createRack(siteId: string, input: CreatePhysicalRackInput): Promise<PhysicalRack | null>;
  updateRack(id: string, input: UpdatePhysicalRackInput): Promise<PhysicalRack | null>;
  deleteRack(id: string): Promise<boolean>;
  createTemplate(input: CreatePhysicalTemplateInput): Promise<PhysicalEquipmentTemplate>;
  createAsset(rackId: string, input: CreatePhysicalAssetInput): Promise<PhysicalAsset | null>;
  updateAsset(id: string, input: UpdatePhysicalAssetInput): Promise<PhysicalAsset | null>;
  deleteAsset(id: string): Promise<boolean>;
  createPort(assetId: string, input: CreatePhysicalPortInput): Promise<PhysicalPort | null>;
  pairPorts(portId: string, pairedPortId: string): Promise<[PhysicalPort, PhysicalPort] | null>;
  syncInterfacePorts(assetId: string): Promise<PhysicalPort[] | null>;
  createConnection(input: CreatePhysicalConnectionInput): Promise<PhysicalConnection | null>;
  deleteConnection(id: string): Promise<boolean>;
  disconnect(): Promise<void>;
}

export class PhysicalInventoryError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'PhysicalInventoryError';
  }
}
