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
  PhysicalPortSide,
  PhysicalPortState,
  PhysicalRack,
  PhysicalSyncDiagnostic,
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

/** Porta considerada pelo plano de sincronização. */
export interface InterfaceSyncPort {
  id: string;
  name: string;
  side: PhysicalPortSide;
  mappedInterfaceId: string | null;
  /**
   * Nome de interface declarado no catálogo (`interfaceNamePattern`) para esta
   * porta. É a **primeira** correlação tentada, antes do nome persistido: o
   * catálogo é a verdade do SKU e não depende de a porta ter sido renomeada.
   */
  catalogInterfaceName?: string | null;
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
 * Identity of a connector name as declared by a panel family.
 *
 * - `label`: short vendor panel label with a single ordinal (`100GE-1`, `SFP28-3`);
 * - `hierarchical`: CLI name with slot/subslot/port (`100GE1/0/1`, `ge-0/0/2`).
 *
 * Used to correlate a template label with the real CLI name when both describe
 * the same family but cannot be compared textually. The family keeps internal
 * digits (`100GE` ≠ `10GE`) and drops only the trailing ordinal.
 */
export interface PanelFamilyIdentity {
  family: string;
  kind: 'label' | 'hierarchical';
  /** every number of the name, in order (used for natural sorting) */
  numbers: number[];
}

export function panelFamilyIdentity(name: string): PanelFamilyIdentity | null {
  const raw = name.trim();
  if (!raw) return null;
  const hierarchical = /[/:]/.test(raw);
  const head = (hierarchical ? raw.split(/[/:]/)[0] : raw) ?? '';
  const trailing = /(\d+)(?!.*\d)/.exec(head);
  if (!trailing) return null;
  const family = head
    .slice(0, head.length - trailing[1]!.length)
    .replace(/\+/g, 'plus')
    .replace(/[\s_.-]+/g, '')
    .toLowerCase();
  if (!family || !/[a-z]/.test(family)) return null;
  return {
    family,
    kind: hierarchical ? 'hierarchical' : 'label',
    numbers: [...raw.matchAll(/\d+/g)].map((match) => Number(match[0])),
  };
}

function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? -1;
    const right = b[index] ?? -1;
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * Correlates panel labels with hierarchical CLI names of the same family.
 *
 * A catalog may declare `100GE-1` while the device reports `100GE1/0/1`. The
 * correlation is positional and only happens when both sides describe the same
 * family with the **same amount of connectors**, so a device reporting a subset
 * never receives a guessed mapping. Multiple families are handled independently
 * and hierarchical↔hierarchical pairs are never correlated (ambiguous).
 */
export function correlatePanelLabels(
  ports: ReadonlyArray<Pick<PhysicalPort, 'id' | 'name' | 'side' | 'mappedInterfaceId'>>,
  interfaces: readonly InterfaceSyncTarget[],
): Map<string, string> {
  const correlation = new Map<string, string>();
  const free = ports.filter((port) => port.side === 'DEVICE' && !port.mappedInterfaceId);
  const byFamily = new Map<string, { portIds: string[]; portNumbers: number[][] }>();
  for (const port of free) {
    const identity = panelFamilyIdentity(port.name);
    if (!identity || identity.kind !== 'label') continue;
    const bucket = byFamily.get(identity.family) ?? { portIds: [], portNumbers: [] };
    bucket.portIds.push(port.id);
    bucket.portNumbers.push(identity.numbers);
    byFamily.set(identity.family, bucket);
  }
  const interfacesByFamily = new Map<string, { ids: string[]; numbers: number[][] }>();
  for (const item of interfaces) {
    if (classifyPhysicalInterface(item.name).classification !== 'PHYSICAL') continue;
    const identity = panelFamilyIdentity(item.name);
    if (!identity || identity.kind !== 'hierarchical') continue;
    const bucket = interfacesByFamily.get(identity.family) ?? { ids: [], numbers: [] };
    bucket.ids.push(item.id);
    bucket.numbers.push(identity.numbers);
    interfacesByFamily.set(identity.family, bucket);
  }
  for (const [family, candidates] of byFamily) {
    const devices = interfacesByFamily.get(family);
    if (!devices || devices.ids.length !== candidates.portIds.length) continue;
    const orderedPorts = candidates.portIds
      .map((id, index) => ({ id, numbers: candidates.portNumbers[index]! }))
      .sort((a, b) => compareNumbers(a.numbers, b.numbers));
    const orderedInterfaces = devices.ids
      .map((id, index) => ({ id, numbers: devices.numbers[index]! }))
      .sort((a, b) => compareNumbers(a.numbers, b.numbers));
    orderedInterfaces.forEach((item, index) => {
      correlation.set(item.id, orderedPorts[index]!.id);
    });
  }
  return correlation;
}

/**
 * Alias de família restrito a modelos do catálogo: alguns chassis declaram o
 * rótulo do painel com uma família diferente da que o CLI reporta.
 *
 * No S6730 o painel declara `10GE-N`/`QSFP28-N` enquanto o VRP responde
 * `XGigabitEthernet<slot>/<subslot>/N` e `100GE<slot>/<subslot>/N`. A exceção é
 * amarrada ao `catalogKey` de propósito: `100GE` não é `QSFP28` e
 * `XGigabitEthernet` não é `10GE` em outros modelos (F1A-8H20Q, S6750 etc.).
 */
const CATALOG_PANEL_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'huawei-s6730-h24x6c': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
  'huawei-s6730-h48x6c': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
  'huawei-s6730-h24x6c-v2': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
  'huawei-s6730-h48x6c-v2': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
};

/**
 * Correlação ordinal por alias declarado no catálogo (exceção do modelo).
 *
 * Vale **somente** para os `catalogKey` de `CATALOG_PANEL_ALIASES` e somente
 * quando o device reporta exatamente a quantidade de conectores daquela família
 * no painel — subconjunto nunca é adivinhado. O ordinal é o último número do
 * nome, então `XGigabitEthernet1/0/1` também casa com `10GE-1` (o slot não é
 * fixo). Ordinal duplicado (`100GE0/0/1` + `100GE1/0/1`) invalida a família.
 */
export function correlateCatalogPanelAliases(
  ports: ReadonlyArray<Pick<PhysicalPort, 'id' | 'name' | 'side' | 'mappedInterfaceId'>>,
  interfaces: readonly InterfaceSyncTarget[],
  catalogKey: string | null | undefined,
): Map<string, string> {
  const correlation = new Map<string, string>();
  const aliases = catalogKey ? CATALOG_PANEL_ALIASES[catalogKey.trim().toLowerCase()] : undefined;
  if (!aliases) return correlation;

  for (const [cliFamily, panelFamily] of Object.entries(aliases)) {
    const panelPorts = new Map<number, string>();
    let usable = true;
    for (const port of ports) {
      if (port.side !== 'DEVICE' || port.mappedInterfaceId) continue;
      const identity = panelFamilyIdentity(port.name);
      if (identity?.kind !== 'label' || identity.family !== panelFamily) continue;
      const ordinal = identity.numbers.at(-1);
      if (ordinal === undefined || panelPorts.has(ordinal)) {
        usable = false;
        break;
      }
      panelPorts.set(ordinal, port.id);
    }
    if (!usable || panelPorts.size === 0) continue;

    const devices = new Map<number, string>();
    for (const item of interfaces) {
      if (classifyPhysicalInterface(item.name).classification !== 'PHYSICAL') continue;
      const identity = panelFamilyIdentity(item.name);
      if (identity?.kind !== 'hierarchical' || identity.family !== cliFamily) continue;
      const ordinal = identity.numbers.at(-1);
      if (ordinal === undefined || devices.has(ordinal)) {
        usable = false;
        break;
      }
      devices.set(ordinal, item.id);
    }
    // Conservador: a quantidade reportada tem de bater com a do painel.
    if (!usable || devices.size !== panelPorts.size) continue;

    const pending = new Map<string, string>();
    for (const [ordinal, interfaceId] of devices) {
      const portId = panelPorts.get(ordinal);
      if (!portId) {
        usable = false;
        break;
      }
      pending.set(interfaceId, portId);
    }
    if (!usable) continue;
    for (const [interfaceId, portId] of pending) correlation.set(interfaceId, portId);
  }

  return correlation;
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
 *
 * Ordem de correlação (a mais específica primeiro, nunca por posição quando há
 * ambiguidade):
 *
 * 1. `mappedInterface` existente (idempotência);
 * 2. `catalogInterfaceName` **exato** (nome CLI declarado no catálogo);
 * 3. `catalogInterfaceName` normalizado;
 * 4. `port.name` exato/normalizado (identidade persistida);
 * 5. aliases do modelo (`correlateCatalogPanelAliases`, ex.: S6730);
 * 6. correlação segura por família/ordinal (`correlatePanelLabels`);
 * 7. ambíguo → não mapeia.
 *
 * `catalogKey` habilita a exceção de alias do modelo
 * (`correlateCatalogPanelAliases`): o S6730 declara `10GE-N`/`QSFP28-N` e o VRP
 * responde `XGigabitEthernet<slot>/<subslot>/N`/`100GE<slot>/<subslot>/N`.
 */
export function planInterfaceSync(
  ports: readonly InterfaceSyncPort[],
  interfaces: readonly InterfaceSyncTarget[],
  options: { vendorTemplate?: boolean; catalogKey?: string | null } = {},
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
  /** Panel label (`100GE-1`) ↔ CLI name (`100GE1/0/1`) correlation. */
  const panelCorrelation = correlatePanelLabels(ports, interfaces);
  // Exceção orientada pelo catálogo (S6730): `10GE-N` ↔ `XGigabitEthernet0/0/N`
  // e `QSFP28-N` ↔ `100GE0/0/N`. Só preenche o que a correlação genérica não
  // reivindicou, para nunca roubar um par já resolvido.
  const correlatedPorts = new Set(panelCorrelation.values());
  for (const [interfaceId, portId] of correlateCatalogPanelAliases(
    ports,
    interfaces,
    options.catalogKey,
  )) {
    if (panelCorrelation.has(interfaceId) || correlatedPorts.has(portId)) continue;
    panelCorrelation.set(interfaceId, portId);
    correlatedPorts.add(portId);
  }

  const findFreePort = (interfaceName: string) => {
    const matches = freePorts.filter(
      (port) => !claimed.has(port.id) && interfaceMatchesPort(port.name, interfaceName),
    );
    // Ambiguidade nunca é resolvida por posição: o plano segue sem mapear.
    return matches.length === 1 ? matches[0] : undefined;
  };

  /**
   * Correlação pelo nome CLI declarado no catálogo (`interfaceNamePattern`).
   * Exato primeiro; depois a comparação normalizada, mas só quando ela aponta
   * para **uma** porta — duas portas equivalentes significam catálogo ambíguo.
   */
  const findFreePortByCatalogInterface = (interfaceName: string) => {
    const target = interfaceName.trim().toLowerCase();
    if (!target) return undefined;
    const candidates = freePorts.filter(
      (port) => !claimed.has(port.id) && Boolean(port.catalogInterfaceName?.trim()),
    );
    const exact = candidates.filter(
      (port) => port.catalogInterfaceName!.trim().toLowerCase() === target,
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
    const normalized = candidates.filter((port) =>
      interfaceMatchesPort(port.catalogInterfaceName!, interfaceName),
    );
    return normalized.length === 1 ? normalized[0] : undefined;
  };

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
    // 1) nome CLI declarado no catálogo (`interfaceNamePattern`) — mais forte que
    //    a identidade persistida, que pode ter sido editada pelo operador;
    // 2) identidade persistida da porta (exata/normalizada, nunca posicional).
    const catalogCandidate = findFreePortByCatalogInterface(item.name);
    const candidate = catalogCandidate ?? findFreePort(item.name);

    if (candidate) {
      claimed.add(candidate.id);
      const mapReason = catalogCandidate
        ? `Interface declarada no catálogo: ${candidate.catalogInterfaceName}`
        : breakout
          ? `Canal de breakout (lane ${breakout.lane}) vinculado ao cage ${candidate.name}`
          : `Vinculada à porta ${candidate.name} do equipamento`;
      plan.push({
        interfaceId: item.id,
        interfaceName: item.name,
        classification,
        action: 'MAP',
        portId: candidate.id,
        portName: null,
        reason: mapReason,
      });
      continue;
    }

    // Painel curto declarado no catálogo (`100GE-1`) x nome CLI hierárquico do
    // equipamento (`100GE1/0/1`): correlação ordinal por família, nunca
    // adivinhada quando as contagens divergem.
    if (classification === 'PHYSICAL') {
      const correlatedPortId = panelCorrelation.get(item.id);
      const correlated = correlatedPortId
        ? freePorts.find((port) => port.id === correlatedPortId)
        : undefined;
      if (correlated && !claimed.has(correlated.id)) {
        claimed.add(correlated.id);
        plan.push({
          interfaceId: item.id,
          interfaceName: item.name,
          classification,
          action: 'MAP',
          portId: correlated.id,
          portName: null,
          reason: `Correlação de painel: ${correlated.name} ↔ ${item.name}`,
        });
        continue;
      }
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

/**
 * Diagnóstico legível do plano de sincronização.
 *
 * Separa o que o equipamento respondeu e **não** virou conector: nomes
 * físicos/desconhecidos (`unrecognized`, o caso que precisa de correlação nova)
 * e interfaces lógicas ignoradas de propósito (VLAN/bridge/lane). Nada é
 * mapeado por conta própria para "limpar" o aviso.
 */
export function syncDiagnostics(plan: readonly InterfaceSyncPlanEntry[]): {
  unrecognized: PhysicalSyncDiagnostic[];
  ignoredLogical: PhysicalSyncDiagnostic[];
} {
  const unrecognized: PhysicalSyncDiagnostic[] = [];
  const ignoredLogical: PhysicalSyncDiagnostic[] = [];
  for (const entry of plan) {
    if (entry.action !== 'SKIP') continue;
    const diagnostic: PhysicalSyncDiagnostic = {
      interfaceName: entry.interfaceName,
      classification: entry.classification,
      reason: entry.reason,
    };
    if (entry.classification === 'LOGICAL') ignoredLogical.push(diagnostic);
    else unrecognized.push(diagnostic);
  }
  return { unrecognized, ignoredLogical };
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

