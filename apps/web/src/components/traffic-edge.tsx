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
  showTrafficAnimation: boolean;
  displayStyle: LinkDisplayStyle;
  metricDisplay: LinkMetricDisplay;
  related: boolean;
  emphasized: boolean;
  linkScale: number;
  labelScale: number;
}

export type TrafficFlowEdge = Edge<TrafficEdgeData, 'traffic'>;

const EDGE_CURVATURE = 0.24;
const LANE_HALF_GAP = 2.6;
const HUE_A = 190;
const HUE_B = 285;

type FlowLevel = 'normal' | 'attention' | 'high' | 'critical' | 'down' | 'unknown';

function throughputText(bps: number): string {
  return formatBitsPerSecond(bps);
}

function utilizationText(utilization: number): string {
  return `${utilization.toFixed(0)}%`;
}

function toneClass(tone: string): string {
  switch (tone) {
    case 'attention':
      return 'traffic-edge--attention';
    case 'high':
      return 'traffic-edge--high';
    case 'critical':
      return 'traffic-edge--critical';
    case 'down':
      return 'traffic-edge--down';
    case 'unknown':
      return 'traffic-edge--unknown';
    default:
      return 'traffic-edge--normal';
  }
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${hue.toFixed(0)}, ${saturation.toFixed(0)}%, ${lightness.toFixed(0)}%)`;
}

function flowLevel(utilization: number): FlowLevel {
  return utilizationLevel(utilization).toLowerCase() as FlowLevel;
}

function flowColor(hue: number, level: FlowLevel): string {
  switch (level) {
    case 'critical':
      return hsl(hue, 100, 56);
    case 'high':
      return hsl(hue, 91, 60);
    case 'attention':
      return hsl(hue, 78, 66);
    case 'down':
      return '#6e5558';
    case 'unknown':
      return '#718894';
    default:
      return hsl(hue, 58, 72);
  }
}

function staticOpacity(level: FlowLevel): number {
  switch (level) {
    case 'critical':
      return 0.94;
    case 'high':
      return 0.82;
    case 'attention':
      return 0.7;
    case 'down':
    case 'unknown':
      return 0.48;
    default:
      return 0.56;
  }
}

function flowDuration(level: FlowLevel): number {
  switch (level) {
    case 'critical':
      return 3.8;
    case 'high':
      return 4.6;
    case 'attention':
      return 5.8;
    default:
      return 7;
  }
}

function flowDash(level: FlowLevel): string {
  switch (level) {
    case 'critical':
      return '4 7';
    case 'high':
      return '3.5 8';
    case 'attention':
      return '3 9';
    case 'unknown':
      return '2 8';
    default:
      return '2.5 10';
  }
}

function flowFilter(color: string, level: FlowLevel, emphasized: boolean): string | undefined {
  if (emphasized) return `drop-shadow(0 0 3px ${color})`;
  if (level === 'critical') return `drop-shadow(0 0 4px ${color})`;
  if (level === 'high') return `drop-shadow(0 0 2px ${color})`;
  return undefined;
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
    showTrafficAnimation,
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
  const levelA: FlowLevel = statusTone ?? flowLevel(aToB.utilization);
  const levelB: FlowLevel = statusTone ?? flowLevel(bToA.utilization);
  const worstTone = statusTone ?? flowLevel(maxUtilization);

  const width =
    Math.max(1, Math.min(1.8, 1.05 + Math.log10(Math.max(link.capacityBps, 1_000_000_000)) - 9.2)) *
    (linkScale / 100);
  const classes = `${selected ? 'is-selected' : ''} ${related ? '' : 'is-dimmed'} ${emphasized ? 'is-emphasized' : ''}`;
  const directional = displayStyle !== 'MINIMAL';
  const showMetric = showLabels && directional && metricDisplay !== 'NONE';
  const displayThroughput = metricDisplay === 'THROUGHPUT' || metricDisplay === 'BOTH';
  const displayUtilization = metricDisplay === 'UTILIZATION' || metricDisplay === 'BOTH';

  const segmentX = targetX - sourceX;
  const segmentY = targetY - sourceY;
  const segmentLength = Math.hypot(segmentX, segmentY) || 1;
  const normalX = -segmentY / segmentLength;
  const normalY = segmentX / segmentLength;
  const gap = Math.max(2, LANE_HALF_GAP * (linkScale / 100));
  const laneATransform = `translate(${normalX * gap} ${normalY * gap})`;
  const laneBTransform = `translate(${-normalX * gap} ${-normalY * gap})`;
  const colorA = link.customColor ?? flowColor(HUE_A, levelA);
  const colorB = link.customColor ?? flowColor(HUE_B, levelB);
  const isEmphasized = Boolean(emphasized || selected);
  const renderLanes = directional && showTraffic && link.status !== 'DOWN' && related;
  const animateLanes = (link.animationEnabled ?? showTrafficAnimation) && link.status !== 'UNKNOWN';
  const laneWidth = Math.max(1, width * (isEmphasized ? 1.15 : 0.88));
  const sourceMonitored = link.trafficMode === 'SINGLE_ENDED' && Boolean(link.sourceInterfaceId);
  const laneAObservation =
    link.trafficMode === 'SINGLE_ENDED' ? (sourceMonitored ? 'LOCAL_TX' : 'LOCAL_RX') : 'A_TO_B';
  const laneBObservation =
    link.trafficMode === 'SINGLE_ENDED' ? (sourceMonitored ? 'LOCAL_RX' : 'LOCAL_TX') : 'B_TO_A';

  return (
    <>
      <path
        id={id}
        d={path}
        className={`traffic-edge traffic-edge--base ${statusTone ? toneClass(statusTone) : ''} ${classes}`}
        style={{
          strokeWidth: Math.max(0.8, width * 0.6),
          ...(link.customColor ? { stroke: link.customColor, opacity: 0.34 } : {}),
        }}
      />

      {renderLanes && (
        <>
          <path
            d={path}
            transform={laneATransform}
            data-flow-direction="A_TO_B"
            data-observation={laneAObservation}
            data-throughput-bps={aToB.bps}
            data-utilization={aToB.utilization}
            className={`traffic-edge traffic-edge--flow traffic-edge--a-to-b ${animateLanes ? 'traffic-edge--animated' : ''} ${classes}`}
            style={{
              stroke: colorA,
              color: colorA,
              strokeWidth: laneWidth,
              strokeDasharray: flowDash(levelA),
              opacity: staticOpacity(levelA),
              filter: flowFilter(colorA, levelA, isEmphasized),
              ...(animateLanes ? { animationDuration: `${flowDuration(levelA)}s` } : {}),
            }}
          />
          <path
            d={path}
            transform={laneBTransform}
            data-flow-direction="B_TO_A"
            data-observation={laneBObservation}
            data-throughput-bps={bToA.bps}
            data-utilization={bToA.utilization}
            className={`traffic-edge traffic-edge--flow traffic-edge--b-to-a ${animateLanes ? 'traffic-edge--animated' : ''} ${classes}`}
            style={{
              stroke: colorB,
              color: colorB,
              strokeWidth: laneWidth,
              strokeDasharray: flowDash(levelB),
              opacity: staticOpacity(levelB),
              filter: flowFilter(colorB, levelB, isEmphasized),
              ...(animateLanes ? { animationDuration: `${flowDuration(levelB)}s` } : {}),
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
