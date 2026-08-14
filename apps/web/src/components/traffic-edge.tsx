'use client';

import { formatBitsPerSecond, utilizationTone, type NetworkLink } from '@gmj/shared';
import { EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';

export interface TrafficEdgeData extends Record<string, unknown> {
  link: NetworkLink;
  showTraffic: boolean;
  showUtilization: boolean;
  showLabels: boolean;
}

export type TrafficFlowEdge = Edge<TrafficEdgeData, 'traffic'>;

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
  const { link, showTraffic, showUtilization, showLabels } = data;
  const maxUtilization = Math.max(link.rxUtilization, link.txUtilization);
  const tone = link.status === 'DOWN' ? 'down' : utilizationTone(maxUtilization);
  const width = Math.max(
    2,
    Math.min(7, 1.8 + Math.log10(Math.max(link.capacityBps, 1_000_000_000)) - 8.5),
  );

  return (
    <>
      <path
        id={id}
        d={path}
        className={`traffic-edge traffic-edge--base traffic-edge--${tone} ${selected ? 'is-selected' : ''}`}
        style={{ strokeWidth: width }}
      />
      {showTraffic && link.status !== 'DOWN' && (
        <>
          <path
            d={path}
            className={`traffic-edge traffic-edge--flow traffic-edge--${tone}`}
            style={{
              strokeWidth: Math.max(1.5, width - 1),
              animationDuration: `${Math.max(0.65, 1.8 - maxUtilization / 80)}s`,
            }}
          />
          <path
            d={path}
            className={`traffic-edge traffic-edge--flow traffic-edge--reverse traffic-edge--${tone}`}
            style={{
              strokeWidth: Math.max(1, width - 2),
              animationDuration: `${Math.max(0.8, 2.1 - link.rxUtilization / 70)}s`,
            }}
          />
        </>
      )}
      <path d={path} className="traffic-edge__hitarea" />
      {showLabels && (
        <EdgeLabelRenderer>
          <div
            className={`edge-metric edge-metric--${tone}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <span>→ {formatBitsPerSecond(link.txBps)}</span>
            <span>← {formatBitsPerSecond(link.rxBps)}</span>
            {showUtilization && <em>{maxUtilization.toFixed(0)}%</em>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
