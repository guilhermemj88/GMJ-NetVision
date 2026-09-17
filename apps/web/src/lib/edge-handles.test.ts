import { describe, expect, it } from 'vitest';
import { LINK_HANDLE_SIDES, LINK_HANDLE_SIDE_LABELS, normalizeLinkHandleSide } from '@gmj/shared';
import {
  DEVICE_HANDLE_SIDES,
  manualHandleSide,
  resolveEdgeHandles,
  selectEdgeHandles,
} from './edge-handles';

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

describe('resolveEdgeHandles', () => {
  const source = { x: 0, y: 0 };
  const target = { x: 400, y: 60 };

  it('keeps the automatic behaviour when both ends are AUTO', () => {
    expect(resolveEdgeHandles(source, target)).toEqual(selectEdgeHandles(source, target));
    expect(resolveEdgeHandles(source, target, 'AUTO', 'AUTO')).toEqual(
      selectEdgeHandles(source, target),
    );
    // automatic here is right -> left
    expect(resolveEdgeHandles(source, target, 'AUTO', 'AUTO')).toEqual({
      sourceHandle: 'right',
      targetHandle: 'left',
    });
  });

  it.each([
    ['TOP', 'top'],
    ['RIGHT', 'right'],
    ['BOTTOM', 'bottom'],
    ['LEFT', 'left'],
  ] as const)('pins the source end to %s without touching the target end', (side, handle) => {
    expect(resolveEdgeHandles(source, target, side, 'AUTO')).toEqual({
      sourceHandle: handle,
      targetHandle: selectEdgeHandles(source, target).targetHandle,
    });
  });

  it.each([
    ['TOP', 'top'],
    ['RIGHT', 'right'],
    ['BOTTOM', 'bottom'],
    ['LEFT', 'left'],
  ] as const)('pins the target end to %s without touching the source end', (side, handle) => {
    expect(resolveEdgeHandles(source, target, 'AUTO', side)).toEqual({
      sourceHandle: selectEdgeHandles(source, target).sourceHandle,
      targetHandle: handle,
    });
  });

  it('supports both ends pinned, including sides the heuristic would never choose', () => {
    expect(resolveEdgeHandles(source, target, 'BOTTOM', 'TOP')).toEqual({
      sourceHandle: 'bottom',
      targetHandle: 'top',
    });
    expect(resolveEdgeHandles(source, target, 'LEFT', 'LEFT')).toEqual({
      sourceHandle: 'left',
      targetHandle: 'left',
    });
  });

  it('falls back to AUTO for missing or unknown persisted values', () => {
    expect(manualHandleSide('AUTO')).toBeNull();
    expect(normalizeLinkHandleSide(undefined)).toBe('AUTO');
    expect(normalizeLinkHandleSide(null)).toBe('AUTO');
    expect(normalizeLinkHandleSide('')).toBe('AUTO');
    expect(normalizeLinkHandleSide('top')).toBe('AUTO');
    expect(normalizeLinkHandleSide('SIDEWAYS')).toBe('AUTO');
    expect(normalizeLinkHandleSide('BOTTOM')).toBe('BOTTOM');
    // a legacy link without the fields behaves exactly like AUTO/AUTO
    expect(
      resolveEdgeHandles(source, target, normalizeLinkHandleSide(undefined), normalizeLinkHandleSide(undefined)),
    ).toEqual(selectEdgeHandles(source, target));
  });

  it('exposes the five UI options once, in the documented order', () => {
    expect(LINK_HANDLE_SIDES).toEqual(['AUTO', 'TOP', 'RIGHT', 'BOTTOM', 'LEFT']);
    expect(LINK_HANDLE_SIDE_LABELS.map((option) => option.value)).toEqual([...LINK_HANDLE_SIDES]);
    expect(LINK_HANDLE_SIDE_LABELS.map((option) => option.label)).toEqual([
      'Automática',
      'Superior',
      'Direita',
      'Inferior',
      'Esquerda',
    ]);
  });
});
