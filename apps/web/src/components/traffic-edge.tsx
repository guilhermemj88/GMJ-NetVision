'use client';

import {
  formatBitsPerSecond,
  utilizationLevel,
  type LinkDisplayStyle,
  type LinkMetricDisplay,
  type NetworkLink,
} from '@gmj/shared';
import { EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';

export interface TrafficEdgeData extends Record<string, unknown> {
  link: NetworkLink;
  showTraffic: boolean;
  showUtilization: boolean;
  showLabels: boolean;
  displayStyle: LinkDisplayStyle;
  metricDisplay: LinkMetricDisplay;
  related: boolean;
  emphasized: boolean;
  linkScale: number;
  labelScale: number;
}

export type TrafficFlowEdge = Edge<TrafficEdgeData, 'traffic'>;

function metricText(bps: number, utilization: number, display: LinkMetricDisplay): string {
  if (display === 'THROUGHPUT') return formatBitsPerSecond(bps);
  if (display === 'UTILIZATION') return `${utilization.toFixed(0)}%`;
  if (display === 'BOTH') return `${formatBitsPerSecond(bps)} (${utilization.toFixed(0)}%)`;
  return '';
}

export function TrafficEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<TrafficFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35,
  });
  if (!data) return null;

  const {
    link,
    showTraffic,
    showUtilization,
    showLabels,
    related,
    emphasized,
    linkScale,
    labelScale,
  } = data;
  const displayStyle = link.visualStyle ?? data.displayStyle;
  const requestedMetricDisplay = link.metricDisplay ?? data.metricDisplay;
  const metricDisplay = showUtilization
    ? requestedMetricDisplay
    : requestedMetricDisplay === 'BOTH'
      ? 'THROUGHPUT'
      : requestedMetricDisplay === 'UTILIZATION'
        ? 'NONE'
        : requestedMetricDisplay;
  const aToB = link.directions.A_TO_B;
  const bToA = link.directions.B_TO_A;
  const maxUtilization = Math.max(aToB.utilization, bToA.utilization);
  const toneA = link.status === 'DOWN' ? 'down' : utilizationLevel(aToB.utilization).toLowerCase();
  const toneB = link.status === 'DOWN' ? 'down' : utilizationLevel(bToA.utilization).toLowerCase();
  const worstTone =
    link.status === 'DOWN' ? 'down' : utilizationLevel(maxUtilization).toLowerCase();
  const width =
    Math.max(2, Math.min(8, 1.8 + Math.log10(Math.max(link.capacityBps, 1_000_000_000)) - 8.5)) *
    (linkScale / 100);
  const distance = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
  const offsetX = (-(targetY - sourceY) / distance) * 4;
  const offsetY = ((targetX - sourceX) / distance) * 4;
  const classes = `${selected ? 'is-selected' : ''} ${related ? '' : 'is-dimmed'} ${emphasized ? 'is-emphasized' : ''}`;
  const directional = displayStyle === 'WEATHERMAP' || displayStyle === 'HYBRID';
  const showMetric = showLabels && metricDisplay !== 'NONE' && displayStyle !== 'MINIMAL';

  return (
    <>
      <defs>
        <marker
          id={`${id}-direction-arrow`}
          markerWidth="5"
          markerHeight="5"
          refX="4"
          refY="2.5"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 5 2.5 L 0 5 z" fill="context-stroke" />
        </marker>
      </defs>
      {!directional && (
        <path
          id={id}
          d={path}
          className={`traffic-edge traffic-edge--base traffic-edge--${worstTone} ${classes}`}
          style={{ strokeWidth: displayStyle === 'MINIMAL' ? Math.max(1.5, width - 1) : width }}
        />
      )}

      {directional && (
        <>
          <path
            d={path}
            transform={`translate(${offsetX} ${offsetY})`}
            className={`traffic-edge traffic-edge--lane traffic-edge--${toneA} ${classes}`}
            markerEnd={`url(#${id}-direction-arrow)`}
            style={{ strokeWidth: displayStyle === 'WEATHERMAP' ? width + 1 : width }}
          />
          <path
            d={path}
            transform={`translate(${-offsetX} ${-offsetY})`}
            className={`traffic-edge traffic-edge--lane traffic-edge--lane-reverse traffic-edge--${toneB} ${classes}`}
            markerStart={`url(#${id}-direction-arrow)`}
            style={{ strokeWidth: displayStyle === 'WEATHERMAP' ? width + 1 : width }}
          />
        </>
      )}

      {showTraffic && link.status !== 'DOWN' && displayStyle !== 'MINIMAL' && (
        <>
          <path
            d={path}
            transform={directional ? `translate(${offsetX} ${offsetY})` : undefined}
            className={`traffic-edge traffic-edge--flow traffic-edge--${directional ? toneA : worstTone} ${classes}`}
            style={{
              strokeWidth: Math.max(1.5, width - 1),
              animationDuration: `${Math.max(0.55, 1.8 - aToB.utilization / 80)}s`,
            }}
          />
          <path
            d={path}
            transform={directional ? `translate(${-offsetX} ${-offsetY})` : undefined}
            className={`traffic-edge traffic-edge--flow traffic-edge--reverse traffic-edge--${directional ? toneB : worstTone} ${classes}`}
            style={{
              strokeWidth: Math.max(1.2, width - 2),
              animationDuration: `${Math.max(0.65, 2 - bToA.utilization / 75)}s`,
            }}
          />
        </>
      )}

      <path d={path} className="traffic-edge__hitarea" />
      {showMetric && (
        <EdgeLabelRenderer>
          <div
            className={`edge-metric edge-metric--${displayStyle.toLowerCase()} edge-metric--${worstTone} ${related ? '' : 'is-dimmed'}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${labelScale / 100})`,
            }}
          >
            <span>A → B</span>
            <strong>{metricText(aToB.bps, aToB.utilization, metricDisplay)}</strong>
            <span>B → A</span>
            <strong>{metricText(bToA.bps, bToA.utilization, metricDisplay)}</strong>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
