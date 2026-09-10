import { defaultVisualPaths, type NetworkLink } from '@gmj/shared';

export const PATH_OFFSET_SCALE = 0.9;
// Both cubic controls move by offset; their combined weight at t=0.5 is 3/4.
export const BEZIER_MIDPOINT_WEIGHT = 0.75;
export const MAX_CURVATURE = 500;
export type LinkGeometry = Pick<NetworkLink, 'visualPaths' | 'linkLayoutMode'>;

export function manualLinkGeometry(link: LinkGeometry, autoOffset: number): LinkGeometry {
  return {
    linkLayoutMode: 'MANUAL',
    visualPaths: (link.visualPaths.length ? link.visualPaths : defaultVisualPaths(1)).map(
      (path) => ({
        ...path,
        // Bake the automatic bow into every path, including disabled paths.
        curvature:
          path.curvature + (link.linkLayoutMode === 'MANUAL' ? 0 : autoOffset / PATH_OFFSET_SCALE),
      }),
    ),
  };
}

export function draggedCurvature(
  initial: number,
  start: { x: number; y: number },
  pointer: { x: number; y: number },
  source: { x: number; y: number },
  target: { x: number; y: number },
): number {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  if (!length) return initial;
  const displacement = ((pointer.x - start.x) * -dy + (pointer.y - start.y) * dx) / length;
  const value = initial + displacement / (BEZIER_MIDPOINT_WEIGHT * PATH_OFFSET_SCALE);
  return Number.isFinite(value)
    ? Math.max(-MAX_CURVATURE, Math.min(MAX_CURVATURE, value))
    : initial;
}

export function resetLinkGeometry(link: LinkGeometry, automatic = false): LinkGeometry {
  return {
    linkLayoutMode: automatic ? 'AUTO' : link.linkLayoutMode,
    visualPaths: link.visualPaths.map((path) => ({ ...path, curvature: 0 })),
  };
}
