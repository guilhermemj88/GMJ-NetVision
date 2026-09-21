import type {
  PhysicalAsset,
  PhysicalConnection,
  PhysicalInventory,
  PhysicalPath,
  PhysicalPathStep,
  PhysicalPort,
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
