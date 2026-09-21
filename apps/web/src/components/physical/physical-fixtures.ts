import type {
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalConnection,
  PhysicalEquipmentTemplate,
  PhysicalInventory,
  PhysicalModule,
  PhysicalPort,
  PhysicalRack,
  PhysicalSlot,
} from '@gmj/shared';

/** Shared fixtures for the physical view tests. */

export const PHYSICAL_TIMESTAMP = '2026-09-21T12:00:00.000Z';

export function physicalPort(partial: Partial<PhysicalPort> = {}): PhysicalPort {
  const id = partial.id ?? 'port-1';
  return {
    id,
    assetId: partial.assetId ?? 'asset-a',
    slotId: null,
    moduleId: null,
    name: partial.name ?? 'GE1',
    label: '',
    order: 1,
    side: 'DEVICE',
    type: 'SFP',
    role: 'TEMPLATE',
    notes: '',
    pairedPortId: null,
    templatePortId: null,
    mappedInterfaceId: null,
    mappedInterface: null,
    connectionId: null,
    state: 'FREE',
    operStatus: null,
    lldp: null,
    createdAt: PHYSICAL_TIMESTAMP,
    updatedAt: PHYSICAL_TIMESTAMP,
    ...partial,
  };
}

export function physicalModule(partial: Partial<PhysicalModule> = {}): PhysicalModule {
  return {
    id: partial.id ?? 'module-1',
    assetId: partial.assetId ?? 'asset-a',
    slotId: partial.slotId ?? 'slot-1',
    slotIndex: partial.slotIndex ?? 1,
    moduleTemplateId: null,
    name: partial.name ?? 'LPU 4x SFP+',
    model: partial.model ?? 'LPU-4SFP',
    serial: '',
    ports: partial.ports ?? [],
    ...partial,
  };
}

export function physicalSlot(partial: Partial<PhysicalSlot> = {}): PhysicalSlot {
  return {
    id: partial.id ?? 'slot-1',
    assetId: partial.assetId ?? 'asset-a',
    index: partial.index ?? 1,
    label: partial.label ?? `Slot ${partial.index ?? 1}`,
    module: partial.module ?? null,
    ports: partial.ports ?? partial.module?.ports ?? [],
  };
}

export function physicalAsset(partial: Partial<PhysicalAsset> = {}): PhysicalAsset {
  return {
    id: partial.id ?? 'asset-a',
    rackId: partial.rackId ?? 'rack-1',
    deviceId: null,
    templateId: null,
    name: partial.name ?? 'SW-01',
    kind: partial.kind ?? 'NETWORK',
    startU: partial.startU ?? 10,
    heightU: partial.heightU ?? 1,
    description: '',
    device: null,
    template: null,
    ports: partial.ports ?? [],
    slots: partial.slots ?? [],
    modules: partial.modules ?? [],
    createdAt: PHYSICAL_TIMESTAMP,
    updatedAt: PHYSICAL_TIMESTAMP,
    ...partial,
  };
}

export function physicalRack(partial: Partial<PhysicalRack> = {}): PhysicalRack {
  return {
    id: partial.id ?? 'rack-1',
    siteId: partial.siteId ?? 'site-1',
    name: partial.name ?? 'Rack 01',
    units: partial.units ?? 12,
    description: '',
    assets: partial.assets ?? [],
    createdAt: PHYSICAL_TIMESTAMP,
    updatedAt: PHYSICAL_TIMESTAMP,
    ...partial,
  };
}

export function physicalConnection(partial: Partial<PhysicalConnection> = {}): PhysicalConnection {
  return {
    id: partial.id ?? 'connection-1',
    portAId: partial.portAId ?? 'port-a',
    portBId: partial.portBId ?? 'port-b',
    medium: partial.medium ?? 'FIBER',
    label: partial.label ?? 'CIR-01',
    notes: '',
    lengthMeters: null,
    a: partial.a ?? {
      portId: 'port-a',
      portName: 'GE1',
      side: 'DEVICE',
      assetId: 'asset-a',
      assetName: 'SW-01',
      rackId: 'rack-1',
      rackName: 'Rack 01',
      siteId: 'site-1',
      siteName: 'POP Centro',
    },
    b: partial.b ?? {
      portId: 'port-b',
      portName: 'LAN1',
      side: 'DEVICE',
      assetId: 'asset-b',
      assetName: 'EDD-01',
      rackId: 'rack-1',
      rackName: 'Rack 01',
      siteId: 'site-1',
      siteName: 'POP Centro',
    },
    createdAt: PHYSICAL_TIMESTAMP,
    updatedAt: PHYSICAL_TIMESTAMP,
    ...partial,
  };
}

export function physicalInventory(partial: Partial<PhysicalInventory> = {}): PhysicalInventory {
  const racks = partial.sites?.[0]?.racks;
  return {
    sites: partial.sites ?? [
      {
        id: 'site-1',
        name: 'POP Centro',
        code: 'CTO',
        description: '',
        racks: racks ?? [physicalRack()],
        createdAt: PHYSICAL_TIMESTAMP,
        updatedAt: PHYSICAL_TIMESTAMP,
      },
    ],
    templates: partial.templates ?? [],
    connections: partial.connections ?? [],
    lldpSuggestions: partial.lldpSuggestions ?? [],
    lldpObservedAt: partial.lldpObservedAt ?? null,
  };
}

export function physicalTemplate(
  partial: Partial<PhysicalEquipmentTemplate> = {},
): PhysicalEquipmentTemplate {
  return {
    id: partial.id ?? 'template-1',
    catalogKey: partial.catalogKey ?? 'generic-chassis-8-slot',
    name: partial.name ?? 'Chassis genérico modular (8 slots)',
    category: partial.category ?? 'OLT',
    manufacturer: partial.manufacturer ?? 'Genérico',
    family: '',
    model: '',
    kind: partial.kind ?? 'OLT',
    heightU: partial.heightU ?? 6,
    description: '',
    vendorVerified: false,
    structureConfirmed: true,
    referenceUrl: null,
    origin: 'SYSTEM',
    ports: partial.ports ?? [],
    slots: partial.slots ?? [],
    modules: partial.modules ?? [],
    createdAt: PHYSICAL_TIMESTAMP,
    updatedAt: PHYSICAL_TIMESTAMP,
    ...partial,
  };
}

export function catalogEntry(partial: Partial<PhysicalCatalogEntry> = {}): PhysicalCatalogEntry {
  return {
    catalogKey: partial.catalogKey ?? 'mikrotik-crs328-24p-4s-rm',
    name: partial.name ?? 'MikroTik CRS328-24P-4S+RM',
    category: partial.category ?? 'SWITCH',
    manufacturer: partial.manufacturer ?? 'MikroTik',
    family: partial.family ?? 'CRS',
    model: partial.model ?? 'CRS328-24P-4S+RM',
    kind: partial.kind ?? 'NETWORK',
    heightU: partial.heightU ?? 1,
    vendorVerified: partial.vendorVerified ?? true,
    structureConfirmed: partial.structureConfirmed ?? true,
    description: partial.description ?? 'Switch 24 portas PoE + 4 SFP+.',
    referenceUrl: partial.referenceUrl ?? null,
    portSummary: partial.portSummary ?? '24× 1G RJ45 + 4× SFP+',
    ports: partial.ports ?? [],
    slots: partial.slots ?? [],
    modules: partial.modules ?? [],
  };
}
