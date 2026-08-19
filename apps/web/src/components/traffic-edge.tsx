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

type CubicBezier = {
  p0: [number, number];
  p1: [number, number];
  p2: [number, number];
  p3: [number, number];
};

function parseCubicBezier(path: string): CubicBezier | null {
  const numbers = path.replace(/[MC]/g, ' ').match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length !== 8) return null;
  const values = numbers.map(Number);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = values;
  return {
    p0: [x0, y0],
    p1: [x1, y1],
    p2: [x2, y2],
    p3: [x3, y3],
  };
}

function cubicPoint(bezier: CubicBezier, t: number): [number, number] {
  const { p0, p1, p2, p3 } = bezier;
  const mt = 1 - t;
  const x = mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0];
  const y = mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1];
  return [x, y];
}

function cubicTangent(bezier: CubicBezier, t: number): [number, number] {
  const { p0, p1, p2, p3 } = bezier;
  const mt = 1 - t;
  const dx = 3 * mt * mt * (p1[0] - p0[0]) + 6 * mt * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
  const dy = 3 * mt * mt * (p1[1] - p0[1]) + 6 * mt * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
  return [dx, dy];
}

interface ChevronPoint {
  x: number;
  y: number;
  angle: number;
}

// Evenly space `count` chevrons along the lane path, each aligned to the local
// tangent so curved links keep a uniform separation between the two lanes.
function sampleChevrons(path: string, count: number): ChevronPoint[] {
  const bezier = parseCubicBezier(path);
  if (!bezier || count <= 0) return [];

  const SAMPLES = 48;
  const points: Array<[number, number]> = [cubicPoint(bezier, 0)];
  const lengths: number[] = [0];
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const point = cubicPoint(bezier, t);
    const previous = points[points.length - 1] ?? [0, 0];
    const last = lengths[lengths.length - 1] ?? 0;
    lengths.push(last + Math.hypot(point[0] - previous[0], point[1] - previous[1]));
    points.push(point);
  }

  const total = lengths[lengths.length - 1] ?? 0;
  if (total <= 0) return [];

  const chevrons: ChevronPoint[] = [];
  for (let i = 0; i < count; i++) {
    const target = ((i + 0.5) / count) * total;
    let segment = 0;
    while (segment < lengths.length - 1 && (lengths[segment + 1] ?? 0) < target) segment += 1;
    const segmentStart = lengths[segment] ?? 0;
    const segmentEnd = lengths[segment + 1] ?? segmentStart;
    const segmentLength = segmentEnd - segmentStart || 1;
    const local = (target - segmentStart) / segmentLength;
    const t = (segment + local) / SAMPLES;
    const point = cubicPoint(bezier, t);
    const tangent = cubicTangent(bezier, t);
    const angle = (Math.atan2(tangent[1], tangent[0]) * 180) / Math.PI;
    chevrons.push({ x: point[0], y: point[1], angle });
  }
  return chevrons;
}

interface ChevronWaveProps {
  idPrefix: string;
  points: ChevronPoint[];
  color: string;
  glow: number;
  duration: number;
  reverse: boolean;
  chevronPath: string;
  base: number;
  peak: number;
  waveWidth: number;
  strokeWidth: number;
}

function ChevronWave({
  idPrefix,
  points,
  color,
  glow,
  duration,
  reverse,
  chevronPath,
  base,
  peak,
  waveWidth,
  strokeWidth,
}: ChevronWaveProps) {
  const glowFilter = `drop-shadow(0 0 ${glow}px ${color})`;
  const keyTimes = `0; ${0.5 - waveWidth}; 0.5; ${0.5 + waveWidth}; 1`;
  const values = `${base}; ${base}; ${peak}; ${base}; ${base}`;
  const keySplines = '0.4 0 0.6 1;0.4 0 0.6 1;0.4 0 0.6 1;0.4 0 0.6 1';

  return (
    <g style={{ pointerEvents: 'none' }}>
      {points.map((point, index) => {
        const s = points.length > 1 ? index / (points.length - 1) : 0;
        const begin = reverse ? -s * duration : (s - 1) * duration;
        const angle = point.angle + (reverse ? 180 : 0);
        return (
          <path
            key={`${idPrefix}-${index}`}
            d={chevronPath}
            className="traffic-chevron"
            transform={`translate(${point.x} ${point.y}) rotate(${angle})`}
            opacity={base}
            style={{ stroke: color, color, strokeWidth, filter: glowFilter }}
          >
            <animate
              attributeName="opacity"
              values={values}
              keyTimes={keyTimes}
              keySplines={keySplines}
              dur={`${duration}s`}
              begin={`${begin}s`}
              repeatCount="indefinite"
              calcMode="spline"
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
  const chevronScale = Math.max(0.85, Math.min(1.15, linkScale / 100));
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
  const renderLanes = directional && showTraffic && link.status !== 'DOWN' && related;

  // Lane density: shorter spacing and more chevrons when utilization is high.
  const approxLength = Math.max(40, segmentLength * 1.15);
  const chevronSpacing = Math.max(6, 8 - maxUtilization / 40);
  const chevronCount = Math.max(6, Math.min(26, Math.round(approxLength / chevronSpacing)));
  const waveBase = 0.28;
  const wavePeak = emphasized || selected ? 1 : 0.95;
  const waveWidth = 0.18;
  const chevronStrokeWidth = Math.max(1.2, width * 0.8);
  const aToBPoints = renderLanes ? sampleChevrons(laneAPath, chevronCount) : [];
  const bToAPoints = renderLanes ? sampleChevrons(laneBPath, chevronCount) : [];

  return (
    <>
      <path
        id={id}
        d={path}
        className={`traffic-edge traffic-edge--base ${statusTone ? toneClass(statusTone) : ''} ${classes}`}
        style={{ strokeWidth: Math.max(0.8, width * 0.6) }}
      />

      {renderLanes && (
        <>
          <ChevronWave
            idPrefix="a-to-b"
            points={aToBPoints}
            color={colorA}
            glow={flowGlow(levelA) * glowBoost}
            duration={duration}
            reverse={false}
            chevronPath={chevronPath}
            base={waveBase}
            peak={wavePeak}
            waveWidth={waveWidth}
            strokeWidth={chevronStrokeWidth}
          />
          <ChevronWave
            idPrefix="b-to-a"
            points={bToAPoints}
            color={colorB}
            glow={flowGlow(levelB) * glowBoost}
            duration={duration}
            reverse
            chevronPath={chevronPath}
            base={waveBase}
            peak={wavePeak}
            waveWidth={waveWidth}
            strokeWidth={chevronStrokeWidth}
          />
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
