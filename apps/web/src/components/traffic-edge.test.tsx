import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { cloneDemoMaps, type NetworkLink } from '@gmj/shared';
import { describe, expect, it, vi } from 'vitest';
import { TrafficEdge, type TrafficEdgeData, type TrafficFlowEdge } from './traffic-edge';

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => children,
  };
});

const baseLink = cloneDemoMaps()[0]!.links[0]!;

interface EdgeLayout {
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  sourcePosition?: Position;
  targetPosition?: Position;
}

function renderEdge(
  linkPartial: Partial<NetworkLink> = {},
  dataPartial: Partial<TrafficEdgeData> = {},
  layout: EdgeLayout = {},
): string {
  const link: NetworkLink = {
    ...structuredClone(baseLink),
    ...linkPartial,
  };
  const edge: TrafficFlowEdge = {
    id: link.id,
    source: link.sourceDeviceId ?? 'source',
    target: link.targetDeviceId ?? 'target',
    type: 'traffic',
    data: {
      link,
      showTraffic: true,
      showUtilization: true,
      showLabels: false,
      showTrafficAnimation: true,
      displayStyle: 'FLOW',
      metricDisplay: 'BOTH',
      related: true,
      emphasized: false,
      linkScale: 100,
      labelScale: 100,
      ...dataPartial,
    },
  };
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(TrafficEdge, {
        id: edge.id,
        type: 'traffic',
        source: edge.source,
        target: edge.target,
        data: edge.data!,
        selected: false,
        sourceX: layout.sourceX ?? 10,
        sourceY: layout.sourceY ?? 20,
        targetX: layout.targetX ?? 310,
        targetY: layout.targetY ?? 160,
        sourcePosition: layout.sourcePosition ?? Position.Right,
        targetPosition: layout.targetPosition ?? Position.Left,
      }),
    ),
  );
}

function occurrences(markup: string, pattern: string): number {
  return markup.split(pattern).length - 1;
}

describe('TrafficEdge lightweight flow renderer', () => {
  it('renders two directional lanes with at most four SVG paths and two animations', () => {
    const markup = renderEdge();

    expect(occurrences(markup, '<path')).toBe(4);
    expect(occurrences(markup, 'data-flow-direction=')).toBe(2);
    expect(occurrences(markup, 'traffic-edge--animated')).toBe(2);
    expect(markup).not.toContain('<animate');
  });

  it('keeps both directions static when animation is OFF', () => {
    const markup = renderEdge({}, { showTrafficAnimation: false });

    expect(occurrences(markup, '<path')).toBe(4);
    expect(occurrences(markup, 'data-flow-direction=')).toBe(2);
    expect(markup).not.toContain('traffic-edge--animated');
    expect(markup).not.toContain('animation-duration');
  });

  it('respects an explicit per-link animation override', () => {
    const disabled = renderEdge({ animationEnabled: false });
    const enabled = renderEdge({ animationEnabled: true }, { showTrafficAnimation: false });

    expect(disabled).not.toContain('traffic-edge--animated');
    expect(occurrences(enabled, 'traffic-edge--animated')).toBe(2);
  });

  it('maps source-side TX and RX to opposite full-link directions', () => {
    const markup = renderEdge({
      trafficMode: 'SINGLE_ENDED',
      sourceInterfaceId: 'source-if',
      targetInterfaceId: null,
    });

    expect(markup).toContain('data-flow-direction="A_TO_B" data-observation="LOCAL_TX"');
    expect(markup).toContain('data-flow-direction="B_TO_A" data-observation="LOCAL_RX"');
  });

  it('maps target-side RX and TX without inventing remote telemetry', () => {
    const markup = renderEdge({
      trafficMode: 'SINGLE_ENDED',
      sourceInterfaceId: null,
      targetInterfaceId: 'target-if',
      directions: {
        A_TO_B: {
          bps: 900,
          utilization: 9,
          txBps: null,
          observedRxBps: 900,
          deltaPercent: null,
          consistency: 'UNKNOWN',
        },
        B_TO_A: {
          bps: 700,
          utilization: 7,
          txBps: 700,
          observedRxBps: null,
          deltaPercent: null,
          consistency: 'UNKNOWN',
        },
      },
    });

    expect(markup).toContain('data-flow-direction="A_TO_B" data-observation="LOCAL_RX"');
    expect(markup).toContain('data-flow-direction="B_TO_A" data-observation="LOCAL_TX"');
    expect(markup).toContain('data-throughput-bps="900"');
    expect(markup).toContain('data-throughput-bps="700"');
  });

  it('applies a custom color to the base and both lanes', () => {
    const markup = renderEdge({ customColor: '#34a853' });

    expect(occurrences(markup, 'stroke:#34a853')).toBe(3);
    expect(markup).toContain('traffic-edge--base');
  });

  it('does not animate DOWN or UNKNOWN links', () => {
    const down = renderEdge({ status: 'DOWN' });
    const unknown = renderEdge({ status: 'UNKNOWN' });

    expect(occurrences(down, '<path')).toBe(2);
    expect(down).not.toContain('traffic-edge--animated');
    expect(occurrences(unknown, '<path')).toBe(4);
    expect(unknown).not.toContain('traffic-edge--animated');
  });

  it('passes directional throughput and utilization through unchanged', () => {
    const markup = renderEdge({
      directions: {
        A_TO_B: {
          bps: 1_250_000_000,
          utilization: 62.5,
          txBps: 1_250_000_000,
          observedRxBps: 1_240_000_000,
          deltaPercent: 0.8,
          consistency: 'CONSISTENT',
        },
        B_TO_A: {
          bps: 480_000_000,
          utilization: 24,
          txBps: 480_000_000,
          observedRxBps: 470_000_000,
          deltaPercent: 2.08,
          consistency: 'CONSISTENT',
        },
      },
    });

    expect(markup).toContain('data-throughput-bps="1250000000"');
    expect(markup).toContain('data-utilization="62.5"');
    expect(markup).toContain('data-throughput-bps="480000000"');
    expect(markup).toContain('data-utilization="24"');
  });
});

describe('TrafficEdge inline traffic labels', () => {
  function inlineLabelX(markup: string): string[] {
    return [...markup.matchAll(/<text\b[^>]*>/g)]
      .map((tag) => /x="([^"]+)"/.exec(tag[0])?.[1])
      .filter((value): value is string => Boolean(value));
  }

  function inlineLabelPositions(markup: string): Array<{ x: string; y: string }> {
    return [...markup.matchAll(/<text\b[^>]*>/g)]
      .map((tag) => {
        const x = /x="([^"]+)"/.exec(tag[0])?.[1];
        const y = /y="([^"]+)"/.exec(tag[0])?.[1];
        return x && y ? { x, y } : null;
      })
      .filter((value): value is { x: string; y: string } => Boolean(value));
  }

  it('keeps CARD as the default traffic label mode', () => {
    const markup = renderEdge({}, { showLabels: true });

    expect(markup).toContain('edge-metric');
    expect(occurrences(markup, 'edge-metric__row')).toBe(2);
    expect(markup).not.toContain('traffic-edge__inline-label');
  });

  it('keeps the current card renderer when mode is CARD', () => {
    const markup = renderEdge({}, { showLabels: true, trafficLabelMode: 'CARD' });

    expect(occurrences(markup, 'edge-metric__row')).toBe(2);
    expect(markup).not.toContain('traffic-edge__inline-label');
  });

  it('does not render the large card in INLINE mode', () => {
    const markup = renderEdge({}, { showLabels: true, trafficLabelMode: 'INLINE' });

    expect(markup).not.toContain('edge-metric');
    expect(occurrences(markup, 'traffic-edge__inline-label')).toBe(2);
  });

  it('shows the A_TO_B direction value inline', () => {
    const markup = renderEdge({}, { showLabels: true, trafficLabelMode: 'INLINE' });

    expect(markup).toContain('31.7 Gbps');
  });

  it('shows the B_TO_A direction value inline', () => {
    const markup = renderEdge({}, { showLabels: true, trafficLabelMode: 'INLINE' });

    expect(markup).toContain('21.6 Gbps');
  });

  it('places the two inline labels at distinct positions along the path', () => {
    const markup = renderEdge({}, { showLabels: true, trafficLabelMode: 'INLINE' });

    const positions = inlineLabelX(markup);
    expect(positions).toHaveLength(2);
    expect(new Set(positions).size).toBe(2);
  });

  it('separates the two inline labels on a vertical link', () => {
    const markup = renderEdge(
      {},
      { showLabels: true, trafficLabelMode: 'INLINE' },
      {
        sourceX: 0,
        sourceY: 0,
        targetX: 0,
        targetY: 300,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      },
    );

    const positions = inlineLabelPositions(markup);
    expect(positions).toHaveLength(2);
    expect(new Set(positions.map((position) => position.x)).size).toBe(2);
    expect(new Set(positions.map((position) => position.y)).size).toBe(2);
  });

  it('separates the two inline labels on a horizontal link', () => {
    const markup = renderEdge(
      {},
      { showLabels: true, trafficLabelMode: 'INLINE' },
      {
        sourceX: 0,
        sourceY: 0,
        targetX: 300,
        targetY: 0,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      },
    );

    const positions = inlineLabelPositions(markup);
    expect(positions).toHaveLength(2);
    expect(new Set(positions.map((position) => position.x)).size).toBe(2);
    expect(new Set(positions.map((position) => position.y)).size).toBe(2);
  });

  it('shows only the valid direction for a single-ended link', () => {
    const markup = renderEdge(
      {
        trafficMode: 'SINGLE_ENDED',
        sourceInterfaceId: 'source-if',
        targetInterfaceId: null,
        directions: {
          A_TO_B: {
            bps: 900,
            utilization: 9,
            txBps: 900,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
          B_TO_A: {
            bps: 0,
            utilization: 0,
            txBps: null,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
        },
      },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(occurrences(markup, 'traffic-edge__inline-label')).toBe(1);
  });

  it('keeps showing a valid zero value', () => {
    const markup = renderEdge(
      {
        directions: {
          A_TO_B: {
            bps: 0,
            utilization: 0,
            txBps: 0,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
          B_TO_A: {
            bps: 0,
            utilization: 0,
            txBps: null,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
        },
      },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(occurrences(markup, 'traffic-edge__inline-label')).toBe(1);
    expect(markup).toContain('0 bps');
  });

  it('does not invent a label for an unavailable direction', () => {
    const markup = renderEdge(
      {
        directions: {
          A_TO_B: {
            bps: 0,
            utilization: 0,
            txBps: null,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
          B_TO_A: {
            bps: 0,
            utilization: 0,
            txBps: null,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
        },
      },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(occurrences(markup, 'traffic-edge__inline-label')).toBe(0);
    expect(markup).not.toContain('0 bps');
  });

  it('respects a custom color for the inline labels', () => {
    const markup = renderEdge(
      { customColor: '#34a853' },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(markup).toContain('fill:#34a853');
  });

  it('renders inline labels for a single visual path', () => {
    const markup = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 0, label: null, customColor: null, curvature: 0, enabled: true },
        pathIndex: 0,
        isPrimaryPath: true,
      },
    );

    expect(occurrences(markup, 'traffic-edge__inline-label')).toBe(2);
  });

  it('keeps traffic labels only on the primary visual path when two paths exist', () => {
    const primary = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 0, label: null, customColor: null, curvature: -20, enabled: true },
        pathIndex: 0,
        isPrimaryPath: true,
      },
    );
    const secondary = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 1, label: null, customColor: null, curvature: 20, enabled: true },
        pathIndex: 1,
        isPrimaryPath: false,
      },
    );

    expect(occurrences(primary, 'traffic-edge__inline-label')).toBe(2);
    expect(occurrences(secondary, 'traffic-edge__inline-label')).toBe(0);
  });

  it('keeps traffic labels only on the primary visual path when three paths exist', () => {
    const primary = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 0, label: null, customColor: null, curvature: -30, enabled: true },
        pathIndex: 0,
        isPrimaryPath: true,
      },
    );
    const second = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 1, label: null, customColor: null, curvature: 0, enabled: true },
        pathIndex: 1,
        isPrimaryPath: false,
      },
    );
    const third = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 2, label: null, customColor: null, curvature: 30, enabled: true },
        pathIndex: 2,
        isPrimaryPath: false,
      },
    );

    expect(occurrences(primary, 'traffic-edge__inline-label')).toBe(2);
    expect(occurrences(second, 'traffic-edge__inline-label')).toBe(0);
    expect(occurrences(third, 'traffic-edge__inline-label')).toBe(0);
  });

  it('follows the bezier when curvature changes instead of using a fixed midpoint', () => {
    const flat = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 0, label: null, customColor: null, curvature: 0, enabled: true },
        pathIndex: 0,
        isPrimaryPath: true,
      },
    );
    const curved = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 0, label: null, customColor: null, curvature: 40, enabled: true },
        pathIndex: 0,
        isPrimaryPath: true,
      },
    );

    expect(inlineLabelX(flat)).not.toEqual(inlineLabelX(curved));
  });

  it('hides every traffic metric in HIDDEN mode', () => {
    const markup = renderEdge({}, { showLabels: true, trafficLabelMode: 'HIDDEN' });

    expect(markup).not.toContain('edge-metric');
    expect(markup).not.toContain('traffic-edge__inline-label');
  });
});

describe('TrafficEdge per-link inline positions and directional colors', () => {
  function inlineLabelPositions(markup: string): Array<{ x: string; y: string }> {
    return [...markup.matchAll(/<text\b[^>]*>/g)]
      .map((tag) => {
        const x = /x="([^"]+)"/.exec(tag[0])?.[1];
        const y = /y="([^"]+)"/.exec(tag[0])?.[1];
        return x && y ? { x, y } : null;
      })
      .filter((value): value is { x: string; y: string } => Boolean(value));
  }

  it('uses the AUTO 0.40 / 0.60 defaults when positions are null', () => {
    const autoMarkup = renderEdge({}, { showLabels: true, trafficLabelMode: 'INLINE' });
    const explicitMarkup = renderEdge(
      { inlineLabelPositionAToB: 0.4, inlineLabelPositionBToA: 0.6 },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(inlineLabelPositions(autoMarkup)).toEqual(inlineLabelPositions(explicitMarkup));
  });

  it('respects a custom A_TO_B inline position', () => {
    const autoMarkup = renderEdge({}, { showLabels: true, trafficLabelMode: 'INLINE' });
    const customMarkup = renderEdge(
      { inlineLabelPositionAToB: 0.25, inlineLabelPositionBToA: null },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(inlineLabelPositions(customMarkup)[0]).not.toEqual(
      inlineLabelPositions(autoMarkup)[0],
    );
  });

  it('respects a custom B_TO_A inline position', () => {
    const autoMarkup = renderEdge({}, { showLabels: true, trafficLabelMode: 'INLINE' });
    const customMarkup = renderEdge(
      { inlineLabelPositionAToB: null, inlineLabelPositionBToA: 0.75 },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(inlineLabelPositions(customMarkup)[1]).not.toEqual(
      inlineLabelPositions(autoMarkup)[1],
    );
  });

  it('clamps an out-of-range inline position into the safe range', () => {
    const belowMin = renderEdge(
      { inlineLabelPositionAToB: 0.05, inlineLabelPositionBToA: null },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );
    const atMin = renderEdge(
      { inlineLabelPositionAToB: 0.1, inlineLabelPositionBToA: null },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(inlineLabelPositions(belowMin)[0]).toEqual(inlineLabelPositions(atMin)[0]);
  });

  it('uses the respective directional colors for inline labels', () => {
    const markup = renderEdge(
      { trafficColorAToB: '#4da3ff', trafficColorBToA: '#f0923c' },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(markup).toContain('fill:#4da3ff');
    expect(markup).toContain('fill:#f0923c');
  });

  it('uses the respective directional colors for CARD swatches', () => {
    const markup = renderEdge(
      { trafficColorAToB: '#4da3ff', trafficColorBToA: '#f0923c' },
      { showLabels: true, trafficLabelMode: 'CARD' },
    );

    expect(markup).toContain('background-color:#4da3ff');
    expect(markup).toContain('background-color:#f0923c');
  });

  it('lets directional colors take precedence over a legacy customColor', () => {
    const markup = renderEdge(
      { customColor: '#34a853', trafficColorAToB: '#4da3ff', trafficColorBToA: '#f0923c' },
      { showLabels: true, trafficLabelMode: 'INLINE' },
    );

    expect(markup).toContain('fill:#4da3ff');
    expect(markup).toContain('fill:#f0923c');
    expect(markup).not.toContain('fill:#34a853');
  });

  it('keeps a visual path customColor compatible when no directional colors exist', () => {
    const markup = renderEdge(
      {},
      {
        showLabels: true,
        trafficLabelMode: 'INLINE',
        visualPath: { order: 0, label: null, customColor: '#34a853', curvature: 0, enabled: true },
        pathIndex: 0,
        isPrimaryPath: true,
      },
    );

    expect(markup).toContain('fill:#34a853');
  });
});
