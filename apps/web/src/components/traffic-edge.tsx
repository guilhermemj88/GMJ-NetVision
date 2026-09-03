'use client';

import {
  formatBitsPerSecond,
  utilizationLevel,
  type LinkDisplayStyle,
  type LinkMetricDisplay,
  type LinkVisualPath,
  type NetworkInterface,
  type NetworkLink,
  type TrafficLabelMode,
} from '@gmj/shared';
import {
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
  type Position,
} from '@xyflow/react';

export interface TrafficEdgeData extends Record<string, unknown> {
  link: NetworkLink;
  sourceInterface?: NetworkInterface;
  targetInterface?: NetworkInterface;
  visualPath?: LinkVisualPath;
  pathIndex?: number;
  isPrimaryPath?: boolean;
  showTraffic: boolean;
  showUtilization: boolean;
  showLabels: boolean;
  showTrafficAnimation: boolean;
  displayStyle: LinkDisplayStyle;
  metricDisplay: LinkMetricDisplay;
  trafficLabelMode?: TrafficLabelMode;
  related: boolean;
  emphasized: boolean;
  linkScale: number;
  labelScale: number;
}

export type TrafficFlowEdge = Edge<TrafficEdgeData, 'traffic'>;

const EDGE_CURVATURE = 0.24;
const LANE_HALF_GAP = 4.0;
const HUE_A = 190;
const HUE_B = 285;
// Converts a visual-path curvature (signed pixel offset) into a bezier bow.
const PATH_OFFSET_SCALE = 0.9;
// Inline label placement along the bezier, plus the perpendicular lift so text
// never sits exactly on the lane stroke.
const INLINE_LABEL_T_A = 0.4;
const INLINE_LABEL_T_B = 0.6;
const INLINE_LABEL_LIFT = 10;

type FlowLevel = 'normal' | 'attention' | 'high' | 'critical' | 'down' | 'unknown';

function calculateControlOffset(distance: number, curvature: number): number {
  if (distance >= 0) return 0.5 * distance;
  return curvature * 25 * Math.sqrt(-distance);
}

function getControlWithCurvature({
  pos,
  x1,
  y1,
  x2,
  y2,
  c,
}: {
  pos: Position;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: number;
}): [number, number] {
  switch (pos) {
    case 'left':
      return [x1 - calculateControlOffset(x1 - x2, c), y1];
    case 'right':
      return [x1 + calculateControlOffset(x2 - x1, c), y1];
    case 'top':
      return [x1, y1 - calculateControlOffset(y1 - y2, c)];
    case 'bottom':
      return [x1, y1 + calculateControlOffset(y2 - y1, c)];
    default:
      return [x1, y1];
  }
}

interface BezierGeometry {
  path: string;
  labelX: number;
  labelY: number;
  source: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  target: { x: number; y: number };
}

function getOffsetBezierPath({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  curvature,
  offset,
}: {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
  curvature: number;
  offset: number;
}): BezierGeometry {
  const [sourceControlX, sourceControlY] = getControlWithCurvature({
    pos: sourcePosition,
    x1: sourceX,
    y1: sourceY,
    x2: targetX,
    y2: targetY,
    c: curvature,
  });
  const [targetControlX, targetControlY] = getControlWithCurvature({
    pos: targetPosition,
    x1: targetX,
    y1: targetY,
    x2: sourceX,
    y2: sourceY,
    c: curvature,
  });
  const deltaX = targetX - sourceX;
  const deltaY = targetY - sourceY;
  const length = Math.hypot(deltaX, deltaY) || 1;
  const normalX = -deltaY / length;
  const normalY = deltaX / length;
  const offsetX = normalX * offset;
  const offsetY = normalY * offset;
  const c1x = sourceControlX + offsetX;
  const c1y = sourceControlY + offsetY;
  const c2x = targetControlX + offsetX;
  const c2y = targetControlY + offsetY;
  const path = `M${sourceX},${sourceY} C${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`;
  const labelX = (sourceX + 3 * c1x + 3 * c2x + targetX) / 8;
  const labelY = (sourceY + 3 * c1y + 3 * c2y + targetY) / 8;
  return {
    path,
    labelX,
    labelY,
    source: { x: sourceX, y: sourceY },
    c1: { x: c1x, y: c1y },
    c2: { x: c2x, y: c2y },
    target: { x: targetX, y: targetY },
  };
}

function bezierPoint(geometry: BezierGeometry, t: number): { x: number; y: number } {
  const { source, c1, c2, target } = geometry;
  const u = 1 - t;
  const u2 = u * u;
  const t2 = t * t;
  return {
    x: u2 * u * source.x + 3 * u2 * t * c1.x + 3 * u * t2 * c2.x + t2 * t * target.x,
    y: u2 * u * source.y + 3 * u2 * t * c1.y + 3 * u * t2 * c2.y + t2 * t * target.y,
  };
}

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
  if (!data) return null;

  const {
    link,
    visualPath,
    showTraffic,
    showUtilization,
    showLabels,
    showTrafficAnimation,
    related,
    emphasized,
    linkScale,
    labelScale,
    trafficLabelMode = 'CARD',
  } = data;

  const pathOffset = (visualPath?.curvature ?? 0) * PATH_OFFSET_SCALE;
  const geometry = getOffsetBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: EDGE_CURVATURE,
    offset: pathOffset,
  });
  const { path, labelX, labelY } = geometry;

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
  const isPrimary = data.isPrimaryPath !== false;
  const showMetric = showLabels && directional && metricDisplay !== 'NONE' && isPrimary;
  const showPathLabel = showLabels && Boolean(visualPath?.label);
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
  const pathColor = visualPath?.customColor ?? link.customColor ?? null;
  const colorA = pathColor ?? flowColor(HUE_A, levelA);
  const colorB = pathColor ?? flowColor(HUE_B, levelB);
  const isEmphasized = Boolean(emphasized || selected);
  const renderLanes = directional && showTraffic && link.status !== 'DOWN' && related;
  const animateLanes = (link.animationEnabled ?? showTrafficAnimation) && link.status !== 'UNKNOWN';
  const laneWidth = Math.max(1, width * (isEmphasized ? 1.15 : 0.88));
  const sourceMonitored = link.trafficMode === 'SINGLE_ENDED' && Boolean(link.sourceInterfaceId);
  const laneAObservation =
    link.trafficMode === 'SINGLE_ENDED' ? (sourceMonitored ? 'LOCAL_TX' : 'LOCAL_RX') : 'A_TO_B';
  const laneBObservation =
    link.trafficMode === 'SINGLE_ENDED' ? (sourceMonitored ? 'LOCAL_RX' : 'LOCAL_TX') : 'B_TO_A';

  const renderInlineMetric = showMetric && trafficLabelMode === 'INLINE' && renderLanes;
  const laneAAvailable = aToB.txBps !== null || aToB.observedRxBps !== null;
  const laneBAvailable = bToA.txBps !== null || bToA.observedRxBps !== null;
  const inlineLift = INLINE_LABEL_LIFT * (linkScale / 100);
  const inlineAOffset = gap + inlineLift;
  const inlineBOffset = -(gap + inlineLift);
  const inlineAPoint = bezierPoint(geometry, INLINE_LABEL_T_A);
  const inlineBPoint = bezierPoint(geometry, INLINE_LABEL_T_B);
  const inlineAX = inlineAPoint.x + normalX * inlineAOffset;
  const inlineAY = inlineAPoint.y + normalY * inlineAOffset;
  const inlineBX = inlineBPoint.x + normalX * inlineBOffset;
  const inlineBY = inlineBPoint.y + normalY * inlineBOffset;
  const inlineTextA = displayThroughput
    ? throughputText(aToB.bps)
    : utilizationText(aToB.utilization);
  const inlineTextB = displayThroughput
    ? throughputText(bToA.bps)
    : utilizationText(bToA.utilization);

  return (
    <>
      <path
        id={id}
        d={path}
        className={`traffic-edge traffic-edge--base ${statusTone ? toneClass(statusTone) : ''} ${classes}`}
        style={{
          strokeWidth: Math.max(0.8, width * 0.6),
          ...(pathColor ? { stroke: pathColor, opacity: 0.34 } : {}),
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

      {renderInlineMetric && (
        <>
          {laneAAvailable && (
            <text
              x={inlineAX}
              y={inlineAY}
              textAnchor="middle"
              dominantBaseline="middle"
              data-flow-direction="A_TO_B"
              className={`traffic-edge__inline-label ${classes}`}
              style={{ fill: colorA, fontSize: 10 * (labelScale / 100) }}
            >
              {inlineTextA}
            </text>
          )}
          {laneBAvailable && (
            <text
              x={inlineBX}
              y={inlineBY}
              textAnchor="middle"
              dominantBaseline="middle"
              data-flow-direction="B_TO_A"
              className={`traffic-edge__inline-label ${classes}`}
              style={{ fill: colorB, fontSize: 10 * (labelScale / 100) }}
            >
              {inlineTextB}
            </text>
          )}
        </>
      )}

      {trafficLabelMode === 'CARD' && (showMetric || showPathLabel) && (
        <EdgeLabelRenderer>
          <div
            className={`edge-metric edge-metric--${displayStyle.toLowerCase()} edge-metric--${worstTone} ${related ? '' : 'is-dimmed'}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${labelScale / 100})`,
            }}
          >
            {showPathLabel && (
              <div className="edge-metric__path">{visualPath?.label}</div>
            )}
            {showMetric && (
              <>
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
              </>
            )}
          </div>
        </EdgeLabelRenderer>
      )}

      {trafficLabelMode !== 'CARD' && showPathLabel && (
        <EdgeLabelRenderer>
          <div
            className={`edge-path-label ${related ? '' : 'is-dimmed'}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${labelScale / 100})`,
            }}
          >
            {visualPath?.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
