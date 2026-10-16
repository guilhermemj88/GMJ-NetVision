'use client';

/**
 * MAP-VISUAL-V2 — renderer de enlace (Fase B, laboratório).
 *
 * UMA linha principal por enlace lógico:
 *  - cor   → utilização/estado (tokens do lib puro);
 *  - grossura → capacidade;
 *  - seta  → sentido dominante, alinhada à tangente da curva Bézier;
 *  - padrão → estado operacional.
 *
 * O renderer V1 (`traffic-edge.tsx`) não foi tocado; no laboratório os dois
 * convivem e a escolha é um controle da página.
 */

import { useState } from 'react';
import { EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import { linkV2ShowsArrow } from '@/lib/map-visual-v2';
import {
  arrowPlacement,
  buildBezierGeometry,
  perpendicularOf,
  pointOnBezier,
  type SidePosition,
} from '@/lib/map-visual-v2-geometry';
import type { LinkV2LabelPlacement } from '@/lib/map-visual-v2-labels';
import { LAB_LABEL_LIFT, LINK_V2_CURVATURE, type LinkV2EdgeModel } from './v2-model';

export interface LinkV2EdgeData extends Record<string, unknown> {
  model: LinkV2EdgeModel;
  placement: LinkV2LabelPlacement | null;
  /** Rótulo liberado pela política (seleção/hover adicionam no render). */
  showLabel: boolean;
  /** Tooltip forçado (captura/demonstração). */
  forceTooltip: boolean;
}

export type LinkV2FlowEdge = Edge<LinkV2EdgeData, 'trafficV2'>;

const STATE_OPACITY: Record<LinkV2EdgeModel['visual']['state'], number> = {
  normal: 0.88,
  attention: 0.92,
  critical: 0.98,
  down: 0.9,
  'no-data': 0.72,
  stale: 0.72,
  inconsistent: 0.9,
};

export function LinkV2Edge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<LinkV2FlowEdge>) {
  const [hovered, setHovered] = useState(false);
  if (!data) return null;

  const { model } = data;
  const visual = model.visual;
  const geometry = buildBezierGeometry({
    sourceX,
    sourceY,
    sourcePosition: sourcePosition as SidePosition,
    targetX,
    targetY,
    targetPosition: targetPosition as SidePosition,
    curvature: LINK_V2_CURVATURE,
    offset: model.offset,
  });

  const midpoint = pointOnBezier(geometry, 0.5);
  const normal = perpendicularOf(geometry);
  const arrow =
    linkV2ShowsArrow(visual) && visual.direction !== 'balanced'
      ? arrowPlacement(geometry, visual.direction === 'b2a' ? 'b2a' : 'a2b')
      : null;

  const showLabel = data.showLabel || selected || hovered;
  const placement = data.placement;
  const labelMode: 'full' | 'compact' | 'hidden' = !showLabel
    ? 'hidden'
    : placement && placement.mode !== 'hidden'
      ? placement.mode
      : 'compact';
  const shift = placement ?? { dx: normal.x * LAB_LABEL_LIFT, dy: normal.y * LAB_LABEL_LIFT };
  const labelX = midpoint.x + shift.dx;
  const labelY = midpoint.y + shift.dy;
  const tooltipVisible = hovered || data.forceTooltip;
  /**
   * Heurística do laboratório: âncoras na faixa superior abrem o tooltip para
   * baixo, para ele não ser cortado na borda do canvas.
   */
  const tooltipBelow = midpoint.y < 260;
  const tooltipTransform = tooltipBelow
    ? `translate(-50%, 0) translate(${midpoint.x}px, ${midpoint.y + 18}px)`
    : `translate(-50%, -100%) translate(${midpoint.x}px, ${midpoint.y - 16}px)`;

  return (
    <>
      {selected && (
        <path
          d={geometry.path}
          className="mv2-edge-halo"
          style={{ stroke: visual.color, strokeWidth: visual.strokeWidth + 5 }}
        />
      )}
      <path
        id={id}
        d={geometry.path}
        className="mv2-edge"
        data-state={visual.state}
        data-direction={visual.direction}
        data-partial={visual.partial ? 'true' : 'false'}
        style={{
          stroke: visual.color,
          strokeWidth: visual.strokeWidth,
          strokeDasharray: visual.strokeDasharray,
          opacity: selected ? 1 : STATE_OPACITY[visual.state],
        }}
      />
      {arrow && (
        <path
          d="M-5,-4.6 L7,0 L-5,4.6 Z"
          className="mv2-edge-arrow"
          transform={`translate(${arrow.x},${arrow.y}) rotate(${arrow.angleDeg})`}
          fill={visual.color}
        />
      )}
      <path
        d={geometry.path}
        className="traffic-edge__hitarea"
        data-testid={`mv2-edge-hit-${model.id}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />

      {labelMode !== 'hidden' && (
        <EdgeLabelRenderer>
          <div
            className={`mv2-edge-label mv2-edge-label--${labelMode} mv2-edge-label--${visual.state} ${
              selected ? 'is-selected' : ''
            } ${visual.partial ? 'is-partial' : ''} nodrag nopan`}
            data-testid={`mv2-edge-label-${model.id}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {labelMode === 'full' ? model.labelText : model.compactLabelText}
          </div>
        </EdgeLabelRenderer>
      )}

      {tooltipVisible && (
        <EdgeLabelRenderer>
          <div
            className="mv2-edge-tooltip nodrag nopan"
            data-testid={`mv2-edge-tooltip-${model.id}`}
            style={{
              transform: tooltipTransform,
            }}
          >
            <div className="mv2-edge-tooltip__title">
              {model.tooltip.aName} <span aria-hidden="true">↔</span> {model.tooltip.bName}
            </div>
            <div className={`mv2-edge-tooltip__state mv2-edge-tooltip__state--${visual.state}`}>
              {model.tooltip.stateLabel}
              {model.simTag ? <em> · {model.simTag}</em> : null}
              {visual.partial ? <em> · avaliação parcial</em> : null}
            </div>
            <dl className="mv2-edge-tooltip__rows">
              <div>
                <dt>A→B</dt>
                <dd>{model.tooltip.aToBText}</dd>
              </div>
              <div>
                <dt>B→A</dt>
                <dd>{model.tooltip.bToAText}</dd>
              </div>
              <div>
                <dt>Capacidade</dt>
                <dd>{model.tooltip.capacityText}</dd>
              </div>
              <div>
                <dt>Qualidade</dt>
                <dd>{model.tooltip.consistencyText}</dd>
              </div>
              <div>
                <dt>Amostra</dt>
                <dd>{model.tooltip.sampleText}</dd>
              </div>
              <div>
                <dt>Fonte</dt>
                <dd>{model.tooltip.metricsSource}</dd>
              </div>
              {model.tooltip.alarmsText ? (
                <div>
                  <dt>Alarmes</dt>
                  <dd>{model.tooltip.alarmsText}</dd>
                </div>
              ) : null}
            </dl>
            <p className="mv2-edge-tooltip__desc">{model.tooltip.description}</p>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
