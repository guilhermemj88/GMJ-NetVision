import { describe, expect, it } from 'vitest';
import { computeParallelLinkLayouts } from '@gmj/shared';
import { PATH_OFFSET_SCALE } from '@/lib/link-curvature';
import { linkV2CapacityTier, linkV2ScreenStrokeWidth } from '@/lib/map-visual-v2';
import { resolveMapVisualMode } from '@/lib/map-visual-mode';
import { LAB_OFFSETS_MAP_ID } from '@/lib/map-visual-v2-offsets';
import { LINK_V2_LABEL_HEIGHT, estimateLabelWidth } from '@/lib/map-visual-v2-labels';
import {
  buildBezierGeometry,
  pointOnBezier,
  type Point,
  type SidePosition,
} from '@/lib/map-visual-v2-geometry';
import { SCENARIO_REAL } from './v2-fixture-real';
import { SCENARIO_DENSE, type MockLink, type MockNode, type MockScenario } from './v2-scenarios';
import {
  LAB_NODE_HEIGHT,
  LAB_NODE_WIDTH,
  LINK_V2_CURVATURE,
  buildLinkV2Model,
  nodeAnchor,
  type LinkV2EdgeModel,
  type LinkV2Model,
  type LinkV2ModelOptions,
} from './v2-model';

const NOW = 1_800_000_000_000;

/** Mesma escolha de lados do modelo (aproximação determinística). */
function sideFor(a: MockNode, b: MockNode): { source: SidePosition; target: SidePosition } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  }
  return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}

function options(overrides: Partial<LinkV2ModelOptions> = {}): LinkV2ModelOptions {
  return {
    nowMs: NOW,
    showAllLabels: false,
    selectedEdgeId: null,
    selectedNodeId: null,
    simulation: null,
    expandedLagIds: [],
    ...overrides,
  };
}

/** Âncora do rótulo: mesmo ponto médio da curva usado pelo modelo. */
function labelAnchor(scenario: MockScenario, link: MockLink, layouts: Map<string, { offset: number }>): Point {
  const a = scenario.nodes.find((node) => node.id === link.a);
  const b = scenario.nodes.find((node) => node.id === link.b);
  if (!a || !b) throw new Error(`enlace ${link.id} sem extremidades`);
  const sides = sideFor(a, b);
  const offset =
    (layouts.get(link.logicalLinkId ?? link.id)?.offset ?? 0) +
    (link.curvature ?? 0) * PATH_OFFSET_SCALE;
  const geometry = buildBezierGeometry({
    sourceX: nodeAnchor(a, sides.source).x,
    sourceY: nodeAnchor(a, sides.source).y,
    sourcePosition: sides.source,
    targetX: nodeAnchor(b, sides.target).x,
    targetY: nodeAnchor(b, sides.target).y,
    targetPosition: sides.target,
    curvature: LINK_V2_CURVATURE,
    offset,
  });
  return pointOnBezier(geometry, 0.5);
}

function layoutsFor(scenario: MockScenario) {
  return computeParallelLinkLayouts(
    scenario.links.map((link) => ({
      id: link.logicalLinkId ?? link.id,
      sourceKey: link.a,
      targetKey: link.b,
      layoutMode: 'AUTO' as const,
    })),
  );
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

/** Caixa do rótulo exatamente como a anticolisão e o renderer a posicionam. */
function labelRect(
  scenario: MockScenario,
  model: LinkV2Model,
  edge: LinkV2EdgeModel,
  layouts: Map<string, { offset: number }>,
  zoom: number,
): Rect {
  const link = scenario.links.find((item) => item.id === edge.linkId);
  const placement = model.placements.get(edge.id);
  if (!link || !placement) throw new Error(`sem colocação para ${edge.id}`);
  const scale = 1 / Math.max(0.25, zoom);
  const width = estimateLabelWidth(
    placement.mode === 'compact' ? edge.compactLabelText : edge.labelText,
  ) * scale;
  const height = LINK_V2_LABEL_HEIGHT * scale;
  const anchor = labelAnchor(scenario, link, layouts);
  const cx = anchor.x + placement.dx;
  const cy = anchor.y + placement.dy;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

function nodeRects(scenario: MockScenario): Rect[] {
  return scenario.nodes.map((node) => ({
    x: node.x,
    y: node.y,
    width: LAB_NODE_WIDTH,
    height: LAB_NODE_HEIGHT,
  }));
}

describe('fixture de geometria real (Fase C)', () => {
  it('preserva o snapshot: 25 nós, 31 linhas e nenhuma extremidade órfã', () => {
    expect(SCENARIO_REAL.nodes).toHaveLength(25);
    expect(SCENARIO_REAL.links).toHaveLength(31);

    const nodeIds = new Set(SCENARIO_REAL.nodes.map((node) => node.id));
    expect(nodeIds.size).toBe(25);

    for (const link of SCENARIO_REAL.links) {
      expect(nodeIds.has(link.a)).toBe(true);
      expect(nodeIds.has(link.b)).toBe(true);
      expect(link.a).not.toBe(link.b);
    }
    for (const node of SCENARIO_REAL.nodes) {
      expect(node.x).toBeTypeOf('number');
      expect(node.y).toBeTypeOf('number');
    }
  });

  it('mantém a distribuição de capacidades e de paralelos do mapa real', () => {
    const tiers = new Map<number, number>();
    for (const link of SCENARIO_REAL.links) {
      const width = linkV2CapacityTier(link.capacityBps)?.width ?? 0;
      tiers.set(width, (tiers.get(width) ?? 0) + 1);
    }
    // 29 enlaces acima de 40G (4.5) e 2 entre 1G e 10G (2.0) — só isso existe no mapa.
    expect([...tiers.entries()].sort((a, b) => b[0] - a[0])).toEqual([
      [4.5, 29],
      [2, 2],
    ]);

    const pairs = new Map<string, number>();
    for (const link of SCENARIO_REAL.links) {
      const key = [link.a, link.b].sort().join('|');
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    const parallel = [...pairs.values()].filter((count) => count > 1).sort((a, b) => b - a);
    expect(parallel).toEqual([3, 2]);

    const curved = SCENARIO_REAL.links.filter((link) => (link.curvature ?? 0) !== 0);
    expect(curved).toHaveLength(3);

    const lengths = SCENARIO_REAL.links.map((link) => {
      const a = SCENARIO_REAL.nodes.find((node) => node.id === link.a)!;
      const b = SCENARIO_REAL.nodes.find((node) => node.id === link.b)!;
      return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
    });
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(140);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(500);
  });

  it('está sanitizada: nada de ids, devices ou redes reais', () => {
    const serialized = JSON.stringify(SCENARIO_REAL);
    expect(serialized).not.toMatch(/host-[0-9a-f]{8}/);
    expect(serialized).not.toMatch(/c[a-z0-9]{20,}/);
    expect(serialized).not.toMatch(/\b(10\.(?!90\.)\d+\.\d+\.\d+)\b/);
    for (const node of SCENARIO_REAL.nodes) {
      expect(node.id).toMatch(/^r\d{2}$/);
      expect(node.ip).toMatch(/^10\.90\.\d+\.\d+$/);
      expect(node.name).toMatch(/^[A-Z][A-Z0-9-]+-\d{2}$/);
    }
    for (const link of SCENARIO_REAL.links) {
      expect(link.id).toMatch(/^r-link-\d+(:path:\d+)?$/);
      expect(link.label).toMatch(/^Enlace \d+/);
    }
  });
});

describe('modelo V2 sobre a geometria real', () => {
  it('materializa todas as 31 linhas (nenhuma aresta é descartada)', () => {
    const model = buildLinkV2Model(SCENARIO_REAL, options({ showAllLabels: true }));
    expect(model.edges).toHaveLength(31);
    for (const edge of model.edges) {
      expect(edge.id).toBe(edge.linkId);
      expect(edge.selectionId).toBe(edge.linkId);
      expect(edge.pathIndex).toBe(0);
    }
  });

  it('mantém a espessura em pixels de tela em qualquer zoom (geometria real)', () => {
    for (const zoom of [0.25, 0.5, 1, 2.2]) {
      const model = buildLinkV2Model(SCENARIO_REAL, options({ zoom }));
      for (const edge of model.edges) {
        const target = linkV2ScreenStrokeWidth(edge.networkLink.capacityBps);
        expect(edge.stroke.strokeWidth * zoom).toBeCloseTo(target, 6);
        expect(edge.haloStrokeWidth).toBeGreaterThan(edge.stroke.strokeWidth);
        expect(edge.arrowScale).toBeGreaterThan(0);
      }
    }
  });

  it('nenhum rótulo visível cobre um nó e os rótulos visíveis não se sobrepõem', () => {
    for (const [zoom, showAllLabels] of [
      [1, true],
      [1, false],
      [0.5, true],
      [2.2, false],
    ] as const) {
      const model = buildLinkV2Model(SCENARIO_REAL, options({ zoom, showAllLabels }));
      const layouts = layoutsFor(SCENARIO_REAL);
      const obstacles = nodeRects(SCENARIO_REAL);
      const visible = model.edges.filter((edge) => {
        const placement = model.placements.get(edge.id);
        return placement !== undefined && placement.mode !== 'hidden';
      });
      expect(visible.length).toBeGreaterThan(8);

      const rects = visible.map((edge) => ({
        edge,
        rect: labelRect(SCENARIO_REAL, model, edge, layouts, zoom),
      }));
      for (const { edge, rect } of rects) {
        for (const obstacle of obstacles) {
          expect(overlaps(rect, obstacle), `rótulo ${edge.id} cobrindo nó em zoom ${zoom}`).toBe(false);
        }
      }
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i]!;
          const b = rects[j]!;
          expect(overlaps(a.rect, b.rect), `${a.edge.id} × ${b.edge.id} em zoom ${zoom}`).toBe(false);
        }
      }
    }
  });

  it('prioridade alta nunca é escondida (DOWN/crítico/selecionado)', () => {
    const model = buildLinkV2Model(SCENARIO_REAL, options({ showAllLabels: false }));
    const kept = model.edges.filter((edge) => edge.priority >= 2);
    expect(kept.length).toBeGreaterThan(0);
    for (const edge of kept) {
      expect(model.placements.get(edge.id)?.mode).not.toBe('hidden');
    }
  });

  it('o offset manual da V1 vence a anticolisão e é contado no modelo', () => {
    const target = SCENARIO_REAL.links[0]!;
    const offsets = { [target.id]: { a: { dx: 52, dy: -34 } } };
    const model = buildLinkV2Model(SCENARIO_REAL, options({ labelOffsets: offsets, showAllLabels: true }));

    expect(model.manualLabelCount).toBe(1);
    const edge = model.edges.find((item) => item.linkId === target.id)!;
    expect(edge.manualLabelOffset).toEqual({ dx: 52, dy: -34 });
    expect(model.placements.get(edge.id)).toEqual({ mode: 'full', dx: 52, dy: -34 });

    const withoutOffset = buildLinkV2Model(SCENARIO_REAL, options({ showAllLabels: true }));
    expect(withoutOffset.manualLabelCount).toBe(0);
    expect(withoutOffset.placements.get(edge.id)?.mode).not.toBe('hidden');
  });
});

describe('identidade de seleção em circuitos paralelos e multi-caminho', () => {
  it('caminhos visuais do mesmo enlace viram UMA seleção (encoding :path:n)', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options());
    const paths = model.edges.filter((edge) => edge.selectionId === 'll-bng-norte');
    expect(paths.map((edge) => edge.id)).toEqual(['ll-bng-norte', 'll-bng-norte:path:1']);
    expect(paths.map((edge) => edge.pathIndex)).toEqual([0, 1]);
    expect(paths.every((edge) => edge.linkId !== edge.selectionId)).toBe(true);
  });

  it('paralelos continuam sendo enlaces distintos', () => {
    const model = buildLinkV2Model(SCENARIO_REAL, options());
    const byPair = new Map<string, Set<string>>();
    for (const edge of model.edges) {
      const link = SCENARIO_REAL.links.find((item) => item.id === edge.linkId)!;
      const key = [link.a, link.b].sort().join('|');
      const bucket = byPair.get(key) ?? new Set<string>();
      bucket.add(edge.selectionId);
      byPair.set(key, bucket);
    }
    for (const [, ids] of byPair) {
      expect(ids.size).toBeGreaterThan(0);
      for (const id of ids) expect(id).toMatch(/^r-link-\d+$/);
    }
    const parallelSizes = [...byPair.values()].map((ids) => ids.size).sort((a, b) => b - a);
    expect(parallelSizes.slice(0, 2)).toEqual([3, 2]);
  });

  it('o LAG recolhido seleciona o link representante declarado', () => {
    const model = buildLinkV2Model(SCENARIO_DENSE, options());
    const lag = model.edges.find((edge) => edge.id === 'lag:lag-centro')!;
    const group = model.groups.find((item) => item.groupId === 'lag-centro')!;
    expect(group.memberIds).toContain(lag.selectionId);
    expect(lag.linkId).toBe(lag.selectionId);
  });
});

describe('flag visual do mapa aplicada ao laboratório', () => {
  it('a preferência ausente resolve para V1 e V2 só com marcação explícita', () => {
    expect(resolveMapVisualMode({ visualMode: 'V1' })).toBe('V1');
    expect(resolveMapVisualMode({ visualMode: 'V2' })).toBe('V2');
  });

  it('os offsets manuais do laboratório ficam numa chave fictícia', () => {
    expect(LAB_OFFSETS_MAP_ID).toBe('LAB-DEMO');
    expect(LAB_OFFSETS_MAP_ID).not.toMatch(/^cm[a-z0-9]{20,}$/);
  });
});
