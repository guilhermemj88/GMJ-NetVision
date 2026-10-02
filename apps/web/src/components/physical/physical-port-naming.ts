import type {
  PhysicalAsset,
  PhysicalCatalogPort,
  PhysicalCatalogEntry,
  PhysicalInventory,
  PhysicalPort,
} from '@gmj/shared';
import { indexCatalogPorts } from './physical-panel-layout';
import { physicalPortNameView, type PhysicalPortNameView } from './physical-port-name';

/**
 * Resolvedor único da identidade apresentada das portas do módulo Físico.
 *
 * Regra de produto (uma só, aplicada em canvas/rack, inspetor de porta,
 * inspetor de conexão, CAMINHO FÍSICO, sugestões LLDP, origem/destino de cabo,
 * tooltips e formulários):
 *
 * 1. `mappedInterface.name` — nome lógico/CLI da interface do Device;
 * 2. `catalogPort.interfaceName` — nome lógico declarado no catálogo;
 * 3. `PhysicalPort.name` — identidade persistida (só como último fallback).
 *
 * O nome físico (`100GE-2`, `QSFP28-1`) **não** é apagado: ele continua
 * disponível como detalhe secundário (`Porta física: 100GE-2`).
 *
 * Nada aqui altera dados: nunca renomeia banco, asset, interface ou porta.
 * Todo o texto apresentado vem de `physicalPortNameView`, para não existirem
 * duas regras de identidade convivendo no módulo Físico.
 */
export interface LocatedPhysicalPort {
  asset: PhysicalAsset;
  port: PhysicalPort;
}

export interface PhysicalPortNamingResolver {
  /** Localiza a porta no inventário inteiro (asset + porta). */
  locate(portId: string): LocatedPhysicalPort | null;
  /** Visão de identidade de uma porta já localizada. */
  forPort(asset: PhysicalAsset, port: PhysicalPort): PhysicalPortNameView;
  /** Conector do catálogo correspondente à porta (para `conector`/velocidade). */
  catalogPortFor(asset: PhysicalAsset, port: PhysicalPort): PhysicalCatalogPort | null;
  /** Visão de identidade pelo id da porta. */
  byPortId(portId: string): PhysicalPortNameView | null;
  /** Nome principal para exibição (fallback textual quando a porta sumiu). */
  displayName(portId: string, fallback: string): string;
}

export function createPhysicalPortNamingResolver(
  inventory: PhysicalInventory,
  catalog: readonly PhysicalCatalogEntry[] = [],
): PhysicalPortNamingResolver {
  const catalogIndex = new Map<string, ReturnType<typeof indexCatalogPorts>>();
  for (const entry of catalog) {
    catalogIndex.set(entry.catalogKey, indexCatalogPorts(entry.ports));
  }

  const locate = (portId: string): LocatedPhysicalPort | null => {
    for (const site of inventory.sites) {
      for (const rack of site.racks) {
        for (const asset of rack.assets) {
          const port = asset.ports.find((candidate) => candidate.id === portId);
          if (port) return { asset, port };
        }
      }
    }
    return null;
  };

  const catalogPortFor = (asset: PhysicalAsset, port: PhysicalPort) => {
    const ports = asset.template?.catalogKey
      ? catalogIndex.get(asset.template.catalogKey)
      : undefined;
    return (
      ports?.exact.get(port.name.trim().toLowerCase()) ??
      ports?.loose.get(port.name.trim().toLowerCase().replace(/[\s_.\-/]+/g, '')) ??
      null
    );
  };

  const forPort = (asset: PhysicalAsset, port: PhysicalPort): PhysicalPortNameView =>
    physicalPortNameView(port, catalogPortFor(asset, port));

  const byPortId = (portId: string): PhysicalPortNameView | null => {
    const found = locate(portId);
    return found ? forPort(found.asset, found.port) : null;
  };

  return {
    locate,
    forPort,
    catalogPortFor,
    byPortId,
    displayName: (portId, fallback) => byPortId(portId)?.displayName ?? fallback,
  };
}
