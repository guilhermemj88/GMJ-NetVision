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
  return renderToStaticMarkup(createElement(TrafficEdge, {
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
  }));
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
        A_TO_B: { bps: 1_250_000_000, utilization: 62.5 },
        B_TO_A: { bps: 480_000_000, utilization: 24 },
      },
    });

    expect(markup).toContain('data-throughput-bps="1250000000"');
    expect(markup).toContain('data-utilization="62.5"');
    expect(markup).toContain('data-throughput-bps="480000000"');
    expect(markup).toContain('data-utilization="24"');
  });
});
