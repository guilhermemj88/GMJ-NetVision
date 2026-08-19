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

function throughputText(bps: number): string {
  return formatBitsPerSecond(bps);
}

function utilizationText(utilization: number): string {
  return `${utilization.toFixed(0)}%`;
}

function opticalText(networkInterface?: NetworkInterface): string | null {
  if (!networkInterface) return null;
  const rx = networkInterface.rxPowerDbm;
  const tx = networkInterface.txPowerDbm;
  if (rx == null && tx == null) return null;
  return `RX ${rx == null ? '—' : `${rx.toFixed(2)} dBm`} · TX ${tx == null ? '—' : `${tx.toFixed(2)} dBm`}`;
}

function toneColor(tone: string, reverse = false): string {
  if (reverse) {
    switch (tone) {
      case 'attention': return '#c578e0';
      case 'high': return '#e052c8';
      case 'critical': return '#e03b5c';
      case 'down': return '#71545a';
      case 'unknown': return '#718894';
      default: return '#a98cff';
    }
  }

  switch (tone) {
    case 'attention': return '#dfb847';
    case 'high': return '#eb9340';
    case 'critical': return '#e24b4b';
    case 'down': return '#71545a';
    case 'unknown': return '#718894';
    default: return '#43d6f4';
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
    curvature: 0.24,
  });
  if (!data) return null;

  const {
    link,
    sourceInterface,
    targetInterface,
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
  const showMetric = showLabels && displayStyle !== 'MINIMAL' && (
    metricDisplay !== 'NONE' || opticalText(sourceInterface) !== null || opticalText(targetInterface) !== null
  );

  const sourceOptical = opticalText(sourceInterface);
  const targetOptical = opticalText(targetInterface);
  const displayThroughput = metricDisplay === 'THROUGHPUT' || metricDisplay === 'BOTH';
  const displayUtilization = metricDisplay === 'UTILIZATION' || metricDisplay === 'BOTH';
  const duration = Math.max(3.5, 6.4 - maxUtilization / 32);
  const packetCount = displayStyle === 'HYBRID' ? 5 : 3;
  const packetScale = Math.max(0.82, Math.min(1.25, linkScale / 100));
  const cableStroke = selected ? '#b9dce5' : link.status === 'DOWN' ? '#5a474a' : '#38505c';
  const cableOpacity = related ? (emphasized ? 0.95 : 0.68) : 0.16;
  const cableDash = link.status === 'DOWN' ? '5 5' : link.status === 'UNKNOWN' ? '2 5' : undefined;
  const arrowPath = `M ${-3.1 * packetScale} ${-2.1 * packetScale} L ${2.8 * packetScale} 0 L ${-3.1 * packetScale} ${2.1 * packetScale} Z`;

  return (
    <>
      <path
        id={id}
        d={path}
        className={`traffic-edge ${classes}`}
        style={{
          fill: 'none',
          stroke: cableStroke,
          strokeWidth: displayStyle === 'MINIMAL' ? Math.max(1.1, width) : Math.max(1.15, width * 1.08),
          strokeLinecap: 'round',
          strokeDasharray: cableDash,
          opacity: cableOpacity,
          filter: selected ? 'drop-shadow(0 0 3px rgba(90, 195, 220, 0.7))' : 'none',
        }}
      />

      {directional && related && link.status !== 'DOWN' && (
        <path
          d={path}
          className="traffic-edge"
          style={{
            fill: 'none',
            stroke: '#0b151b',
            strokeWidth: Math.max(3.2, width + 2.5),
            strokeLinecap: 'round',
            opacity: 0.28,
            pointerEvents: 'none',
          }}
        />
      )}

      {showTraffic && directional && link.status !== 'DOWN' && related && (
        <>
          {Array.from({ length: packetCount }, (_, index) => {
            const begin = -((index * duration) / packetCount);
            const color = toneColor(toneA);
            return (
              <g key={`a-to-b-${index}`} style={{ pointerEvents: 'none' }}>
                <circle r={1.45 * packetScale} fill={color} opacity={0.82} style={{ filter: `drop-shadow(0 0 2px ${color})` }}>
                  <animateMotion path={path} dur={`${duration}s`} begin={`${begin}s`} repeatCount="indefinite" rotate="auto" calcMode="linear" />
                </circle>
                <path d={arrowPath} fill={color} opacity={0.95} style={{ filter: `drop-shadow(0 0 2px ${color})` }}>
                  <animateMotion path={path} dur={`${duration}s`} begin={`${begin + 0.2}s`} repeatCount="indefinite" rotate="auto" calcMode="linear" />
                </path>
              </g>
            );
          })}

          {Array.from({ length: packetCount }, (_, index) => {
            const begin = -((index * duration) / packetCount) - duration / (packetCount * 2);
            const color = toneColor(toneB, true);
            return (
              <g key={`b-to-a-${index}`} style={{ pointerEvents: 'none' }}>
                <circle r={1.35 * packetScale} fill={color} opacity={0.76} style={{ filter: `drop-shadow(0 0 2px ${color})` }}>
                  <animateMotion path={path} dur={`${duration}s`} begin={`${begin}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" />
                </circle>
                <path d={arrowPath} fill={color} opacity={0.9} style={{ filter: `drop-shadow(0 0 2px ${color})` }}>
                  <animateMotion path={path} dur={`${duration}s`} begin={`${begin + 0.2}s`} repeatCount="indefinite" rotate="auto-reverse" keyPoints="1;0" keyTimes="0;1" calcMode="linear" />
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
            {metricDisplay !== 'NONE' && (
              <>
                <div className="edge-metric__row">
                  <span className="edge-metric__arrow">A→B</span>
                  {displayThroughput && <strong>{throughputText(aToB.bps)}</strong>}
                  {displayUtilization && <em>{utilizationText(aToB.utilization)}</em>}
                </div>
                <div className="edge-metric__row">
                  <span className="edge-metric__arrow edge-metric__arrow--reverse">B→A</span>
                  {displayThroughput && <strong>{throughputText(bToA.bps)}</strong>}
                  {displayUtilization && <em>{utilizationText(bToA.utilization)}</em>}
                </div>
              </>
            )}
            {sourceOptical && <small>{sourceInterface?.name} · {sourceOptical}</small>}
            {targetOptical && <small>{targetInterface?.name} · {targetOptical}</small>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
