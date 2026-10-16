import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { cloneDemoMaps, type NetworkLink } from '@gmj/shared';
import { describe, expect, it, vi } from 'vitest';
import { TrafficEdgeV2, type LinkV2EdgeData, type LinkV2FlowEdge } from './traffic-edge-v2';
import { resolveRealLinkV2, linkV2CompactLabel } from '@/lib/map-visual-v2-link';
import type { LinkV2LabelPlacement } from '@/lib/map-visual-v2-labels';

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
    placement?: LinkV2LabelPlacement | null;
    showLabels?: boolean;
    manualOffset?: { dx: number; dy: number } | null;
  } = {},
): string {
  const target = link(options.linkOverrides);
  const visual = resolveRealLinkV2(target, { nowMs: NOW, collectionStamp: FRESH });
  const data: LinkV2EdgeData = {
    link: target,
    visual,
    compactLabel: linkV2CompactLabel(visual),
    manualOffset: options.manualOffset ?? null,
    placement: options.placement ?? null,
    autoOffset: 0,
    showLabels: options.showLabels ?? true,
    dimmed: false,
    emphasized: false,
  };
  const edge: LinkV2FlowEdge = {
    id: target.id,
    source: 'a',
    target: 'b',
    type: 'trafficV2',
    data,
  };
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(TrafficEdgeV2, {
        id: edge.id,
        type: 'trafficV2',
        source: edge.source,
        target: edge.target,
        data: edge.data!,
        selected: false,
        sourceX: 10,
        sourceY: 20,
        targetX: 310,
        targetY: 160,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      }),
    ),
  );
}

describe('renderer V2 do mapa real', () => {
  it('desenha UMA linha por enlace, com a cor do estado real', () => {
    const html = renderEdge();
    const lines = [...html.matchAll(/<path\b[^>]*data-testid="traffic-edge-v2-line"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(lines).toHaveLength(1);
    // 62% (utilização válida) => âmbar, o mesmo do lib puro.
    expect(lines[0]).toContain('stroke:#d9a24b');
    expect(lines[0]).toContain('data-state="attention"');
    expect(lines[0]).toContain('data-link="' + link().id + '"');
  });

  it('a espessura é compensada pelo zoom (clamp em pixels de tela)', () => {
    const html = renderEdge();
    const line = /<path\b[^>]*data-testid="traffic-edge-v2-line"[^>]*>/.exec(html)![0];
    // Em zoom 1 (padrão do renderer no teste) a largura-alvo é a de tela: 4.5 px
    // para capacidade acima de 40G.
    expect(line).toContain('stroke-width:4.5');
  });

  it('DOWN usa vermelho tracejado e rótulo DOWN', () => {
    const html = renderEdge({ linkOverrides: { status: 'DOWN' } });
    const line = /<path\b[^>]*data-testid="traffic-edge-v2-line"[^>]*>/.exec(html)![0];
    expect(line).toContain('stroke:#d25e61');
    expect(line).toContain('stroke-dasharray');
    expect(html).toContain('>DOWN<');
  });

  it('sem dados usa cinza tracejado — nunca verde de saudável', () => {
    const target = link();
    const visual = resolveRealLinkV2(target, { nowMs: NOW, collectionStamp: null });
    const html = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(TrafficEdgeV2, {
          id: target.id,
          type: 'trafficV2',
          source: 'a',
          target: 'b',
          data: {
            link: target,
            visual,
            compactLabel: 'sem dados',
            manualOffset: null,
            placement: null,
            autoOffset: 0,
            showLabels: true,
          } as LinkV2EdgeData,
          selected: false,
          sourceX: 10,
          sourceY: 20,
          targetX: 310,
          targetY: 160,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        }),
      ),
    );
    expect(html).toContain('stroke:#718894');
    expect(html).toContain('sem dados');
    expect(html).not.toContain('stroke:#43c59e');
  });

  it('mantém a área de clique do enlace e o rótulo manual da V1', () => {
    const html = renderEdge({
      manualOffset: { dx: 52, dy: -34 },
      placement: { mode: 'hidden', dx: 0, dy: 0 },
    });
    expect(html).toContain('traffic-edge__hitarea');
    expect(html).toContain('data-manual="true"');
    expect(html).toContain('is-manual');
    // Mesmo com placement escondido, o offset manual é sempre exibido.
    expect(html).toContain('>62G · 62%');
  });

  it('usa a mesma geometria do V1 para os mesmos pontos e curvatura', () => {
    const html = renderEdge();
    const line = /<path\b[^>]*data-testid="traffic-edge-v2-line"[^>]*>/.exec(html)![0];
    const path = /d="(M[^"]+)"/.exec(line)![1];
    // V1: M10,20 C160,20 160,160 310,160 (mesmos pontos de controle, offset 0).
    expect(path).toBe('M10,20 C160,20 160,160 310,160');
  });

  it('não desenha a seta quando o sentido é balanceado', () => {
    const html = renderEdge({
      linkOverrides: {
        directions: {
          A_TO_B: { bps: 50 * G, utilization: 50, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 50 * G, utilization: 50, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      },
    });
    expect(html).not.toContain('traffic-edge-v2__arrow');
  });

  it('não renderiza nada sem dados do enlace', () => {
    const html = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(TrafficEdgeV2, {
          id: 'x',
          type: 'trafficV2',
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
