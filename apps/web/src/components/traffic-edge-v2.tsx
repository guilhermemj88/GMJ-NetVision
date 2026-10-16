'use client';

/**
 * MAP-VISUAL-V2 — Fase D: renderer do enlace no MAPA REAL (engine V2).
 *
 * Uma única linha por enlace lógico:
 *  - cor pelo estado/utilização (verde < 50%, âmbar 50–80%, vermelho ≥ 80%,
 *    cinza tracejado sem telemetria/desatualizado, vermelho tracejado DOWN);
 *  - espessura pela capacidade, com clamp em pixels de tela (independe do zoom);
 *  - uma seta alinhada à tangente da curva, apontando o sentido dominante;
 *  - rótulo inteligente posicionado pela anticolisão global do canvas.
 *
 * A GEOMETRIA é a mesma da V1 (`buildBezierGeometry` reproduz os mesmos pontos
 * de controle de traffic-edge.tsx com `EDGE_CURVATURE` e `PATH_OFFSET_SCALE`),
 * então alternar V1/V2 não move nenhuma linha, curva ou posição de nó.
 *
 * O clique continua chegando ao React Flow (`onEdgeClick` do canvas), que
 * seleciona `{ kind: 'link', id }` e abre o ContextDrawer real.
 */

import { memo, useState } from 'react';
import { EdgeLabelRenderer, useStore, type Edge, type EdgeProps } from '@xyflow/react';
import type { LinkVisualPath, NetworkLink } from '@gmj/shared';
import {
  linkV2ArrowScale,
  linkV2ScreenStrokeWidth,
  linkV2ShowsArrow,
  resolveLinkV2EdgeStroke,
  type LinkV2Visual,
} from '@/lib/map-visual-v2';
import {
  LINK_V2_EDGE_CURVATURE,
  arrowPlacement,
  buildBezierGeometry,
} from '@/lib/map-visual-v2-geometry';
import { LINK_V2_LABEL_LIFT, type LinkV2LabelPlacement } from '@/lib/map-visual-v2-labels';
import type { ManualLabelOffset } from '@/lib/map-visual-v2-offsets';
import { PATH_OFFSET_SCALE } from '@/lib/link-curvature';

const STATE_OPACITY: Record<LinkV2Visual['state'], number> = {
  normal: 0.95,
  attention: 0.95,
  critical: 1,
  down: 1,
  inconsistent: 1,
  'no-data': 0.75,
  stale: 0.7,
};

export interface LinkV2EdgeData extends Record<string, unknown> {
  link: NetworkLink;
  /** Estado/cores/rótulo já resolvidos no canvas (dados reais de telemetria). */
  visual: LinkV2Visual;
  compactLabel: string;
  /** Rótulo manual da V1 (mesmo contrato) — vence a anticolisão. */
  manualOffset: ManualLabelOffset | null;
  /** Colocação calculada no canvas; null = ainda não colocada. */
  placement: LinkV2LabelPlacement | null;
  visualPath?: LinkVisualPath;
  autoOffset?: number;
  showLabels: boolean;
  dimmed?: boolean;
  emphasized?: boolean;
}

export type LinkV2FlowEdge = Edge<LinkV2EdgeData, 'trafficV2'>;

function LinkV2EdgeContent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<LinkV2FlowEdge> & { data: LinkV2EdgeData }) {
  const [hovered, setHovered] = useState(false);
  const zoom = useStore((state) => state.transform[2]);

  const { link, visual, compactLabel, manualOffset, placement, visualPath, autoOffset = 0 } = data;
  const edgeStroke = resolveLinkV2EdgeStroke({
    mode: 'zoom',
    capacityBps: link.capacityBps,
    dash: visual.strokeDasharray,
    zoom,
  });

  const geometry = buildBezierGeometry({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: LINK_V2_EDGE_CURVATURE,
    offset: autoOffset + (visualPath?.curvature ?? 0) * PATH_OFFSET_SCALE,
  });

  const arrow = linkV2ShowsArrow(visual)
    ? arrowPlacement(geometry, visual.direction === 'b2a' ? 'b2a' : 'a2b')
    : null;
  const arrowScale = linkV2ArrowScale(
    'zoom',
    linkV2ScreenStrokeWidth(link.capacityBps),
    zoom,
  );

  const anchor = {
    x: (geometry.p0.x + 3 * geometry.p1.x + 3 * geometry.p2.x + geometry.p3.x) / 8,
    y: (geometry.p0.y + 3 * geometry.p1.y + 3 * geometry.p2.y + geometry.p3.y) / 8,
  };
  const normal = (() => {
    const deltaX = geometry.p3.x - geometry.p0.x;
    const deltaY = geometry.p3.y - geometry.p0.y;
    const length = Math.hypot(deltaX, deltaY) || 1;
    return { x: -deltaY / length, y: deltaX / length };
  })();

  const highlight = selected || hovered;
  const showLabel = (data.showLabels || highlight) && !data.dimmed;
  const shift = manualOffset ?? placement ?? {
    dx: normal.x * LINK_V2_LABEL_LIFT,
    dy: normal.y * LINK_V2_LABEL_LIFT,
  };
  const labelMode: 'full' | 'compact' | 'hidden' = !showLabel
    ? 'hidden'
    : manualOffset
      ? 'full'
      : placement && placement.mode !== 'hidden'
        ? placement.mode
        : 'compact';

  const opacity = data.dimmed
    ? 0.22
    : data.emphasized
      ? 1
      : STATE_OPACITY[visual.state];

  return (
    <>
      {selected && (
        <path
          d={geometry.path}
          className="traffic-edge-v2__halo"
          vectorEffect={edgeStroke.nonScaling ? 'non-scaling-stroke' : undefined}
          style={{
            stroke: visual.color,
            strokeWidth: edgeStroke.strokeWidth + 5 / Math.max(0.25, zoom),
          }}
        />
      )}
      <path
        id={id}
        d={geometry.path}
        className="traffic-edge-v2__line"
        data-testid="traffic-edge-v2-line"
        data-link={link.id}
        data-state={visual.state}
        data-direction={visual.direction}
        vectorEffect={edgeStroke.nonScaling ? 'non-scaling-stroke' : undefined}
        style={{
          stroke: visual.color,
          strokeWidth: edgeStroke.strokeWidth,
          strokeDasharray: edgeStroke.strokeDasharray,
          opacity,
        }}
      />
      {arrow && (
        <path
          d="M-5,-4.6 L7,0 L-5,4.6 Z"
          className="traffic-edge-v2__arrow"
          data-testid="traffic-edge-v2-arrow"
          transform={`translate(${arrow.x},${arrow.y}) rotate(${arrow.angleDeg}) scale(${arrowScale})`}
          fill={visual.color}
          opacity={opacity}
        />
      )}
      {/* Área de clique igual à da V1: o evento sobe para o React Flow. */}
      <path
        d={geometry.path}
        className="traffic-edge__hitarea"
        data-testid="traffic-edge-v2-hitarea"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {labelMode !== 'hidden' && (
        <EdgeLabelRenderer>
          <div
            className={`traffic-edge-v2__label traffic-edge-v2__label--${labelMode} traffic-edge-v2__label--${visual.state} ${selected ? 'is-selected' : ''} ${manualOffset ? 'is-manual' : ''} nodrag nopan`}
            data-testid="traffic-edge-v2-label"
            data-manual={manualOffset ? 'true' : 'false'}
            title={
              manualOffset
                ? 'Rótulo em posição manual (offset preservado da V1)'
                : `${visual.reason}`
            }
            style={{
              transform: `translate(-50%, -50%) translate(${anchor.x + shift.dx}px, ${anchor.y + shift.dy}px)`,
            }}
          >
            {labelMode === 'full' ? visual.labelText : compactLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const TrafficEdgeV2 = memo(function TrafficEdgeV2(props: EdgeProps<LinkV2FlowEdge>) {
  return props.data ? <LinkV2EdgeContent {...props} data={props.data} /> : null;
});
