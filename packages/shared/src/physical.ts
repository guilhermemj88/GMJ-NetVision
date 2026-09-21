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

/**
 * How a port came to exist inside an asset.
 * TEMPLATE: materialized from the template; DISCOVERED: created by interface
 * sync for an interface the template did not describe; MANUAL: added by hand.
 */
export type PhysicalPortRole = 'TEMPLATE' | 'DISCOVERED' | 'MANUAL';

/** SYSTEM templates come from the versioned catalog and never get duplicated. */
export type PhysicalTemplateOrigin = 'SYSTEM' | 'CUSTOM';

/**
 * Visual/operational state of a port. CONNECTED requires a persisted
 * PhysicalConnection; LLDP_DETECTED means the neighbor was seen by the existing
 * LLDP engine but the cable was not confirmed yet.
 */
export type PhysicalPortState = 'FREE' | 'MAPPED' | 'LLDP_DETECTED' | 'CONNECTED';

export type PhysicalCatalogCategory =
  | 'ROUTER'
  | 'SWITCH'
  | 'OLT'
  | 'SERVER'
  | 'PASSIVE'
  | 'POWER'
  | 'GENERIC';

export interface PhysicalCatalogPort {
  /** Real interface name whenever it is known; never invented. */
  name: string;
  label: string;
  order: number;
  side: PhysicalPortSide;
  type: PhysicalPortType;
}

export interface PhysicalCatalogSlot {
  index: number;
  label: string;
  description: string;
  /** catalog keys of the module templates accepted by this slot */
  moduleKeys: string[];
}

export interface PhysicalCatalogModule {
  key: string;
  name: string;
  model: string;
  description: string;
  slotsRequired: number;
  ports: PhysicalCatalogPort[];
}

/** One entry of the versioned equipment catalog. */
export interface PhysicalCatalogEntry {
  catalogKey: string;
  name: string;
  category: PhysicalCatalogCategory;
  manufacturer: string;
  family: string;
  model: string;
  kind: PhysicalAssetKind;
  heightU: number;
  /** True only when height/ports/slots were confirmed against vendor docs. */
  vendorVerified: boolean;
  /** False means the structure is intentionally left open for manual completion. */
  structureConfirmed: boolean;
  description: string;
  referenceUrl: string | null;
  portSummary: string | null;
  ports: PhysicalCatalogPort[];
  slots: PhysicalCatalogSlot[];
  modules: PhysicalCatalogModule[];
}

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
  catalogKey: string | null;
  name: string;
  category: PhysicalCatalogCategory | null;
  manufacturer: string;
  family: string;
  model: string;
  kind: PhysicalAssetKind;
  heightU: number;
  description: string;
  vendorVerified: boolean;
  structureConfirmed: boolean;
  referenceUrl: string | null;
  origin: PhysicalTemplateOrigin;
  ports: PhysicalTemplatePort[];
  slots: PhysicalTemplateSlotDto[];
  modules: PhysicalModuleTemplateDto[];
  createdAt: string;
  updatedAt: string;
}

export interface PhysicalTemplateSlotDto {
  id: string;
  index: number;
  label: string;
  description: string;
  moduleKeys: string[];
}

export interface PhysicalModuleTemplateDto {
  id: string;
  catalogKey: string | null;
  name: string;
  model: string;
  description: string;
  slotsRequired: number;
  ports: PhysicalCatalogPort[];
}

export interface PhysicalPort {
  id: string;
  assetId: string;
  slotId: string | null;
  moduleId: string | null;
  name: string;
  label: string;
  order: number;
  side: PhysicalPortSide;
  type: PhysicalPortType;
  role: PhysicalPortRole;
  notes: string;
  pairedPortId: string | null;
  templatePortId: string | null;
  mappedInterfaceId: string | null;
  mappedInterface: PhysicalInterfaceReference | null;
  connectionId: string | null;
  state: PhysicalPortState;
  operStatus: PhysicalInterfaceReference['operStatus'] | null;
  lldp: PhysicalPortLldp | null;
  createdAt: string;
  updatedAt: string;
}

/** LLDP view attached to a port by the existing discovery engine snapshot. */
export interface PhysicalPortLldp {
  adjacencyId: string;
  remoteHostname: string;
  remotePortName: string;
  confidence: string;
  resolved: boolean;
  ambiguous: boolean;
  source: string;
  observedAt: string;
}

export interface PhysicalSlot {
  id: string;
  assetId: string;
  index: number;
  label: string;
  module: PhysicalModule | null;
  ports: PhysicalPort[];
}

export interface PhysicalModule {
  id: string;
  assetId: string;
  slotId: string;
  slotIndex: number;
  moduleTemplateId: string | null;
  name: string;
  model: string;
  serial: string;
  ports: PhysicalPort[];
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
  slots: PhysicalSlot[];
  modules: PhysicalModule[];
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
  /** LLDP suggestions derived from the last discovery snapshot. */
  lldpSuggestions: PhysicalLldpSuggestion[];
  lldpObservedAt: string | null;
}

export interface PhysicalLldpSuggestionEndpoint {
  assetId: string;
  assetName: string;
  portId: string;
  portName: string;
  rackName: string;
  siteName: string;
}

export interface PhysicalLldpSuggestion {
  adjacencyId: string;
  confidence: string;
  /** READY: both sides mapped to physical ports; PARTIAL: only one side. */
  state: 'READY' | 'PARTIAL' | 'UNRESOLVED';
  local: PhysicalLldpSuggestionEndpoint | null;
  remote: PhysicalLldpSuggestionEndpoint | null;
  localPortName: string;
  remoteHostname: string;
  remotePortName: string;
  observedAt: string;
  reason: string;
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
  /** Materialize the template ports/slots (default true when a template is set). */
  applyTemplate?: boolean | undefined;
  /** Catalog key alternative to templateId, resolved server-side. */
  catalogKey?: string | null | undefined;
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

/** Editable fields of a physical port; the structure (slot/module) is not edited here. */
export interface UpdatePhysicalPortInput {
  name?: string | undefined;
  label?: string | undefined;
  type?: PhysicalPortType | undefined;
  notes?: string | undefined;
  mappedInterfaceId?: string | null | undefined;
}

export interface CreatePhysicalModuleInput {
  slotId: string;
  moduleTemplateId?: string | null | undefined;
  name: string;
  model?: string | undefined;
  serial?: string | undefined;
}
