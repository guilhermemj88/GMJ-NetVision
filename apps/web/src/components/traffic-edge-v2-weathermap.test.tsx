/**
 * Fase E/F/G — renderer do enlace bidirecional.
 *
 * Garante que o desenho tem UMA trajetória com DUAS metades (recortadas com um
 * vão no centro), que o traço/seta/runner usam a COR FIXA DA DIREÇÃO (a
 * utilização vive só na plaqueta), que as plaquetas de velocidade são
 * permanentes e embutidas na linha, que a área de clique continua sendo o
 * caminho completo (o mesmo da V1) e que estados sem tráfego nunca animam.
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
    // Fase G: o traço usa a COR FIXA DA DIREÇÃO (nunca a utilização).
    expect(halves[0]).toContain('var(--wm-dir-a2b)');
    expect(halves[1]).toContain('var(--wm-dir-b2a)');
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
    // E as duas param ANTES do centro: o vão do encontro é o que mostra
    // onde A→B termina e B→A começa.
    const firstEnd = /C[\d.,\s-]+?(-?[\d.]+),(-?[\d.]+)$/.exec(first);
    const secondStart = /^M(-?[\d.]+),(-?[\d.]+)/.exec(second)!;
    const gap = Math.hypot(
      Number(secondStart[1]) - Number(firstEnd![1]),
      Number(secondStart[2]) - Number(firstEnd![2]),
    );
    expect(gap).toBeGreaterThan(6);
    expect(gap).toBeLessThan(16);
  });

  it('a cor da linha NÃO muda com a utilização: só a plaqueta muda', () => {
    const directionsOf = (aPercent: number, bPercent: number) => ({
      A_TO_B: { bps: (aPercent / 100) * 100 * G, utilization: aPercent, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' as const },
      B_TO_A: { bps: (bPercent / 100) * 100 * G, utilization: bPercent, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' as const },
    });
    const low = renderEdge({ linkOverrides: { directions: directionsOf(8, 5) } });
    const mid = renderEdge({ linkOverrides: { directions: directionsOf(62, 75) } });
    const high = renderEdge({ linkOverrides: { directions: directionsOf(94, 99) } });
    const halveOf = (html: string, half: 'a2b' | 'b2a') =>
      pathsFor(html, 'traffic-edge-v2-half').find((h) => h.includes(`data-half="${half}"`))!;
    // Traço idêntico nos três percentuais, sempre na cor da direção.
    for (const html of [low, mid, high]) {
      expect(halveOf(html, 'a2b')).toContain('stroke:var(--wm-dir-a2b)');
      expect(halveOf(html, 'b2a')).toContain('stroke:var(--wm-dir-b2a)');
    }
    // A plaqueta, sim, muda de faixa.
    const pillOf = (html: string, half: 'a2b' | 'b2a') =>
      [...html.matchAll(/<div[^>]*data-testid="traffic-edge-v2-half-label"[^>]*>/g)]
        .map((m) => m[0])
        .find((m) => m.includes(`data-half="${half}"`))!;
    expect(pillOf(low, 'a2b')).toContain('--wm-pill:var(--wm-dir-a2b)');
    expect(pillOf(low, 'b2a')).toContain('--wm-pill:var(--wm-dir-b2a)');
    expect(pillOf(mid, 'a2b')).toContain('--wm-pill:var(--wm-util-attention)');
    expect(pillOf(high, 'b2a')).toContain('--wm-pill:var(--wm-util-critical)');
    expect(pillOf(high, 'a2b')).toContain('data-band="critical"');
    expect(pillOf(mid, 'b2a')).toContain('data-band="attention"');
  });

  it('as setas fixas mantêm a forma do sentido (cheia × chevron)', () => {
    const html = renderEdge({
      linkOverrides: {
        directions: {
          A_TO_B: { bps: 20 * G, utilization: 20, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 22 * G, utilization: 22, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      },
    });
    const arrows = pathsFor(html, 'traffic-edge-v2-arrow');
    const solid = arrows.find((a) => a.includes('data-half="a2b"'))!;
    const chevron = arrows.find((a) => a.includes('data-half="b2a"'))!;
    expect(solid).toContain('data-shape="solid"');
    expect(solid).toContain('Z"');
    expect(chevron).toContain('data-shape="chevron"');
    expect(chevron).not.toContain('Z"');
    expect(chevron).toContain('fill="none"');
    // Mesma espessura nas duas metades (capacidade, não sentido).
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    expect(/stroke-width:([\d.]+)/.exec(halves[0]!)![1]).toBe(
      /stroke-width:([\d.]+)/.exec(halves[1]!)![1],
    );
  });

  it('marca o ponto de encontro no centro do enlace com um divisor vertical', () => {
    const html = renderEdge();
    const center = pathsFor(html, 'traffic-edge-v2-center');
    expect(center).toHaveLength(1);
    // Divisor vertical (→│←) entre as duas metades.
    expect(center[0]).toMatch(/d="M0,(-?[\d.]+) L0,(-?[\d.]+)"/);
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    const firstHalfPath = /d="(M[^"]+)"/.exec(halves[0]!)![1]!;
    const firstEnd = /C[\d.,\s-]+?(-?[\d.]+),(-?[\d.]+)$/.exec(firstHalfPath)!;
    const centerX = Number(/translate\((-?[\d.]+),/.exec(center[0]!)![1]);
    expect(centerX).toBeGreaterThan(Number(firstEnd[1]));
    // O marco fica na frente do fim da primeira metade e antes do início da segunda.
    const secondStart = /^M(-?[\d.]+),(-?[\d.]+)/.exec(/d="(M[^"]+)"/.exec(halves[1]!)![1]!)!;
    expect(centerX).toBeLessThan(Number(secondStart[1]));
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
    expect(pathsFor(html, 'traffic-edge-v2-runner')).toHaveLength(0);
    expect(html).toContain('>DOWN<');
  });

  it('SEM DADOS: cinza tracejado, sem setas e sem stream', () => {
    const html = renderEdge({ collectionStamp: null });
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    expect(halves[0]).toContain('var(--wm-state-no-data)');
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(0);
    expect(pathsFor(html, 'traffic-edge-v2-runner')).toHaveLength(0);
    expect(html).toContain('>SEM DADOS<');
  });

  it('telemetria antiga não anima nem desenha seta de tráfego', () => {
    const old = new Date(NOW - 30 * 60_000).toISOString();
    const html = renderEdge({ collectionStamp: old });
    expect(pathsFor(html, 'traffic-edge-v2-runner')).toHaveLength(0);
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(0);
    expect(html).toContain('DADOS ANTIGOS');
  });

  it('anima com setas móveis só a metade em atenção no modo inteligente', () => {
    const html = renderEdge({
      animation: 'smart',
      linkOverrides: {
        directions: {
          A_TO_B: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 94 * G, utilization: 94, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      },
    });
    const runners = [...html.matchAll(/<span[^>]*data-testid="traffic-edge-v2-runner"[^>]*>/g)].map((m) => m[0]);
    expect(runners.length).toBeGreaterThan(0);
    for (const runner of runners) {
      expect(runner).toContain('data-half="b2a"');
      // B→A caminha contra a parametrização: animação e rotação invertidas.
      expect(runner).toContain('wm-runner-reverse');
      expect(runner).toContain('auto 180deg');
      expect(runner).toContain('offset-path:path(&quot;');
    }
    // A metade normal (A→B) fica estática.
    expect(runners.some((r) => r.includes('data-half="a2b"'))).toBe(false);
  });

  it('as setas móveis usam a forma do sentido (cheia × chevron)', () => {
    const html = renderEdge({ animation: 'always' });
    const runners = [...html.matchAll(/<span[^>]*data-testid="traffic-edge-v2-runner"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[0]);
    const a2b = runners.find((r) => r.includes('data-half="a2b"'))!;
    const b2a = runners.find((r) => r.includes('data-half="b2a"'))!;
    expect(a2b).toContain('data-shape="solid"');
    expect(a2b).toContain('wm-runner-forward');
    expect(b2a).toContain('data-shape="chevron"');
    expect(b2a).toContain('fill="none"');
  });

  it('modo desligado remove o movimento e "sempre ativa" anima enlace saudável', () => {
    const healthy: Partial<NetworkLink> = {
      directions: {
        A_TO_B: { bps: 8 * G, utilization: 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        B_TO_A: { bps: 6 * G, utilization: 6, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
      },
    };
    const countRunners = (animation: 'off' | 'smart' | 'always') =>
      [...renderEdge({ animation, linkOverrides: healthy }).matchAll(/data-testid="traffic-edge-v2-runner"/g)].length;
    expect(countRunners('off')).toBe(0);
    expect(countRunners('smart')).toBe(0);
    expect(countRunners('always')).toBeGreaterThan(0);
    // As setas de sentido continuam visíveis mesmo com a animação desligada.
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

  it('sem hover/seleção, enlace saudável mostra os DOIS valores permanentes', () => {
    const html = renderEdge({
      linkOverrides: {
        directions: {
          A_TO_B: { bps: 8 * G, utilization: 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 6 * G, utilization: 6, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      },
      showLabels: true,
    });
    const labels = [...html.matchAll(/data-testid="traffic-edge-v2-half-label"[^>]*>([^<]*)</g)].map(
      (match) => match[1],
    );
    expect(labels).toHaveLength(2);
    expect(labels.join(' | ')).toContain('8 Gbps · 8%');
    expect(labels.join(' | ')).toContain('6 Gbps · 6%');
    // Plaqueta embutida (fundo opaco) e na cor da direção abaixo de 50%.
    expect(html).toContain('traffic-edge-v2__label--pill');
    expect(html).toContain('--wm-pill:var(--wm-dir-a2b)');
    expect(html).toContain('--wm-pill:var(--wm-dir-b2a)');
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
      /data-manual="true"[^>]*style="[^"]*translate\((-?[\d.]+)px, (-?[\d.]+)px\)"/.exec(raw);
    const manualPosition = positionOf(html);
    const automaticPosition =
      /style="[^"]*translate\(-50%, -50%\) translate\(([\d.]+)px, ([\d.]+)px\)"/.exec(automatic);
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

  it('SINGLE_ENDED com TX e RX da mesma interface mostra as DUAS plaquetas (Fase H)', () => {
    const single = {
      trafficMode: 'SINGLE_ENDED' as const,
      sourceInterfaceId: 'if-a',
      targetInterfaceId: null,
      directions: {
        A_TO_B: { bps: 2 * G, utilization: 2, txBps: 2 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' as const },
        B_TO_A: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: 3 * G, deltaPercent: null, consistency: 'UNKNOWN' as const },
      },
    };
    const html = renderEdge({ linkOverrides: single });
    const labels = [...html.matchAll(/data-testid="traffic-edge-v2-half-label"[^>]*>([^<]*)</g)].map(
      (match) => match[1],
    );
    expect(labels).toHaveLength(2);
    expect(labels.join(' | ')).toContain('2 Gbps · 2%');
    expect(labels.join(' | ')).toContain('3 Gbps · 3%');
    // Nenhuma metade em "sem dados" e nenhum sufixo "parcial".
    expect(html).not.toContain('sem dados');
    expect(html).not.toContain('parcial');
    // Visual inalterado: traço ciano/roxo e as duas setas.
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    expect(halves[0]).toContain('var(--wm-dir-a2b)');
    expect(halves[1]).toContain('var(--wm-dir-b2a)');
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(2);
  });

  it('SINGLE_ENDED com só TX mantém a outra direção sem dados (Fase H)', () => {
    const html = renderEdge({
      linkOverrides: {
        trafficMode: 'SINGLE_ENDED',
        sourceInterfaceId: 'if-a',
        targetInterfaceId: null,
        directions: {
          A_TO_B: { bps: 2 * G, utilization: 2, txBps: 2 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
          B_TO_A: { bps: 0, utilization: 0, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
        },
      },
    });
    const labels = [...html.matchAll(/data-testid="traffic-edge-v2-half-label"[^>]*>([^<]*)</g)].map(
      (match) => match[1],
    );
    expect(labels.join(' | ')).toContain('2 Gbps · 2%');
    expect(labels.join(' | ')).toContain('sem dados');
    const halves = pathsFor(html, 'traffic-edge-v2-half');
    expect(halves[0]).toContain('data-state="normal"');
    expect(halves[1]).toContain('data-state="unknown"');
    // Só o sentido com medição ganha seta.
    expect(pathsFor(html, 'traffic-edge-v2-arrow')).toHaveLength(1);
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
