/**
 * MAP-VISUAL-V2 — identidade de seleção do enlace (Fase C).
 *
 * Espelha o contrato do mapa operacional (network-canvas.tsx + map-store.ts):
 *  - o id da aresta é `linkId` no caminho primário e `linkId:path:<n>` nos
 *    caminhos visuais extras;
 *  - clicar num enlace seleciona `{ kind: 'link', id: linkId }` — ou seja,
 *    TODOS os caminhos do mesmo link compartilham a seleção, e circuitos
 *    paralelos distintos continuam sendo links diferentes.
 *
 * Este módulo é puro para poder ser testado e reutilizado no laboratório sem
 * tocar no store de produção.
 */

import type { NetworkLink } from '@gmj/shared';

export const LINK_PATH_EDGE_SEPARATOR = ':path:';

/** Mesma convenção de ids usada por network-canvas.tsx. */
export function pathEdgeId(linkId: string, pathIndex: number): string {
  if (!Number.isFinite(pathIndex) || pathIndex <= 0) return linkId;
  return `${linkId}${LINK_PATH_EDGE_SEPARATOR}${pathIndex}`;
}

export function pathIndexFromEdgeId(edgeId: string, linkId: string): number {
  if (edgeId === linkId) return 0;
  const prefix = `${linkId}${LINK_PATH_EDGE_SEPARATOR}`;
  if (!edgeId.startsWith(prefix)) return 0;
  const parsed = Number.parseInt(edgeId.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface LinkEdgeIdentity {
  edgeId: string;
  linkId: string;
  pathIndex: number;
}

export function resolveEdgeIdentity(edgeId: string, linkId: string): LinkEdgeIdentity {
  return { edgeId, linkId, pathIndex: pathIndexFromEdgeId(edgeId, linkId) };
}

/** Seleção de enlace no formato exato do map-store. */
export interface LinkSelection {
  kind: 'link';
  id: string;
}

export function selectionFromEdge(linkId: string): LinkSelection {
  return { kind: 'link', id: linkId };
}

export function isEdgeSelected(selection: LinkSelection | null, linkId: string): boolean {
  return selection?.kind === 'link' && selection.id === linkId;
}

/** Resolve o link de domínio a partir da identidade da aresta (contrato V1). */
export function findLinkForEdge(
  links: readonly Pick<NetworkLink, 'id'>[],
  identity: LinkEdgeIdentity,
): Pick<NetworkLink, 'id'> | null {
  return links.find((link) => link.id === identity.linkId) ?? null;
}

/**
 * Agrupa arestas por link — usado para provar que caminhos visuais do mesmo
 * enlace não viram circuitos separados e que paralelos permanecem distintos.
 */
export function groupEdgesByLink(
  edges: readonly LinkEdgeIdentity[],
): Map<string, LinkEdgeIdentity[]> {
  const groups = new Map<string, LinkEdgeIdentity[]>();
  for (const edge of edges) {
    const bucket = groups.get(edge.linkId) ?? [];
    bucket.push(edge);
    groups.set(edge.linkId, bucket);
  }
  return groups;
}
