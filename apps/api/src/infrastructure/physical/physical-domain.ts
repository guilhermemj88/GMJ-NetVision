import type {
  CreatePhysicalAssetInput,
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalConnection,
  PhysicalInventory,
  PhysicalLldpSuggestion,
  PhysicalModule,
  PhysicalPath,
  PhysicalPathStep,
  PhysicalPort,
  PhysicalPortState,
  PhysicalRack,
} from '@gmj/shared';
import { PhysicalInventoryError } from './physical-repository';

export function assertRackPlacement(
  rack: Pick<PhysicalRack, 'units' | 'assets'>,
  placement: Pick<PhysicalAsset, 'startU' | 'heightU'>,
  ignoredAssetId?: string,
): void {
  if (!Number.isInteger(placement.startU) || placement.startU < 1) {
    throw new PhysicalInventoryError('A posição inicial deve ser uma unidade U válida');
  }
  if (!Number.isInteger(placement.heightU) || placement.heightU < 1) {
    throw new PhysicalInventoryError('A altura deve ser de pelo menos 1U');
  }
  const endU = placement.startU + placement.heightU - 1;
  if (endU > rack.units) {
    throw new PhysicalInventoryError(`O equipamento ultrapassa o limite de ${rack.units}U`);
  }
  const overlap = rack.assets.find((asset) => {
    if (asset.id === ignoredAssetId) return false;
    const assetEnd = asset.startU + asset.heightU - 1;
    return placement.startU <= assetEnd && endU >= asset.startU;
  });
  if (overlap) {
    throw new PhysicalInventoryError(
      `A posição conflita com ${overlap.name} (U${overlap.startU}–U${overlap.startU + overlap.heightU - 1})`,
      409,
    );
  }
}

export function assertConnectionAvailable(
  portA: PhysicalPort | undefined,
  portB: PhysicalPort | undefined,
): asserts portA is PhysicalPort {
  if (!portA || !portB) throw new PhysicalInventoryError('Uma ou ambas as portas não existem', 404);
  if (portA.id === portB.id) {
    throw new PhysicalInventoryError('Uma porta não pode ser conectada a ela mesma');
  }
  if (portA.connectionId || portB.connectionId) {
    throw new PhysicalInventoryError('Uma das portas já está ocupada', 409);
  }
}

function allPorts(inventory: PhysicalInventory): PhysicalPort[] {
  return inventory.sites.flatMap((site) =>
    site.racks.flatMap((rack) => rack.assets.flatMap((asset) => asset.ports)),
  );
}

function portStep(
  inventory: PhysicalInventory,
  port: PhysicalPort,
): Extract<PhysicalPathStep, { kind: 'PORT' }> {
  for (const site of inventory.sites) {
    for (const rack of site.racks) {
      const asset = rack.assets.find((candidate) => candidate.id === port.assetId);
      if (asset) {
        return {
          kind: 'PORT',
          portId: port.id,
          portName: port.name,
          side: port.side,
          assetId: asset.id,
          assetName: asset.name,
          rackName: rack.name,
          siteName: site.name,
        };
      }
    }
  }
  throw new PhysicalInventoryError('A porta pertence a um equipamento inexistente', 409);
}

/** Follows external cables and explicit passive FRONT/REAR pairs without revisiting a port. */
export function tracePhysicalPath(inventory: PhysicalInventory, originPortId: string): PhysicalPath {
  const ports = new Map(allPorts(inventory).map((port) => [port.id, port]));
  const connections = new Map(inventory.connections.map((connection) => [connection.id, connection]));
  const origin = ports.get(originPortId);
  if (!origin) throw new PhysicalInventoryError('Porta física não encontrada', 404);

  const steps: PhysicalPathStep[] = [portStep(inventory, origin)];
  const visited = new Set<string>([origin.id]);
  let current = origin;
  let loopDetected = false;

  while (true) {
    if (current.connectionId) {
      const connection = connections.get(current.connectionId);
      if (!connection) break;
      const nextId = connection.portAId === current.id ? connection.portBId : connection.portAId;
      const next = ports.get(nextId);
      if (!next) break;
      steps.push({
        kind: 'CABLE',
        connectionId: connection.id,
        medium: connection.medium,
        label: connection.label,
      });
      if (visited.has(next.id)) {
        loopDetected = true;
        break;
      }
      visited.add(next.id);
      steps.push(portStep(inventory, next));
      current = next;
    }

    if (!current.pairedPortId) break;
    const paired = ports.get(current.pairedPortId);
    if (!paired) break;
    if (visited.has(paired.id)) {
      loopDetected = true;
      break;
    }
    const currentPortStep = portStep(inventory, current);
    steps.push({
      kind: 'PASS_THROUGH',
      assetId: currentPortStep.assetId,
      assetName: currentPortStep.assetName,
    });
    visited.add(paired.id);
    steps.push(portStep(inventory, paired));
    current = paired;
  }

  return {
    originPortId,
    steps,
    endpointPortId: current.id,
    loopDetected,
  };
}

export function findRack(inventory: PhysicalInventory, rackId: string): PhysicalRack | undefined {
  return inventory.sites.flatMap((site) => site.racks).find((rack) => rack.id === rackId);
}

export function findAsset(inventory: PhysicalInventory, assetId: string): PhysicalAsset | undefined {
  return inventory.sites
    .flatMap((site) => site.racks)
    .flatMap((rack) => rack.assets)
    .find((asset) => asset.id === assetId);
}

export function findConnection(
  inventory: PhysicalInventory,
  connectionId: string,
): PhysicalConnection | undefined {
  return inventory.connections.find((connection) => connection.id === connectionId);
}

/**
 * Port state for the UI. `operStatus` never becomes CONNECTED by itself: a
 * persisted cable is required, and an LLDP observation only ever produces
 * LLDP_DETECTED until a human confirms the physical connection.
 */
export function portState(
  port: Pick<PhysicalPort, 'connectionId' | 'mappedInterfaceId' | 'lldp'>,
): PhysicalPortState {
  if (port.connectionId) return 'CONNECTED';
  if (port.lldp) return 'LLDP_DETECTED';
  if (port.mappedInterfaceId) return 'MAPPED';
  return 'FREE';
}

interface AdjacencyLike {
  id: string;
  localDeviceId: string;
  localInterfaceId: string | null;
  localPortName: string;
  remoteDeviceId: string | null;
  remoteHostname: string;
  remotePortName: string;
  remoteInterfaceId: string | null;
  confidence: string;
  resolved: boolean;
  ambiguous: boolean;
  observedAt: string;
}

function endpointOf(
  inventory: PhysicalInventory,
  deviceId: string | null,
  interfaceId: string | null,
): { assetId: string; assetName: string; portId: string; portName: string; rackName: string; siteName: string } | null {
  if (!deviceId || !interfaceId) return null;
  for (const site of inventory.sites) {
    for (const rack of site.racks) {
      for (const asset of rack.assets) {
        if (asset.deviceId !== deviceId) continue;
        const port = asset.ports.find((candidate) => candidate.mappedInterfaceId === interfaceId);
        if (!port) continue;
        return {
          assetId: asset.id,
          assetName: asset.name,
          portId: port.id,
          portName: port.name,
          rackName: rack.name,
          siteName: site.name,
        };
      }
    }
  }
  return null;
}

/**
 * Converts LLDP adjacency snapshots into operator-facing suggestions.
 *
 * READY: both endpoints resolve to physical ports of registered assets, so the
 * operator may confirm the cable. PARTIAL: only the local (or remote) side is in
 * the physical inventory. UNRESOLVED: ambiguous or unreliable correlation — it
 * is shown but can never be confirmed automatically.
 */
export function buildLldpSuggestions(
  inventory: PhysicalInventory,
  adjacencies: readonly AdjacencyLike[],
): PhysicalLldpSuggestion[] {
  return adjacencies.map((adjacency) => {
    const local = endpointOf(inventory, adjacency.localDeviceId, adjacency.localInterfaceId);
    const remote = endpointOf(inventory, adjacency.remoteDeviceId, adjacency.remoteInterfaceId);
    const ambiguous = adjacency.ambiguous || adjacency.confidence === 'AMBIGUOUS';
    const confident = adjacency.confidence === 'CONFIRMED' || adjacency.confidence === 'PROBABLE';
    const state: PhysicalLldpSuggestion['state'] = ambiguous || !confident
      ? 'UNRESOLVED'
      : local && remote
        ? 'READY'
        : 'PARTIAL';
    const reason = ambiguous
      ? 'Correlação LLDP ambígua: confirme manualmente no equipamento antes de registrar o cabo.'
      : !confident
        ? 'Vizinho LLDP não identificado com segurança no inventário.'
        : state === 'READY'
          ? 'Ambos os lados estão no inventário físico. Confirme para registrar o cabo.'
          : 'Apenas um dos lados está no inventário físico; o cabo não pode ser confirmado por aqui.';
    return {
      adjacencyId: adjacency.id,
      confidence: adjacency.confidence,
      state,
      local,
      remote: remote ?? null,
      localPortName: adjacency.localPortName,
      remoteHostname: adjacency.remoteHostname,
      remotePortName: adjacency.remotePortName,
      observedAt: adjacency.observedAt,
      reason,
    };
  });
}

/** True when a module can be removed without breaking a cable or a mapping. */
export function moduleIsRemovable(module: Pick<PhysicalModule, 'ports'>): boolean {
  return module.ports.every((port) => !port.connectionId && !port.mappedInterfaceId);
}

export interface MaterializedSlot {
  index: number;
  label: string;
}

export interface MaterializedPort {
  name: string;
  label: string;
  sortOrder: number;
  side: PhysicalPort['side'];
  type: PhysicalPort['type'];
  /** TEMPLATE when it came from the catalog, MANUAL when informed by hand. */
  role: PhysicalPort['role'];
  slotIndex: number | null;
  /** matched against PhysicalTemplatePort.id */
  templatePortName: string | null;
}

/**
 * Builds the slots and ports an asset inherits from a catalog template.
 * `structureConfirmed: false` templates only materialize what they really have
 * (usually nothing), so nothing about a chassis is invented.
 */
export function materializeTemplate(
  template: Pick<PhysicalCatalogEntry, 'ports' | 'slots'> & {
    structureConfirmed?: boolean;
  },
  options: { genericPorts?: CreatePhysicalAssetInput['genericPorts'] } = {},
): { slots: MaterializedSlot[]; ports: MaterializedPort[] } {
  const slots = template.slots.map((slot) => ({ index: slot.index, label: slot.label }));
  const templatePorts = template.ports.map((port) => ({
    name: port.name,
    label: port.label,
    sortOrder: port.order,
    side: port.side,
    type: port.type,
    role: 'TEMPLATE' as const,
    slotIndex: null,
    templatePortName: port.name,
  }));
  const genericCount = options.genericPorts?.count ?? 0;
  const genericPorts: MaterializedPort[] = Array.from({ length: genericCount }, (_value, index) => ({
    name: `${options.genericPorts?.prefix?.trim() ?? ''}${index + 1}`,
    label: '',
    sortOrder: (templatePorts.at(-1)?.sortOrder ?? 0) + index + 1,
    side: options.genericPorts?.side ?? 'DEVICE',
    type: options.genericPorts?.type ?? 'OTHER',
    role: 'MANUAL' as const,
    slotIndex: null,
    templatePortName: null,
  }));
  return { slots, ports: [...templatePorts, ...genericPorts] };
}

