import { describe, expect, it } from 'vitest';
import { DEVICE_HANDLE_SIDES, selectEdgeHandles } from './edge-handles';

describe('selectEdgeHandles', () => {
  it('exposes all four host connection points', () => {
    expect(DEVICE_HANDLE_SIDES).toEqual(['left', 'right', 'top', 'bottom']);
  });

  it.each([
    [{ x: 0, y: 0 }, { x: 200, y: 20 }, { sourceHandle: 'right', targetHandle: 'left' }],
    [{ x: 200, y: 20 }, { x: 0, y: 0 }, { sourceHandle: 'left', targetHandle: 'right' }],
    [{ x: 0, y: 0 }, { x: 20, y: 200 }, { sourceHandle: 'bottom', targetHandle: 'top' }],
    [{ x: 20, y: 200 }, { x: 0, y: 0 }, { sourceHandle: 'top', targetHandle: 'bottom' }],
  ])('routes links through the closest of all four sides', (source, target, expected) => {
    expect(selectEdgeHandles(source, target)).toEqual(expected);
  });
});
