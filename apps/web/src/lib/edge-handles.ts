import type { LinkHandleSide, Position } from '@gmj/shared';

export type DeviceHandleSide = 'left' | 'right' | 'top' | 'bottom';
export const DEVICE_HANDLE_SIDES: DeviceHandleSide[] = ['left', 'right', 'top', 'bottom'];

export interface EdgeHandleSelection {
  sourceHandle: DeviceHandleSide;
  targetHandle: DeviceHandleSide;
}

const MANUAL_HANDLE_SIDES: Record<Exclude<LinkHandleSide, 'AUTO'>, DeviceHandleSide> = {
  TOP: 'top',
  RIGHT: 'right',
  BOTTOM: 'bottom',
  LEFT: 'left',
};

/** The React Flow handle id for a manual side, or null when it must stay automatic. */
export function manualHandleSide(side: LinkHandleSide): DeviceHandleSide | null {
  return side === 'AUTO' ? null : MANUAL_HANDLE_SIDES[side];
}

/**
 * Selects the shortest pair of opposite node sides from their relative position.
 * Handles are derived at render time, so persisted links created before four-sided
 * routing continue to work without a data migration.
 */
export function selectEdgeHandles(source: Position, target: Position): EdgeHandleSelection {
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' };
  }

  return deltaY >= 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' };
}

/**
 * Combines the automatic pairing with the per-end manual overrides. `AUTO` on
 * both ends is byte-for-byte the previous behaviour; a manual side only replaces
 * that end, so the opposite end keeps following the heuristic.
 */
export function resolveEdgeHandles(
  source: Position,
  target: Position,
  sourceSide: LinkHandleSide = 'AUTO',
  targetSide: LinkHandleSide = 'AUTO',
): EdgeHandleSelection {
  const automatic = selectEdgeHandles(source, target);
  return {
    sourceHandle: manualHandleSide(sourceSide) ?? automatic.sourceHandle,
    targetHandle: manualHandleSide(targetSide) ?? automatic.targetHandle,
  };
}
