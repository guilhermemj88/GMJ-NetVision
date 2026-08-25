import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position } from '@xyflow/react';
import { cloneDemoMaps, type NetworkLink } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { TrafficEdge, type TrafficEdgeData, type TrafficFlowEdge } from './traffic-edge';

const baseLink = cloneDemoMaps()[0]!.links[0]!;

function renderEdge(
  linkPartial: Partial<NetworkLink> = {},
  dataPartial: Partial<TrafficEdgeData> = {},
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
    createElement(TrafficEdge, {
      id: edge.id,
      type: 'traffic',
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
