import { describe, expect, it } from 'vitest';
import {
  LINK_PATH_EDGE_SEPARATOR,
  findLinkForEdge,
  groupEdgesByLink,
  isEdgeSelected,
  pathEdgeId,
  pathIndexFromEdgeId,
  resolveEdgeIdentity,
  selectionFromEdge,
} from './map-visual-v2-selection';

describe('identidade de aresta (contrato do mapa operacional)', () => {
  it('o caminho primário usa o id do link e os extras usam :path:n', () => {
    expect(LINK_PATH_EDGE_SEPARATOR).toBe(':path:');
    expect(pathEdgeId('link-1', 0)).toBe('link-1');
    expect(pathEdgeId('link-1', 1)).toBe('link-1:path:1');
    expect(pathEdgeId('link-1', 2)).toBe('link-1:path:2');
  });

  it('índice inválido degrada para o caminho primário', () => {
    expect(pathEdgeId('link-1', -1)).toBe('link-1');
    expect(pathEdgeId('link-1', Number.NaN)).toBe('link-1');
  });

  it('ida e volta do encoding preserva o índice', () => {
    for (const index of [0, 1, 2, 3]) {
      expect(pathIndexFromEdgeId(pathEdgeId('link-9', index), 'link-9')).toBe(index);
    }
  });

  it('não confunde links diferentes que compartilham prefixo', () => {
    expect(pathIndexFromEdgeId('link-10', 'link-1')).toBe(0);
    expect(pathIndexFromEdgeId('link-1:path:x', 'link-1')).toBe(0);
  });

  it('a seleção é sempre do LINK, não do caminho visual', () => {
    expect(selectionFromEdge('ll-bng-norte')).toEqual({ kind: 'link', id: 'll-bng-norte' });
    expect(isEdgeSelected({ kind: 'link', id: 'll-bng-norte' }, 'll-bng-norte')).toBe(true);
    expect(isEdgeSelected({ kind: 'link', id: 'll-bng-norte' }, 'll-bng-sul')).toBe(false);
    expect(isEdgeSelected(null, 'll-bng-norte')).toBe(false);
  });

  it('resolve a identidade e o link de domínio a partir da aresta', () => {
    const identity = resolveEdgeIdentity('link-1:path:2', 'link-1');
    expect(identity).toEqual({ edgeId: 'link-1:path:2', linkId: 'link-1', pathIndex: 2 });

    const links = [{ id: 'link-1' }, { id: 'link-2' }];
    expect(findLinkForEdge(links, identity)?.id).toBe('link-1');
    expect(findLinkForEdge(links, resolveEdgeIdentity('link-3', 'link-3'))).toBeNull();
  });

  it('agrupa caminhos visuais do mesmo enlace e mantém paralelos separados', () => {
    const grouped = groupEdgesByLink([
      resolveEdgeIdentity(pathEdgeId('ll-a', 0), 'll-a'),
      resolveEdgeIdentity(pathEdgeId('ll-a', 1), 'll-a'),
      resolveEdgeIdentity('par-1', 'par-1'),
      resolveEdgeIdentity('par-2', 'par-2'),
    ]);

    expect([...grouped.keys()].sort()).toEqual(['ll-a', 'par-1', 'par-2']);
    expect(grouped.get('ll-a')?.map((edge) => edge.pathIndex)).toEqual([0, 1]);
    expect(grouped.get('par-1')).toHaveLength(1);
    expect(grouped.get('par-1')?.[0]?.edgeId).toBe('par-1');
  });
});
