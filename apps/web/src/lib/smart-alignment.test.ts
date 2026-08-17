import { describe, expect, it } from 'vitest';
import { calculateSmartAlignment, type AlignmentNode } from './smart-alignment';

const target: AlignmentNode = {
  id: 'target', position: { x: 200, y: 100 }, width: 80, height: 60,
};

describe('calculateSmartAlignment', () => {
  it('snaps horizontal centers and returns a horizontal guide', () => {
    const dragged = { id: 'dragged', position: { x: 20, y: 105 }, width: 80, height: 50 };
    const result = calculateSmartAlignment(dragged, [target], 8, true);
    expect(result.position.y).toBe(105);
    expect(result.guides).toEqual([expect.objectContaining({ axis: 'horizontal', targetId: 'target' })]);
  });

  it('snaps vertical centers and returns a vertical guide', () => {
    const dragged = { id: 'dragged', position: { x: 203, y: 250 }, width: 74, height: 60 };
    const result = calculateSmartAlignment(dragged, [target], 8, true);
    expect(result.position.x).toBe(203);
    expect(result.guides).toEqual([expect.objectContaining({ axis: 'vertical', targetId: 'target' })]);
  });

  it('does not snap outside the tolerance', () => {
    const dragged = { id: 'dragged', position: { x: 20, y: 120 }, width: 80, height: 50 };
    expect(calculateSmartAlignment(dragged, [target], 8, true)).toEqual({
      position: dragged.position, guides: [],
    });
  });

  it('chooses the smallest offset and then the nearest candidate', () => {
    const dragged = { id: 'dragged', position: { x: 102, y: 300 }, width: 80, height: 60 };
    const candidates = [
      { id: 'far', position: { x: 105, y: 0 }, width: 80, height: 60 },
      { id: 'best', position: { x: 103, y: 220 }, width: 80, height: 60 },
    ];
    const result = calculateSmartAlignment(dragged, candidates, 8, true);
    expect(result.position.x).toBe(103);
    expect(result.guides[0]?.targetId).toBe('best');
  });

  it('returns no snap or guide when edit mode is disabled', () => {
    const dragged = { id: 'dragged', position: { x: 203, y: 250 }, width: 74, height: 60 };
    expect(calculateSmartAlignment(dragged, [target], 8, false)).toEqual({
      position: dragged.position, guides: [],
    });
  });
});
