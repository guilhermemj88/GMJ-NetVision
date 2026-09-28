import type { NetworkLink, PhysicalInventory } from '@gmj/shared';
import { lldpPairKey, type PhysicalLldpGhostSide } from './physical-lldp';
import { physicalPortNameView } from './physical-port-name';

/**
 * Fallback topológico do rack.
 *
 * O `NetworkLink` do mapa lógico **não é cabo físico**: ele só é desenhado
 * quando as duas pontas (`sourceInterfaceId`/`targetInterfaceId`) apontam para
 * `PhysicalPort` existentes, e sempre com aparência mais discreta que o LLDP.
 *
 * A correlação usa os IDs já persistidos (`PhysicalPort.mappedInterfaceId`),
 * nunca nome de interface/porta. Quando uma das pontas não tem conector físico,
 * o link não vira desenho: nada é inventado.
 */

/** Só o que o fallback precisa de um `NetworkLink` (as duas pontas por ID). */
export type PhysicalMapLinkSource = Pick<
  NetworkLink,
  | 'id'
  | 'sourceDeviceId'
  | 'sourceInterfaceId'
  | 'targetDeviceId'
  | 'targetInterfaceId'
  | 'label'
  | 'status'
  | 'discoverySource'
>;

export interface PhysicalMapLinkGhost {
  /** Chave canônica do par físico (`portA|portB` ordenado). */
  key: string;
  /** Enlace do mapa que originou o fallback (uma única linha por par). */
  linkId: string;
  label: string;
  status: NetworkLink['status'];
  discoverySource: NetworkLink['discoverySource'];
  from: PhysicalLldpGhostSide;
  to: PhysicalLldpGhostSide;
  /** As duas pontas estão em POPs diferentes. */
  external: boolean;
}

/**
 * Conector físico ligado a uma interface do Device.
 *
 * `deviceId` só restringe a busca quando o enlace o informa; a igualdade de
 * `mappedInterfaceId` é o vínculo confiável. Sem conector, devolve `null`.
 */
function sideForInterface(
  inventory: PhysicalInventory,
  deviceId: string | null,
  interfaceId: string | null,
): PhysicalLldpGhostSide | null {
  if (!interfaceId) return null;
  for (const site of inventory.sites) {
    for (const rack of site.racks) {
      for (const asset of rack.assets) {
        if (deviceId && asset.deviceId !== deviceId) continue;
        const port = asset.ports.find((candidate) => candidate.mappedInterfaceId === interfaceId);
        if (!port) continue;
        return {
          siteId: site.id,
          siteName: site.name,
          rackId: rack.id,
          rackName: rack.name,
          assetId: asset.id,
          assetName: asset.name,
          portId: port.id,
          portName: physicalPortNameView(port).displayName,
        };
      }
    }
  }
  return null;
}

/**
 * Um fallback por par físico (A↔B e B↔A deduplicam), escolhido de forma
 * determinística pelo id do enlace. Enlaces com ponta sem conector físico são
 * descartados inteiros — nunca desenhamos meia linha.
 */
export function buildPhysicalMapLinkGhosts(
  inventory: PhysicalInventory,
  links: readonly PhysicalMapLinkSource[],
): PhysicalMapLinkGhost[] {
  const byKey = new Map<string, PhysicalMapLinkGhost>();
  const ordered = [...links].sort((left, right) => left.id.localeCompare(right.id));
  for (const link of ordered) {
    if (!link.sourceInterfaceId || !link.targetInterfaceId) continue;
    const from = sideForInterface(inventory, link.sourceDeviceId, link.sourceInterfaceId);
    const to = sideForInterface(inventory, link.targetDeviceId, link.targetInterfaceId);
    if (!from || !to) continue;
    if (from.portId === to.portId) continue;
    const key = lldpPairKey(from.portId, to.portId);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      linkId: link.id,
      label: link.label,
      status: link.status,
      discoverySource: link.discoverySource,
      from,
      to,
      external: Boolean(from.siteId && to.siteId && from.siteId !== to.siteId),
    });
  }
  return [...byKey.values()];
}

/** Fallbacks que o canvas do rack informado pode desenhar. */
export function mapLinkGhostsForRack(
  ghosts: readonly PhysicalMapLinkGhost[],
  rackId: string,
): PhysicalMapLinkGhost[] {
  if (!rackId) return [];
  return ghosts.filter((ghost) => ghost.from.rackId === rackId || ghost.to.rackId === rackId);
}
