import type { Position } from '@gmj/shared';

export type DeviceHandleSide = 'left' | 'right' | 'top' | 'bottom';
export const DEVICE_HANDLE_SIDES: DeviceHandleSide[] = ['left', 'right', 'top', 'bottom'];

export interface EdgeHandleSelection {
  sourceHandle: DeviceHandleSide;
  targetHandle: DeviceHandleSide;
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
