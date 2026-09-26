import type { PhysicalConnection } from '@gmj/shared';
import { lldpPairKey, type PhysicalLldpGhost } from './physical-lldp';
import type { PhysicalMapLinkGhost } from './physical-map-link';

/**
 * Precedência visual das ligações do rack, por **par de PhysicalPort**:
 *
 * 1. `PhysicalConnection` persistida = cabo físico confirmado;
 * 2. ghost LLDP = sugestão física de alta confiança;
 * 3. ghost do mapa = fallback topológico (nunca tratado como cabo).
 *
 * Para o mesmo par existe exatamente um desenho. A chave é canônica (ordena os
 * dois `portId`), então A↔B e B↔A caem no mesmo par.
 */
export interface PhysicalLinkLayer {
  lldp: PhysicalLldpGhost[];
  map: PhysicalMapLinkGhost[];
}

/** Chaves canônicas dos pares já confirmados por cabo persistido. */
export function connectionPairKeys(
  connections: readonly PhysicalConnection[],
): Set<string> {
  const keys = new Set<string>();
  for (const connection of connections) {
    keys.add(lldpPairKey(connection.portAId, connection.portBId));
  }
  return keys;
}

/**
 * Aplica a precedência sobre as camadas já filtradas pelo rack/modo de exibição.
 * A entrada não é alterada e a ordem original de cada camada é preservada.
 */
export function applyPhysicalLinkPrecedence(
  connections: readonly PhysicalConnection[],
  lldpGhosts: readonly PhysicalLldpGhost[],
  mapGhosts: readonly PhysicalMapLinkGhost[],
): PhysicalLinkLayer {
  const cables = connectionPairKeys(connections);
  const lldp = lldpGhosts.filter((ghost) => !cables.has(ghost.key));
  const lldpKeys = new Set(lldp.map((ghost) => ghost.key));
  const map = mapGhosts.filter(
    (ghost) => !cables.has(ghost.key) && !lldpKeys.has(ghost.key),
  );
  return { lldp, map };
}
