/**
 * Fase E — renderer do enlace bidirecional.
 *
 * Garante que o desenho tem UMA trajetória com DUAS metades, cada uma com sua
 * cor/seta/stream, que a área de clique continua sendo o caminho completo (o
 * mesmo da V1) e que estados sem tráfego nunca ganham animação.
 */

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { cloneDemoMaps, type LinkVisualPath, type NetworkLink } from '@gmj/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  TrafficEdgeV2Weather,
  type LinkV2WeatherEdgeData,
  type LinkV2WeatherFlowEdge,
} from './traffic-edge-v2-weathermap';
import { resolveRealLinkV2 } from '@/lib/map-visual-v2-link';
import type { LinkV2AnimationMode } from '@/lib/map-visual-v2-weathermap';

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => children,
  };
});

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const FRESH = new Date(NOW - 30_000).toISOString();
const G = 1_000_000_000;
const baseLink = cloneDemoMaps()[0]!.links[0]!;

function link(overrides: Partial<NetworkLink> = {}): NetworkLink {
  return {
    ...structuredClone(baseLink),
    capacityBps: 100 * G,
    status: 'UP',
    trafficMode: 'BIDIRECTIONAL',
    sourceInterfaceId: 'if-a',
    targetInterfaceId: 'if-b',
    directions: {
      A_TO_B: { bps: 62 * G, utilization: 62, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
      B_TO_A: { bps: 41 * G, utilization: 41, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
    },
    ...overrides,
  };
}

function renderEdge(
  options: {
    linkOverrides?: Partial<NetworkLink>;
    collectionStamp?: string | null;
    animation?: LinkV2AnimationMode;
    selected?: boolean;
    showLabels?: boolean;
    placements?: LinkV2WeatherEdgeData['placements'];
    manualOffset?: { dx: number; dy: number } | null;
    visualPath?: { curvature: number };
    autoOffset?: number;
    coordinates?: { sourceX: number; sourceY: number; targetX: number; targetY: number };
  } = {},
): string {
  const target = link(options.linkOverrides);
  const visual = resolveRealLinkV2(target, {
    nowMs: NOW,
    collectionStamp: options.collectionStamp === undefined ? FRESH : options.collectionStamp,
  });
  const data: LinkV2WeatherEdgeData = {
    link: target,
    visual,
    animation: options.animation ?? 'smart',
    manualOffset: options.manualOffset ?? null,
    manualHalf: 'a2b',
    placements: options.placements ?? { a2b: null, b2a: null, state: null },
    ...(options.visualPath
      ? { visualPath: options.visualPath as LinkVisualPath }
      : {}),
    autoOffset: options.autoOffset ?? 0,
    showLabels: options.showLabels ?? true,
    dimmed: false,
    emphasized: false,
  };
  const edge: LinkV2WeatherFlowEdge = {
    id: target.id,
    source: 'a',
    target: 'b',
    type: 'trafficWeather',
    data,
  };
  const coordinates = options.coordinates ?? { sourceX: 10, sourceY: 20, targetX: 310, targetY: 160 };
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(TrafficEdgeV2Weather, {
        id: edge.id,
        type: 'trafficWeather',
        source: edge.source,
        target: edge.target,
        data: edge.data!,
        selected: options.selected ?? false,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        ...coordinates,
      }),
    ),
  );
}

function pathsFor(html: string, testId: string): string[] {
  return [...html.matchAll(new RegExp(`<path\\b[^>]*data-testid="${testId}"[^>]*>`, 'g'))].map(
    (match) => match[0],
  );
}

describe('renderer do enlace bidirecional', () => {
  it('desenha duas metades, duas setas e uma única trajetória clicável', () => {
    const html = renderEdge();
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    const arrows = pathsFor(html, 'traffic-edge-v2-arrow');
    expect(halves).toHaveLength(2);
    expect(arrows).toHaveLength(2);
    expect(halves[0]).toContain('data-half="a2b"');
    expect(halves[1]).toContain('data-half="b2a"');
    // Cada metade recebe a cor da SUA utilização (62% atenção / 41% normal).
    expect(halves[0]).toContain('var(--wm-util-attention)');
    expect(halves[1]).toContain('var(--wm-util-normal)');
    // Área de clique única, com o caminho completo.
    const hitarea = pathsFor(html, 'traffic-edge-v2-hitarea');
    expect(hitarea).toHaveLength(1);
    expect(hitarea[0]).toContain('class="traffic-edge__hitarea"');
  });

  it('as setas convergem: uma aponta para cada lado do centro', () => {
    const html = renderEdge({
      coordinates: { sourceX: 0, sourceY: 0, targetX: 300, targetY: 0 },
    });
    const arrows = pathsFor(html, 'traffic-edge-v2-arrow');
    const angleOf = (raw: string) => Number(/rotate\((-?[\d.]+)\)/.exec(raw)![1]);
    const xOf = (raw: string) => Number(/translate\((-?[\d.]+),/.exec(raw)![1]);
    const a = angleOf(arrows[0]!);
    const b = angleOf(arrows[1]!);
    // Reta horizontal (mesma Y): A→B para a direita, B→A para a esquerda.
    expect(Math.abs(a)).toBeLessThan(1);
    expect(Math.abs(Math.abs(b) - 180)).toBeLessThan(1);
    expect(xOf(arrows[0]!)).toBeLessThan(xOf(arrows[1]!));
  });

  it('usa a mesma geometria da V1 para o clique e divide o traçado ao meio', () => {
    const html = renderEdge();
    const hitarea = pathsFor(html, 'traffic-edge-v2-hitarea')[0]!;
    const full = /d="(M[^"]+)"/.exec(hitarea)![1];
    // V1: M10,20 C160,20 160,160 310,160 (curvatura e offset idênticos).
    expect(full).toBe('M10,20 C160,20 160,160 310,160');
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    const first = /d="(M[^"]+)"/.exec(halves[0]!)![1]!;
    const second = /d="(M[^"]+)"/.exec(halves[1]!)![1]!;
    // A metade A começa na ponta A; a metade B termina na ponta B.
    expect(first.startsWith('M10,20')).toBe(true);
    expect(second.endsWith('310,160')).toBe(true);
    // E as duas se encontram no MESMO ponto (centro do enlace).
    const firstEnd = /C[\d.,\s-]+?(-?[\d.]+),(-?[\d.]+)$/.exec(first);
    const secondStart = /^M(-?[\d.]+),(-?[\d.]+)/.exec(second)!;
    expect(Number(firstEnd![1])).toBeCloseTo(Number(secondStart[1]), 6);
    expect(Number(firstEnd![2])).toBeCloseTo(Number(secondStart[2]), 6);
  });

  it('a espessura é a mesma nas duas metades (capacidade do enlace)', () => {
    const html = renderEdge({
      linkOverrides: {
        capacityBps: 100 * G,
        directions: {
          A_TO_B: { bps: 1 * G, utilization: 1, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 99 * G, utilization: 99, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      },
    });
    const widths = pathsFor(html, 'traffic-edge-v2-half').map(
      (raw) => /stroke-width:([\d.]+)/.exec(raw)![1],
    );
    expect(widths[0]).toBe(widths[1]);
    expect(widths[0]).toBe('4.5');
  });

  it('DOWN: duas metades tracejadas, sem seta, sem animação e rótulo DOWN', () => {
    const html = renderEdge({ linkOverrides: { status: 'DOWN' } });
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      expect(half).toContain('var(--wm-state-down)');
      expect(half).toContain('stroke-dasharray');
      expect(half).toContain('data-valid="false"');
    }
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(0);
    expect(pathsFor(html, 'traffic-edge-v2-stream')).toHaveLength(0);
    expect(html).toContain('>DOWN<');
  });

  it('SEM DADOS: cinza tracejado, sem setas e sem stream', () => {
    const html = renderEdge({ collectionStamp: null });
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    expect(halves[0]).toContain('var(--wm-state-no-data)');
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(0);
    expect(pathsFor(html, 'traffic-edge-v2-stream')).toHaveLength(0);
    expect(html).toContain('>SEM DADOS<');
  });

  it('telemetria antiga não anima nem desenha seta de tráfego', () => {
    const old = new Date(NOW - 30 * 60_000).toISOString();
    const html = renderEdge({ collectionStamp: old });
    expect(pathsFor(html, 'traffic-edge-v2-stream')).toHaveLength(0);
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(0);
    expect(html).toContain('DADOS ANTIGOS');
  });

  it('anima só a metade em atenção no modo inteligente', () => {
    const html = renderEdge({
      animation: 'smart',
      linkOverrides: {
        directions: {
          A_TO_B: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 94 * G, utilization: 94, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      },
    });
    const streams = pathsFor(html, 'traffic-edge-v2-stream');
    expect(streams).toHaveLength(1);
    expect(streams[0]).toContain('data-half="b2a"');
    expect(streams[0]).toContain('--wm-duration');
    expect(streams[0]).toContain('--wm-period');
    // O sentido B→A anda contra a parametrização A→B da curva.
    expect(streams[0]).toContain('traffic-edge-v2__stream--reverse');
  });

  it('modo desligado remove o stream e modo sempre ativa anima enlace saudável', () => {
    const healthy: Partial<NetworkLink> = {
      directions: {
        A_TO_B: { bps: 8 * G, utilization: 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        B_TO_A: { bps: 6 * G, utilization: 6, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
      },
    };
    expect(pathsFor(renderEdge({ animation: 'off', linkOverrides: healthy }), 'traffic-edge-v2-stream')).toHaveLength(0);
    expect(pathsFor(renderEdge({ animation: 'smart', linkOverrides: healthy }), 'traffic-edge-v2-stream')).toHaveLength(0);
    expect(pathsFor(renderEdge({ animation: 'always', linkOverrides: healthy }), 'traffic-edge-v2-stream')).toHaveLength(2);
    // As setas continuam visíveis mesmo com a animação desligada.
    expect(pathsFor(renderEdge({ animation: 'off', linkOverrides: healthy }), 'traffic-edge-v2-arrow')).toHaveLength(2);
  });

  it('enlace selecionado mostra os dois sentidos e o halo do caminho completo', () => {
    const html = renderEdge({ selected: true });
    expect(html).toContain('traffic-edge-v2__halo');
    const labels = [...html.matchAll(/data-testid="traffic-edge-v2-half-label"[^>]*>([^<]*)</g)].map(
      (match) => match[1],
    );
    expect(labels).toHaveLength(2);
    expect(labels.join(' | ')).toContain('62 Gbps · 62%');
    expect(labels.join(' | ')).toContain('41 Gbps · 41%');
  });

  it('sem seleção, enlace saudável não mostra valor permanente', () => {
    const html = renderEdge({
      linkOverrides: {
        directions: {
          A_TO_B: { bps: 8 * G, utilization: 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 6 * G, utilization: 6, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      },
      showLabels: true,
    });
    expect(html).not.toContain('data-testid="traffic-edge-v2-half-label"');
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(2);
  });

  it('preserva o rótulo manual da V1 na metade configurada', () => {
    const automatic = renderEdge();
    const html = renderEdge({ manualOffset: { dx: 52, dy: -34 } });
    expect(html).toContain('data-manual="true"');
    expect(html).toContain('is-manual');
    // O rótulo manual é sempre exibido, com o valor completo do sentido.
    expect(html).toContain('62 Gbps · 62%');
    const positionOf = (raw: string) =>
      /data-manual="true"[^>]*style="transform:[^"]*translate\((-?[\d.]+)px, (-?[\d.]+)px\)"/.exec(raw);
    const manualPosition = positionOf(html);
    const automaticPosition = /style="transform:translate\(-50%, -50%\) translate\(([\d.]+)px, ([\d.]+)px\)"/.exec(
      automatic,
    );
    expect(manualPosition).not.toBeNull();
    // A posição do rótulo manual difere da automática (offset aplicado).
    expect(manualPosition![1]).not.toBe(automaticPosition![1]);
  });

  it('respeita a curvatura persistida (visualPaths) e o offset de paralelos', () => {
    const flat = renderEdge();
    const curved = renderEdge({ visualPath: { curvature: 24 } });
    const parallel = renderEdge({ autoOffset: 18 });
    const pathOf = (html: string) =>
      /<path [^>]*d="([^"]+)"[^>]*class="traffic-edge__hitarea"/.exec(html)![1];
    const flatPath = pathOf(flat);
    expect(pathOf(curved)).not.toBe(flatPath);
    expect(pathOf(parallel)).not.toBe(flatPath);
    // Estrutura preservada: sempre duas metades.
    expect(pathsFor(curved, 'traffic-edge-v2-half')).toHaveLength(2);
    expect(pathsFor(parallel, 'traffic-edge-v2-half')).toHaveLength(2);
  });

  it('enlace curto mantém as duas setas dentro do traçado', () => {
    const html = renderEdge({
      coordinates: { sourceX: 0, sourceY: 0, targetX: 60, targetY: 0 },
    });
    const arrows = pathsFor(html, 'traffic-edge-v2-arrow');
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) {
      const x = Number(/translate\((-?[\d.]+),/.exec(arrow)![1]);
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(61);
    }
  });

  it('não renderiza nada sem dados do enlace', () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(TrafficEdgeV2Weather, {
          id: 'x',
          type: 'trafficWeather',
          source: 'a',
          target: 'b',
          selected: false,
          sourceX: 0,
          sourceY: 0,
          targetX: 1,
          targetY: 1,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        }),
      ),
    );
    expect(html).toBe('');
  });
});
