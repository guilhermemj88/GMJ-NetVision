'use client';

import { EdgeLabelRenderer, useViewport } from '@xyflow/react';
import type { NetworkLink } from '@gmj/shared';
import { useMapStore } from '@/store/map-store';
import type { LinkCurvatureDrag } from './use-link-curvature-drag';

/**
 * Mid-curve affordance of the selected link. The drag itself lives in
 * `useLinkCurvatureDrag` so the curve can also be grabbed anywhere along its
 * length by `TrafficEdge`.
 */
export function LinkCurvatureHandle({
  link,
  pathIndex,
  point,
  drag,
}: {
  link: NetworkLink;
  pathIndex: number;
  point: { x: number; y: number };
  drag: LinkCurvatureDrag;
}) {
  const { zoom } = useViewport();
  const busy = useMapStore((state) => Boolean(state.linkGeometryDrafts[link.id]));

  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        className="link-curvature-handle nodrag nopan"
        aria-label={`Arrastar curva do caminho ${pathIndex + 1}${link.visualPaths[pathIndex]?.label ? `: ${link.visualPaths[pathIndex]?.label}` : ''}`}
        title={`Arrastar curva do caminho ${pathIndex + 1}`}
        aria-disabled={busy && !drag.dragging}
        style={{
          transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px) scale(${1 / Math.max(zoom, 0.01)})`,
        }}
        onClick={(event) => event.stopPropagation()}
        {...drag.dragHandlers}
      >
        <span className="link-curvature-handle__dot" />
        {drag.offset !== null && (
          <span className="link-curvature-handle__value">
            Curvatura: {drag.offset >= 0 ? '+' : ''}
            {Math.round(drag.offset)} px
          </span>
        )}
      </button>
    </EdgeLabelRenderer>
  );
}
