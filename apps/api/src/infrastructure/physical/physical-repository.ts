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
  PhysicalEquipmentTemplate,
  PhysicalInventory,
  PhysicalModule,
  PhysicalPort,
  PhysicalRack,
  PhysicalSite,
  UpdatePhysicalPortInput,
} from '@gmj/shared';

export type { UpdatePhysicalPortInput };

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

export interface PhysicalLldpAdjacencyInput {
  localDeviceId: string;
  localInterfaceId: string | null;
  localPortName: string;
  remoteDeviceId: string | null;
  remoteHostname: string;
  remotePortName: string;
  remoteInterfaceId: string | null;
  remoteChassisId: string | null;
  confidence: string;
  resolved: boolean;
  ambiguous: boolean;
  source: string;
  observedAt: Date;
}

export interface PhysicalLldpAdjacencyRecord extends Omit<PhysicalLldpAdjacencyInput, 'observedAt'> {
  id: string;
  observedAt: string;
}

export interface PhysicalCatalogSyncResult {
  created: number;
  updated: number;
  total: number;
}

/** Result of one interface synchronization run. */
export interface InterfaceSyncExecution {
  ports: PhysicalPort[];
  created: number;
  mapped: number;
  /** Logical interfaces ignored on purpose (VLAN/bridge/sub-interface/lane). */
  skippedLogical: number;
  /** Unrecognized names ignored on purpose (they never fabricate connectors). */
  skippedUnknown: number;
  /**
   * Physical interfaces deliberately not created: the asset uses an
   * authoritative vendor template, or the connector key already exists in this
   * run (breakout collapsed).
   */
  skippedByPolicy: number;
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
  /**
   * Idempotent bootstrap of the versioned catalog. SYSTEM templates are matched
   * by `catalogKey`; existing CUSTOM templates are never overwritten.
   */
  syncCatalog(entries: readonly PhysicalCatalogEntry[]): Promise<PhysicalCatalogSyncResult>;
  createAsset(rackId: string, input: CreatePhysicalAssetInput): Promise<PhysicalAsset | null>;
  updateAsset(id: string, input: UpdatePhysicalAssetInput): Promise<PhysicalAsset | null>;
  deleteAsset(id: string): Promise<boolean>;
  createPort(assetId: string, input: CreatePhysicalPortInput): Promise<PhysicalPort | null>;
  updatePort(id: string, input: UpdatePhysicalPortInput): Promise<PhysicalPort | null>;
  pairPorts(portId: string, pairedPortId: string): Promise<[PhysicalPort, PhysicalPort] | null>;
  /**
   * Maps the Device interfaces that are real chassis connectors, creates the
   * missing PHYSICAL ones and ignores every logical interface. Template and
   * manual ports are preserved; cables are never touched.
   */
  syncInterfacePorts(assetId: string): Promise<InterfaceSyncExecution | null>;
  /** Removes the given ports (used by the logical-port reconciliation). */
  deletePorts(portIds: readonly string[]): Promise<number>;
  installModule(assetId: string, input: CreatePhysicalModuleInput): Promise<PhysicalModule | null>;
  removeModule(moduleId: string): Promise<boolean>;
  createConnection(input: CreatePhysicalConnectionInput): Promise<PhysicalConnection | null>;
  updateConnection(
    id: string,
    input: UpdatePhysicalConnectionInput,
  ): Promise<PhysicalConnection | null>;
  deleteConnection(id: string): Promise<boolean>;
  recordLldpAdjacencies(rows: readonly PhysicalLldpAdjacencyInput[]): Promise<number>;
  listLldpAdjacencies(): Promise<PhysicalLldpAdjacencyRecord[]>;
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
