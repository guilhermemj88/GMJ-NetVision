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
// Direction color families (kept distinct as utilization intensifies).
const HUE_A = 190; // cyan / blue
const HUE_B = 265; // violet / magenta

type FlowLevel = 'normal' | 'attention' | 'high' | 'critical' | 'down' | 'unknown';

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

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${hue.toFixed(0)}, ${saturation.toFixed(0)}%, ${lightness.toFixed(0)}%)`;
}

function flowLevel(utilization: number): FlowLevel {
  return utilizationLevel(utilization).toLowerCase() as FlowLevel;
}

// Utilization drives saturation/lightness, keeping each direction's hue family.
function flowColor(hue: number, level: FlowLevel): string {
  switch (level) {
    case 'critical': return hsl(hue, 100, 54);
    case 'high': return hsl(hue, 95, 56);
    case 'attention': return hsl(hue, 84, 63);
    case 'down': return '#6e5558';
    case 'unknown': return '#718894';
    default: return hsl(hue, 58, 72);
  }
}

function flowGlow(level: FlowLevel): number {
  switch (level) {
    case 'critical': return 9;
    case 'high': return 6.5;
    case 'attention': return 4;
    case 'down':
    case 'unknown': return 1.5;
    default: return 2.5;
  }
}

interface ChevronBandProps {
  idPrefix: string;
  path: string;
  color: string;
  glow: number;
  duration: number;
  begin: number;
  reverse: boolean;
  chevronPath: string;
  clusterCount: number;
  trailCount: number;
  clusterStep: number;
  trailStep: number;
  opacity: number;
}

function ChevronBand({
  idPrefix,
  path,
  color,
  glow,
  duration,
  begin,
  reverse,
  chevronPath,
  clusterCount,
  trailCount,
  clusterStep,
  trailStep,
  opacity,
}: ChevronBandProps) {
  const rotate = reverse ? 'auto-reverse' : 'auto';
  const keyPoints = reverse ? '1;0' : '0;1';
  const glowFilter = `drop-shadow(0 0 ${glow}px ${color})`;

  return (
    <g style={{ pointerEvents: 'none' }}>
      {Array.from({ length: clusterCount }, (_, index) => (
        <path
          key={`${idPrefix}-c-${index}`}
          d={chevronPath}
          className="traffic-chevron"
          style={{ stroke: color, color, opacity, filter: glowFilter }}
        >
          <animateMotion
            path={path}
            dur={`${duration}s`}
            begin={`${begin + index * clusterStep}s`}
            repeatCount="indefinite"
            rotate={rotate}
            keyPoints={keyPoints}
            keyTimes="0;1"
            calcMode="linear"
          />
        </path>
      ))}
      {Array.from({ length: trailCount }, (_, index) => {
        const fade = (trailCount - index) / (trailCount + 1);
        return (
          <path
            key={`${idPrefix}-t-${index}`}
            d={chevronPath}
            className="traffic-chevron"
            style={{ stroke: color, color, opacity: opacity * fade, filter: glowFilter }}
          >
            <animateMotion
              path={path}
              dur={`${duration}s`}
              begin={`${begin + clusterCount * clusterStep + (index + 1) * trailStep}s`}
              repeatCount="indefinite"
              rotate={rotate}
              keyPoints={keyPoints}
              keyTimes="0;1"
              calcMode="linear"
            />
          </path>
        );
      })}
    </g>
  );
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
  const levelA: FlowLevel = statusTone ?? flowLevel(aToB.utilization);
  const levelB: FlowLevel = statusTone ?? flowLevel(bToA.utilization);
  const worstTone = statusTone ?? flowLevel(maxUtilization);

  const width = Math.max(1, Math.min(1.8, 1.05 + Math.log10(Math.max(link.capacityBps, 1_000_000_000)) - 9.2)) * (linkScale / 100);
  const classes = `${selected ? 'is-selected' : ''} ${related ? '' : 'is-dimmed'} ${emphasized ? 'is-emphasized' : ''}`;
  const directional = displayStyle !== 'MINIMAL';
  const showMetric = showLabels && displayStyle !== 'MINIMAL' && metricDisplay !== 'NONE';

  const displayThroughput = metricDisplay === 'THROUGHPUT' || metricDisplay === 'BOTH';
  const displayUtilization = metricDisplay === 'UTILIZATION' || metricDisplay === 'BOTH';
  const duration = Math.max(2.6, 6.8 - maxUtilization / 20);
  const density = 1 - Math.min(0.35, maxUtilization / 320);
  const chevronScale = Math.max(0.85, Math.min(1.15, linkScale / 100));
  const clusterSpacing = 5.6 * chevronScale * density;
  const trailSpacing = 7 * chevronScale * density;
  const clusterCount = displayStyle === 'HYBRID' ? 5 : 4;
  const trailCount = 3;
  const bandCount = 2;
  const chevronPath = `M ${-2.9 * chevronScale} ${-2.3 * chevronScale} L ${1.8 * chevronScale} 0 L ${-2.9 * chevronScale} ${2.3 * chevronScale}`;

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

  const colorA = flowColor(HUE_A, levelA);
  const colorB = flowColor(HUE_B, levelB);
  const glowBoost = emphasized || selected ? 1.35 : 1;
  const bandOpacity = emphasized || selected ? 1 : 0.92;
  const renderLanes = directional && showTraffic && link.status !== 'DOWN' && related;

  // Convert pixel spacing into animation-time offsets so the clustered
  // chevrons travel together as one wave while each one stays exactly on its
  // lane path (important for curved links).
  const approxLength = Math.max(40, segmentLength * 1.15);
  const clusterStep = (duration * clusterSpacing) / approxLength;
  const trailStep = (duration * trailSpacing) / approxLength;

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
          {Array.from({ length: bandCount }, (_, band) => (
            <ChevronBand
              key={`a-to-b-${band}`}
              idPrefix="a-to-b"
              path={laneAPath}
              color={colorA}
              glow={flowGlow(levelA) * glowBoost}
              duration={duration}
              begin={-((band * duration) / bandCount)}
              reverse={false}
              chevronPath={chevronPath}
              clusterCount={clusterCount}
              trailCount={trailCount}
              clusterStep={clusterStep}
              trailStep={trailStep}
              opacity={bandOpacity}
            />
          ))}
          {Array.from({ length: bandCount }, (_, band) => (
            <ChevronBand
              key={`b-to-a-${band}`}
              idPrefix="b-to-a"
              path={laneBPath}
              color={colorB}
              glow={flowGlow(levelB) * glowBoost}
              duration={duration}
              begin={-((band * duration) / bandCount) - duration / (bandCount * 2)}
              reverse
              chevronPath={chevronPath}
              clusterCount={clusterCount}
              trailCount={trailCount}
              clusterStep={clusterStep}
              trailStep={trailStep}
              opacity={bandOpacity}
            />
          ))}
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
