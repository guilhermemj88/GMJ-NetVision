'use client';

import {
  formatBitsPerSecond,
  utilizationLevel,
  type LinkDisplayStyle,
  type LinkMetricDisplay,
  type NetworkInterface,
  type NetworkLink,
} from '@gmj/shared';
import { EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';

export interface TrafficEdgeData extends Record<string, unknown> {
  link: NetworkLink;
  sourceInterface?: NetworkInterface;
  targetInterface?: NetworkInterface;
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

const EDGE_CURVATURE = 0.24;
// Half of the visual separation between the two chevron tracks (~5 px total).
const LANE_HALF_GAP = 2.6;

function throughputText(bps: number): string {
  return formatBitsPerSecond(bps);
}

function utilizationText(utilization: number): string {
  return `${utilization.toFixed(0)}%`;
}

function toneClass(tone: string): string {
  switch (tone) {
    case 'attention': return 'traffic-edge--attention';
    case 'high': return 'traffic-edge--high';
    case 'critical': return 'traffic-edge--critical';
    case 'down': return 'traffic-edge--down';
    case 'unknown': return 'traffic-edge--unknown';
    default: return 'traffic-edge--normal';
  }
}

function toneColor(tone: string, reverse = false): string {
  if (reverse) {
    switch (tone) {
      case 'attention': return '#c578e0';
      case 'high': return '#e052c8';
      case 'critical': return '#e03b5c';
      case 'down': return '#5f4649';
      case 'unknown': return '#718894';
      default: return '#9575f0';
    }
  }

  switch (tone) {
    case 'attention': return '#dfb847';
    case 'high': return '#eb9340';
    case 'critical': return '#e24b4b';
    case 'down': return '#6e5558';
    case 'unknown': return '#718894';
    default: return '#40c8e8';
  }
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
    curvature: EDGE_CURVATURE,
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
  const statusTone = link.status === 'DOWN' ? 'down' : link.status === 'UNKNOWN' ? 'unknown' : null;
  const toneA = statusTone ?? utilizationLevel(aToB.utilization).toLowerCase();
  const toneB = statusTone ?? utilizationLevel(bToA.utilization).toLowerCase();
  const worstTone = statusTone ?? utilizationLevel(maxUtilization).toLowerCase();

  const width = Math.max(1, Math.min(1.8, 1.05 + Math.log10(Math.max(link.capacityBps, 1_000_000_000)) - 9.2)) * (linkScale / 100);
  const classes = `${selected ? 'is-selected' : ''} ${related ? '' : 'is-dimmed'} ${emphasized ? 'is-emphasized' : ''}`;
  const directional = displayStyle !== 'MINIMAL';
  const showMetric = showLabels && displayStyle !== 'MINIMAL' && metricDisplay !== 'NONE';

  const displayThroughput = metricDisplay === 'THROUGHPUT' || metricDisplay === 'BOTH';
  const displayUtilization = metricDisplay === 'UTILIZATION' || metricDisplay === 'BOTH';
  const duration = Math.max(3.5, 6.4 - maxUtilization / 32);
  const chevronCount = displayStyle === 'HYBRID' ? 7 : 5;
  const chevronScale = Math.max(0.7, Math.min(1.25, linkScale / 100));
  const chevronPath = `M ${-2.7 * chevronScale} ${-2.2 * chevronScale} L ${1.6 * chevronScale} 0 L ${-2.7 * chevronScale} ${2.2 * chevronScale}`;

  // Perpendicular normal of the source→target segment. Both lanes are the same
  // bézier translated along this normal, which keeps their separation constant
  // for straight links and preserves the exact same curvature for curved links.
  const segmentX = targetX - sourceX;
  const segmentY = targetY - sourceY;
  const segmentLength = Math.hypot(segmentX, segmentY) || 1;
  const normalX = -segmentY / segmentLength;
  const normalY = segmentX / segmentLength;
  const gap = Math.max(2, LANE_HALF_GAP * (linkScale / 100));
  const laneAPath = directional
    ? getBezierPath({
        sourceX: sourceX + normalX * gap,
        sourceY: sourceY + normalY * gap,
        sourcePosition,
        targetX: targetX + normalX * gap,
        targetY: targetY + normalY * gap,
        targetPosition,
        curvature: EDGE_CURVATURE,
      })[0]
    : path;
  const laneBPath = directional
    ? getBezierPath({
        sourceX: sourceX - normalX * gap,
        sourceY: sourceY - normalY * gap,
        sourcePosition,
        targetX: targetX - normalX * gap,
        targetY: targetY - normalY * gap,
        targetPosition,
        curvature: EDGE_CURVATURE,
      })[0]
    : path;

  const colorA = toneColor(toneA);
  const colorB = toneColor(toneB, true);
  const renderLanes = directional && showTraffic && link.status !== 'DOWN' && related;

  return (
    <>
      <path
        id={id}
        d={path}
        className={`traffic-edge traffic-edge--base ${statusTone ? toneClass(statusTone) : ''} ${classes}`}
        style={{ strokeWidth: width }}
      />

      {renderLanes && (
        <>
          {Array.from({ length: chevronCount }, (_, index) => {
            const begin = -((index * duration) / chevronCount);
            return (
              <g key={`a-to-b-${index}`} style={{ pointerEvents: 'none' }}>
                <path d={chevronPath} className={`traffic-chevron ${toneClass(toneA)} ${classes}`}>
                  <animateMotion
                    path={laneAPath}
                    dur={`${duration}s`}
                    begin={`${begin}s`}
                    repeatCount="indefinite"
                    rotate="auto"
                    calcMode="linear"
                  />
                </path>
              </g>
            );
          })}

          {Array.from({ length: chevronCount }, (_, index) => {
            const begin = -((index * duration) / chevronCount) - duration / (chevronCount * 2);
            return (
              <g key={`b-to-a-${index}`} style={{ pointerEvents: 'none' }}>
                <path d={chevronPath} className={`traffic-chevron traffic-edge--ba ${toneClass(toneB)} ${classes}`}>
                  <animateMotion
                    path={laneBPath}
                    dur={`${duration}s`}
                    begin={`${begin}s`}
                    repeatCount="indefinite"
                    rotate="auto-reverse"
                    keyPoints="1;0"
                    keyTimes="0;1"
                    calcMode="linear"
                  />
                </path>
              </g>
            );
          })}
        </>
      )}

      <path d={path} className="traffic-edge__hitarea" />

      {showMetric && (
        <EdgeLabelRenderer>
          <div
            className={`edge-metric edge-metric--${displayStyle.toLowerCase()} edge-metric--${worstTone} ${related ? '' : 'is-dimmed'}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${labelScale / 100})` }}
          >
            <div className="edge-metric__row">
              <span className="edge-metric__swatch" style={{ backgroundColor: colorA }} />
              {displayThroughput && <strong>{throughputText(aToB.bps)}</strong>}
              {displayUtilization && <em>{utilizationText(aToB.utilization)}</em>}
            </div>
            <div className="edge-metric__row">
              <span className="edge-metric__swatch" style={{ backgroundColor: colorB }} />
              {displayThroughput && <strong>{throughputText(bToA.bps)}</strong>}
              {displayUtilization && <em>{utilizationText(bToA.utilization)}</em>}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
