import type {
  CreatePhysicalAssetInput,
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalConnection,
  PhysicalInterfaceClass,
  PhysicalInventory,
  PhysicalLldpSuggestion,
  PhysicalModule,
  PhysicalPath,
  PhysicalPathStep,
  PhysicalPort,
  PhysicalPortState,
  PhysicalRack,
} from '@gmj/shared';
import { breakoutCageName, classifyPhysicalInterface, physicalConnectorKey } from '@gmj/shared';
import { interfaceNameKeys } from '../topology/interface-correlation';
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

export interface InterfaceSyncTarget {
  id: string;
  name: string;
}

export interface InterfaceSyncPlanEntry {
  interfaceId: string;
  interfaceName: string;
  classification: PhysicalInterfaceClass;
  action: 'MAP' | 'CREATE' | 'SKIP';
  /** port that will receive the interface when `action` is MAP */
  portId: string | null;
  /** name of the port to create when `action` is CREATE (cage name for lanes) */
  portName: string | null;
  reason: string;
}

/**
 * True when a template port and a real interface name refer to the same chassis
 * connector. Vendor spellings (`Ethernet 1`, `ether1`, `SFP+ 1`,
 * `sfp-sfpplus1`) collapse into the same connector key; the normalized
 * `interfaceNameKeys` comparison stays as a fallback for exotic names.
 */
export function interfaceMatchesPort(portName: string, interfaceName: string): boolean {
  if (portName.trim().toLowerCase() === interfaceName.trim().toLowerCase()) return true;
  const portKey = physicalConnectorKey(portName);
  const interfaceKey = physicalConnectorKey(interfaceName);
  if (portKey && interfaceKey && portKey === interfaceKey) return true;
  const keys = new Set(interfaceNameKeys(interfaceName));
  return interfaceNameKeys(portName).some((key) => keys.has(key));
}

/**
 * True when the asset is bound to a specific vendor model (not a generic
 * template). Vendor templates are authoritative: the sync only maps interfaces
 * to the declared panel and never adds connectors.
 */
export function isVendorTemplate(
  template: { catalogKey: string | null; manufacturer: string } | null | undefined,
): boolean {
  if (!template) return false;
  if ((template.catalogKey ?? '').startsWith('generic-')) return false;
  const manufacturer = template.manufacturer.trim().toLowerCase();
  return manufacturer !== '' && manufacturer !== 'generic' && manufacturer !== 'genérico';
}

/**
 * Decides what the interface sync may do with each interface of the Device.
 *
 * | interface | comportamento |
 * | --- | --- |
 * | already mapped | MAP (idempotente) |
 * | LOGICAL + cage (`qsfp28-1-2`, `et-0/0/0:1`) | MAP no cage existente, senão SKIP |
 * | LOGICAL pura (`Vlanif`, `irb.100`, `.100`) | SKIP |
 * | UNKNOWN | MAP em porta existente, nunca cria |
 * | PHYSICAL | MAP ou CREATE (só quando o template não é de fabricante) |
 */
export function planInterfaceSync(
  ports: ReadonlyArray<Pick<PhysicalPort, 'id' | 'name' | 'side' | 'mappedInterfaceId'>>,
  interfaces: readonly InterfaceSyncTarget[],
  options: { vendorTemplate?: boolean } = {},
): InterfaceSyncPlanEntry[] {
  const freePorts = ports.filter((port) => port.side === 'DEVICE' && !port.mappedInterfaceId);
  /** Interfaces that already own a port keep it: the sync is idempotent. */
  const alreadyMapped = new Map(
    ports
      .filter((port) => port.mappedInterfaceId)
      .map((port) => [port.mappedInterfaceId as string, port]),
  );
  const claimed = new Set<string>();
  /** Connector keys created in this run: breakout stays collapsed. */
  const createdKeys = new Set<string>();
  const plan: InterfaceSyncPlanEntry[] = [];

  const findFreePort = (interfaceName: string) =>
    freePorts.find(
      (port) => !claimed.has(port.id) && interfaceMatchesPort(port.name, interfaceName),
    );

  for (const item of interfaces) {
    const existing = alreadyMapped.get(item.id);
    if (existing) {
      plan.push({
        interfaceId: item.id,
        interfaceName: item.name,
        classification: classifyPhysicalInterface(item.name).classification,
        action: 'MAP',
        portId: existing.id,
        portName: null,
        reason: `Já vinculada à porta ${existing.name}`,
      });
      continue;
    }
    const { classification, connectorKey, breakout, reason } = classifyPhysicalInterface(item.name);
    const candidate = findFreePort(item.name);

    if (candidate) {
      claimed.add(candidate.id);
      plan.push({
        interfaceId: item.id,
        interfaceName: item.name,
        classification,
        action: 'MAP',
        portId: candidate.id,
        portName: null,
        reason: breakout
          ? `Canal de breakout (lane ${breakout.lane}) vinculado ao cage ${candidate.name}`
          : `Vinculada à porta ${candidate.name} do equipamento`,
      });
      continue;
    }

    // Breakout lane without a cage port yet: a generic asset creates ONE
    // connector for the cage (never one per lane); a vendor template creates none.
    if (classification === 'LOGICAL' && breakout) {
      const cageName = breakoutCageName(item.name);
      const cagePort = cageName
        ? ports.find(
            (port) =>
              port.side === 'DEVICE' &&
              port.name.trim().toLowerCase() === cageName.trim().toLowerCase(),
          )
        : undefined;
      if (cagePort) {
        // The cage connector already exists: the first lane owns the mapping and
        // the remaining lanes are alternate views of the same cage. A second
        // connector is never created.
        if (cagePort.mappedInterfaceId) {
          plan.push({
            interfaceId: item.id,
            interfaceName: item.name,
            classification,
            action: 'SKIP',
            portId: null,
            portName: null,
            reason: `Cage ${cagePort.name} já pertence a ${cagePort.mappedInterfaceId === item.id ? 'esta interface' : 'outra interface'} (breakout colapsado)`,
          });
          continue;
        }
        plan.push({
          interfaceId: item.id,
          interfaceName: item.name,
          classification,
          action: 'MAP',
          portId: cagePort.id,
          portName: null,
          reason: `Canal de breakout (lane ${breakout.lane}) vinculado ao cage ${cagePort.name}`,
        });
        continue;
      }
      if (options.vendorTemplate) {
        plan.push({
          interfaceId: item.id,
          interfaceName: item.name,
          classification,
          action: 'SKIP',
          portId: null,
          portName: null,
          reason: 'Template de fabricante é autoritativo: nenhum conector extra é criado',
        });
        continue;
      }
      if (createdKeys.has(breakout.cageKey)) {
        plan.push({
          interfaceId: item.id,
          interfaceName: item.name,
          classification,
          action: 'SKIP',
          portId: null,
          portName: null,
          reason: `Cage ${breakout.cageKey} já criado nesta sincronização (breakout colapsado)`,
        });
        continue;
      }
      createdKeys.add(breakout.cageKey);
      plan.push({
        interfaceId: item.id,
        interfaceName: item.name,
        classification,
        action: 'CREATE',
        portId: null,
        portName: breakoutCageName(item.name) ?? item.name,
        reason: `Cage do breakout criado uma única vez (lane ${breakout.lane})`,
      });
      continue;
    }

    if (classification !== 'PHYSICAL') {
      plan.push({
        interfaceId: item.id,
        interfaceName: item.name,
        classification,
        action: 'SKIP',
        portId: null,
        portName: null,
        reason:
          classification === 'LOGICAL'
            ? reason
            : 'Nome não reconhecido: não cria conector físico',
      });
      continue;
    }
    if (options.vendorTemplate) {
      plan.push({
        interfaceId: item.id,
        interfaceName: item.name,
        classification,
        action: 'SKIP',
        portId: null,
        portName: null,
        reason: 'Template de fabricante é autoritativo: nenhum conector extra é criado',
      });
      continue;
    }
    if (connectorKey && createdKeys.has(connectorKey)) {
      plan.push({
        interfaceId: item.id,
        interfaceName: item.name,
        classification,
        action: 'SKIP',
        portId: null,
        portName: null,
        reason: `O cage ${connectorKey} já foi criado nesta sincronização (breakout colapsado)`,
      });
      continue;
    }
    if (connectorKey) createdKeys.add(connectorKey);
    plan.push({
      interfaceId: item.id,
      interfaceName: item.name,
      classification,
      action: 'CREATE',
      portId: null,
      portName: item.name,
      reason: 'Conector físico sem porta correspondente no equipamento',
    });
  }
  return plan;
}

/** An existing DISCOVERED port that should not exist (logical interface). */
export interface BadPhysicalPort {
  id: string;
  name: string;
  interfaceName: string;
  reason: string;
}

/**
 * Finds connectors that can be removed by the automatic reconciliation.
 *
 * All conditions must hold, otherwise the port is preserved:
 *
 * - role is `DISCOVERED` (the role used by the interface sync). `MANUAL` belongs
 *   to the operator and `TEMPLATE` is the curated panel — both are never touched
 *   automatically, even when the name looks logical (`Vlanif100`, `LoopBack0`);
 * - the mapped interface (or the port name, when there is no mapping) is
 *   unequivocally `LOGICAL` — `UNKNOWN` is never auto-removed;
 * - the port does not represent the cage of a collapsed breakout lane
 *   (`qsfp28-1` for `qsfp28-1-1`): the cage is a real connector and survives;
 * - the port owns no cable (`connectionId`) and no FRONT/REAR pairing;
 * - the port did not come from the template (`templatePortId`).
 */
export function findReconcilablePorts(
  ports: ReadonlyArray<
    Pick<
      PhysicalPort,
      'id' | 'name' | 'role' | 'mappedInterface' | 'connectionId' | 'pairedPortId' | 'templatePortId'
    >
  >,
): BadPhysicalPort[] {
  const found: BadPhysicalPort[] = [];
  for (const port of ports) {
    if (port.role !== 'DISCOVERED') continue;
    if (port.connectionId || port.pairedPortId || port.templatePortId) continue;
    const interfaceName = port.mappedInterface?.name ?? port.name;
    const classification = classifyPhysicalInterface(interfaceName).classification;
    if (classification !== 'LOGICAL') continue;
    /**
     * A lane is LOGICAL but its sanctioned connector is the cage: a port named
     * after the cage (`qsfp28-1` for `qsfp28-1-1`) is the collapsed breakout and
     * must survive. Only a port named after the lane itself was fabricated by
     * the old sync and can be removed.
     */
    const cageName = breakoutCageName(interfaceName);
    if (cageName && port.name.trim().toLowerCase() === cageName.trim().toLowerCase()) continue;
    found.push({
      id: port.id,
      name: port.name,
      interfaceName,
      reason: 'Conector criado pelo sync para uma interface lógica (VLAN/bridge/sub-interface/lane)',
    });
  }
  return found;
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

