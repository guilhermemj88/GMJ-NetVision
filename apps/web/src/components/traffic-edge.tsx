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
    curvature: 0.3,
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
  const width = Math.max(1.1, Math.min(2.1, 1.25 + Math.log10(Math.max(link.capacityBps, 1_000_000_000)) - 9.2)) * (linkScale / 100);
  const distance = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
  const laneGap = Math.max(2.4, Math.min(4, 2.5 + width * 0.45));
  const offsetX = (-(targetY - sourceY) / distance) * laneGap;
  const offsetY = ((targetX - sourceX) / distance) * laneGap;
  const classes = `${selected ? 'is-selected' : ''} ${related ? '' : 'is-dimmed'} ${emphasized ? 'is-emphasized' : ''}`;
  const directional = displayStyle !== 'MINIMAL';
  const showMetric = showLabels && displayStyle !== 'MINIMAL' && (
    metricDisplay !== 'NONE' || opticalText(sourceInterface) !== null || opticalText(targetInterface) !== null
  );
  const chevronScale = Math.max(0.8, Math.min(1.35, linkScale / 100));
  const chevronPathFor = (scale: number) =>
    `M ${-1.9 * scale} ${-1.6 * scale} L ${0.8 * scale} 0 L ${-1.9 * scale} ${1.6 * scale}`;
  const baseChevronStroke = Math.max(1, Math.min(1.5, width * 1.05));
  // Chevron train: each wave grows from a small, faint tail into a bright head,
  // then a short empty gap separates it from the next wave. The whole train
  // advances along the lane continuously.
  const waveSize = 6;
  const gapSlots = 3;
  const slotCount = Math.max(waveSize + gapSlots, Math.min(32, Math.round(distance / 20)));
  const waveCount = Math.floor(slotCount / (waveSize + gapSlots));
  const chevrons = Array.from({ length: waveCount * waveSize }, (_, index) => {
    const waveIndex = Math.floor(index / waveSize);
    const intra = index % waveSize;
    const slot = waveIndex * (waveSize + gapSlots) + intra;
    const progress = intra / (waveSize - 1);
    return { slot, progress };
  });
  const duration = Math.max(4.5, 7 - maxUtilization / 40);
  const sourceOptical = opticalText(sourceInterface);
  const targetOptical = opticalText(targetInterface);
  const displayThroughput = metricDisplay === 'THROUGHPUT' || metricDisplay === 'BOTH';
  const displayUtilization = metricDisplay === 'UTILIZATION' || metricDisplay === 'BOTH';

  return (
    <>
      {!directional && (
        <path id={id} d={path} className={`traffic-edge traffic-edge--base traffic-edge--${worstTone} ${classes}`} style={{ strokeWidth: displayStyle === 'MINIMAL' ? Math.max(1.5, width - 1) : width }} />
      )}

      {directional && (
        <>
          <path d={path} transform={`translate(${offsetX} ${offsetY})`} className={`traffic-edge traffic-edge--halo traffic-edge--ab traffic-edge--${toneA} ${classes}`} style={{ strokeWidth: width + 3 }} />
          <path d={path} transform={`translate(${-offsetX} ${-offsetY})`} className={`traffic-edge traffic-edge--halo traffic-edge--ba traffic-edge--${toneB} ${classes}`} style={{ strokeWidth: width + 3 }} />
          <path d={path} transform={`translate(${offsetX} ${offsetY})`} className={`traffic-edge traffic-edge--lane traffic-edge--ab traffic-edge--${toneA} ${classes}`} style={{ strokeWidth: width }} />
          <path d={path} transform={`translate(${-offsetX} ${-offsetY})`} className={`traffic-edge traffic-edge--lane traffic-edge--lane-reverse traffic-edge--ba traffic-edge--${toneB} ${classes}`} style={{ strokeWidth: width }} />
        </>
      )}

      {showTraffic && link.status !== 'DOWN' && displayStyle !== 'MINIMAL' && (
        <>
          <g transform={`translate(${offsetX} ${offsetY})`}>
            {chevrons.map(({ slot, progress }, index) => {
              const sizeFactor = 0.55 + 1.25 * progress;
              const strokeOpacity = 0.3 + 0.7 * progress;
              return (
                <path
                  key={`a-to-b-${index}`}
                  d={chevronPathFor(chevronScale * sizeFactor)}
                  className={`traffic-chevron traffic-edge--ab traffic-edge--${toneA} ${classes}`}
                  style={{ strokeWidth: baseChevronStroke * sizeFactor, strokeOpacity }}
                >
                  <animateMotion path={path} dur={`${duration}s`} begin={`${-(slot * duration) / slotCount}s`} repeatCount="indefinite" rotate="auto" calcMode="linear" keyPoints="0;1" keyTimes="0;1" />
                </path>
              );
            })}
          </g>
          <g transform={`translate(${-offsetX} ${-offsetY})`}>
            {chevrons.map(({ slot, progress }, index) => {
              const sizeFactor = 0.55 + 1.25 * progress;
              const strokeOpacity = 0.3 + 0.7 * progress;
              return (
                <path
                  key={`b-to-a-${index}`}
                  d={chevronPathFor(chevronScale * sizeFactor)}
                  className={`traffic-chevron traffic-chevron--reverse traffic-edge--ba traffic-edge--${toneB} ${classes}`}
                  style={{ strokeWidth: baseChevronStroke * sizeFactor, strokeOpacity }}
                >
                  <animateMotion path={path} dur={`${duration}s`} begin={`${-(slot * duration) / slotCount}s`} repeatCount="indefinite" rotate="auto-reverse" keyPoints="1;0" keyTimes="0;1" calcMode="linear" />
                </path>
              );
            })}
          </g>
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
