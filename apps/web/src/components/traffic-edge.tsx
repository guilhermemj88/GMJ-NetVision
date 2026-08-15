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
    Math.max(
      1.1,
      Math.min(2.6, 1.15 + Math.log10(Math.max(link.capacityBps, 1_000_000_000)) - 9.2),
    ) *
    (linkScale / 100);
  const distance = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
  const laneGap = Math.max(2.1, Math.min(4.5, 1.9 + width * 0.4));
  const offsetX = (-(targetY - sourceY) / distance) * laneGap;
  const offsetY = ((targetX - sourceX) / distance) * laneGap;
  const classes = `${selected ? 'is-selected' : ''} ${related ? '' : 'is-dimmed'} ${emphasized ? 'is-emphasized' : ''}`;
  const directional = displayStyle !== 'MINIMAL';
  const showMetric = showLabels && metricDisplay !== 'NONE' && displayStyle !== 'MINIMAL';
  const chevronScale = Math.max(0.72, Math.min(1.45, linkScale / 100));
  const chevronPath = `M ${-3.2 * chevronScale} ${-2.6 * chevronScale} L ${1.2 * chevronScale} 0 L ${-3.2 * chevronScale} ${2.6 * chevronScale}`;
  const chevronCount = Math.max(3, Math.min(6, Math.round(distance / 95)));
  const durationA = Math.max(0.72, 2.65 - aToB.utilization / 58);
  const durationB = Math.max(0.78, 2.85 - bToA.utilization / 55);

  return (
    <>
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
            style={{ strokeWidth: width }}
          />
          <path
            d={path}
            transform={`translate(${-offsetX} ${-offsetY})`}
            className={`traffic-edge traffic-edge--lane traffic-edge--lane-reverse traffic-edge--${toneB} ${classes}`}
            style={{ strokeWidth: width }}
          />
        </>
      )}

      {showTraffic && link.status !== 'DOWN' && displayStyle !== 'MINIMAL' && (
        <>
          <g transform={`translate(${offsetX} ${offsetY})`}>
            {Array.from({ length: chevronCount }, (_, index) => (
              <path
                d={chevronPath}
                className={`traffic-chevron traffic-edge--${toneA} ${classes}`}
                style={{ strokeWidth: Math.max(1.1, Math.min(1.8, width * 0.55)) }}
                key={`a-to-b-${index}`}
              >
                <animateMotion
                  path={path}
                  dur={`${durationA}s`}
                  begin={`${-(index * durationA) / chevronCount}s`}
                  repeatCount="indefinite"
                  rotate="auto"
                />
              </path>
            ))}
          </g>
          <g transform={`translate(${-offsetX} ${-offsetY})`}>
            {Array.from({ length: chevronCount }, (_, index) => (
              <path
                d={chevronPath}
                className={`traffic-chevron traffic-chevron--reverse traffic-edge--${toneB} ${classes}`}
                style={{ strokeWidth: Math.max(1.1, Math.min(1.8, width * 0.55)) }}
                key={`b-to-a-${index}`}
              >
                <animateMotion
                  path={path}
                  dur={`${durationB}s`}
                  begin={`${-(index * durationB) / chevronCount}s`}
                  repeatCount="indefinite"
                  rotate="auto-reverse"
                  keyPoints="1;0"
                  keyTimes="0;1"
                  calcMode="linear"
                />
              </path>
            ))}
          </g>
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
