export type PhysicalAssetKind =
  | 'NETWORK'
  | 'SERVER'
  | 'OLT'
  | 'DIO'
  | 'PATCH_PANEL'
  | 'POWER'
  | 'GENERIC';

export type PhysicalPortSide = 'DEVICE' | 'FRONT' | 'REAR';
export type PhysicalPortType = 'RJ45' | 'SFP' | 'SFP_PLUS' | 'QSFP' | 'FIBER' | 'POWER' | 'OTHER';
export type PhysicalConnectionMedium = 'FIBER' | 'COPPER' | 'DAC' | 'AOC' | 'UNKNOWN';

export interface PhysicalInterfaceReference {
  id: string;
  deviceId: string;
  name: string;
  ifIndex: number;
  alias: string | null;
  operStatus: 'UP' | 'DOWN' | 'DISABLED' | 'WARNING' | 'UNKNOWN';
}

export interface PhysicalDeviceReference {
  id: string;
  displayName: string;
  hostname: string;
  vendor: string | null;
  model: string | null;
  status: 'UP' | 'DOWN' | 'WARNING' | 'UNKNOWN';
}

export interface PhysicalTemplatePort {
  id: string;
  name: string;
  label: string;
  order: number;
  side: PhysicalPortSide;
  type: PhysicalPortType;
  pairedTemplatePortId: string | null;
}

export interface PhysicalEquipmentTemplate {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  kind: PhysicalAssetKind;
  heightU: number;
  description: string;
  vendorVerified: boolean;
  ports: PhysicalTemplatePort[];
  createdAt: string;
  updatedAt: string;
}

export interface PhysicalPort {
  id: string;
  assetId: string;
  name: string;
  label: string;
  order: number;
  side: PhysicalPortSide;
  type: PhysicalPortType;
  notes: string;
  pairedPortId: string | null;
  templatePortId: string | null;
  mappedInterfaceId: string | null;
  mappedInterface: PhysicalInterfaceReference | null;
  connectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhysicalAsset {
  id: string;
  rackId: string;
  deviceId: string | null;
  templateId: string | null;
  name: string;
  kind: PhysicalAssetKind;
  startU: number;
  heightU: number;
  description: string;
  device: PhysicalDeviceReference | null;
  template: PhysicalEquipmentTemplate | null;
  ports: PhysicalPort[];
  createdAt: string;
  updatedAt: string;
}

export interface PhysicalRack {
  id: string;
  siteId: string;
  name: string;
  units: number;
  description: string;
  assets: PhysicalAsset[];
  createdAt: string;
  updatedAt: string;
}

export interface PhysicalSite {
  id: string;
  name: string;
  code: string;
  description: string;
  racks: PhysicalRack[];
  createdAt: string;
  updatedAt: string;
}

export interface PhysicalConnectionEndpoint {
  portId: string;
  portName: string;
  side: PhysicalPortSide;
  assetId: string;
  assetName: string;
  rackId: string;
  rackName: string;
  siteId: string;
  siteName: string;
}

export interface PhysicalConnection {
  id: string;
  portAId: string;
  portBId: string;
  medium: PhysicalConnectionMedium;
  label: string;
  notes: string;
  lengthMeters: number | null;
  a: PhysicalConnectionEndpoint;
  b: PhysicalConnectionEndpoint;
  createdAt: string;
  updatedAt: string;
}

export interface PhysicalInventory {
  sites: PhysicalSite[];
  templates: PhysicalEquipmentTemplate[];
  connections: PhysicalConnection[];
}

export type PhysicalPathStep =
  | {
      kind: 'PORT';
      portId: string;
      portName: string;
      side: PhysicalPortSide;
      assetId: string;
      assetName: string;
      rackName: string;
      siteName: string;
    }
  | { kind: 'CABLE'; connectionId: string; medium: PhysicalConnectionMedium; label: string }
  | { kind: 'PASS_THROUGH'; assetId: string; assetName: string };

export interface PhysicalPath {
  originPortId: string;
  steps: PhysicalPathStep[];
  endpointPortId: string;
  loopDetected: boolean;
}

export interface CreatePhysicalSiteInput {
  name: string;
  code?: string | undefined;
  description?: string | undefined;
}

export interface CreatePhysicalRackInput {
  name: string;
  units?: number | undefined;
  description?: string | undefined;
}

export interface CreatePhysicalAssetInput {
  name: string;
  kind?: PhysicalAssetKind | undefined;
  startU: number;
  heightU: number;
  description?: string | undefined;
  deviceId?: string | null | undefined;
  templateId?: string | null | undefined;
  genericPorts?: {
    count: number;
    prefix?: string | undefined;
    side?: PhysicalPortSide | undefined;
    type?: PhysicalPortType | undefined;
  } | undefined;
}

export interface CreatePhysicalPortInput {
  name: string;
  label?: string | undefined;
  order: number;
  side?: PhysicalPortSide | undefined;
  type?: PhysicalPortType | undefined;
  notes?: string | undefined;
  mappedInterfaceId?: string | null | undefined;
  pairedPortId?: string | null | undefined;
}

export interface CreatePhysicalConnectionInput {
  portAId: string;
  portBId: string;
  medium?: PhysicalConnectionMedium | undefined;
  label?: string | undefined;
  notes?: string | undefined;
  lengthMeters?: number | null | undefined;
}
