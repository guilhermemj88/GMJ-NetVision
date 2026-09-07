import { describe, expect, it } from 'vitest';
import {
  computeParallelLinkLayouts,
  parallelGroupKey,
  parallelOffsets,
  type LinkParallelLayoutInput,
} from './link-layout';

function input(
  id: string,
  sourceKey: string,
  targetKey: string,
  layoutMode: 'AUTO' | 'MANUAL' = 'AUTO',
): LinkParallelLayoutInput {
  return { id, sourceKey, targetKey, layoutMode };
}

describe('parallelGroupKey', () => {
  it('is direction-agnostic', () => {
    expect(parallelGroupKey('A', 'B')).toBe(parallelGroupKey('B', 'A'));
  });

  it('distinguishes different pairs', () => {
    expect(parallelGroupKey('A', 'B')).not.toBe(parallelGroupKey('A', 'C'));
  });
});

describe('parallelOffsets', () => {
  it('keeps a single link straight', () => {
    expect(parallelOffsets(1)).toEqual([0]);
  });

  it('returns symmetric offsets for two links', () => {
    expect(parallelOffsets(2)).toEqual([-18, 18]);
  });

  it('keeps one straight and bows the other two for three links', () => {
    expect(parallelOffsets(3)).toEqual([0, -26, 26]);
  });

  it('returns the four-link ladder', () => {
    expect(parallelOffsets(4)).toEqual([-36, -12, 12, 36]);
  });

  it('distributes five links symmetrically with distinct offsets', () => {
    const offsets = parallelOffsets(5);
    expect(offsets).toHaveLength(5);
    expect(new Set(offsets).size).toBe(5);
    expect(offsets.reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(offsets[0]).toBeLessThan(0);
    expect(offsets[offsets.length - 1]).toBeGreaterThan(0);
  });

  it('caps the spacing for very dense groups', () => {
    const offsets = parallelOffsets(12);
    expect(offsets).toHaveLength(12);
    const span = Math.max(...offsets) - Math.min(...offsets);
    expect(span).toBeLessThanOrEqual(24 * 11);
  });
});

describe('computeParallelLinkLayouts', () => {
  it('keeps a single link at offset zero', () => {
    const layouts = computeParallelLinkLayouts([input('l1', 'A', 'B')]);
    expect(layouts.get('l1')).toEqual({ siblingCount: 1, siblingIndex: 0, offset: 0 });
  });

  it('separates two same-direction siblings symmetrically', () => {
    const layouts = computeParallelLinkLayouts([input('l1', 'A', 'B'), input('l2', 'A', 'B')]);
    expect(layouts.get('l1')?.siblingCount).toBe(2);
    expect(layouts.get('l2')?.siblingCount).toBe(2);
    expect([layouts.get('l1')?.offset, layouts.get('l2')?.offset]).toEqual([-18, 18]);
  });

  it('keeps reversed siblings on opposite sides of the shared axis', () => {
    const layouts = computeParallelLinkLayouts([input('l1', 'A', 'B'), input('l2', 'B', 'A')]);
    // Both offsets land on opposite world-space sides because the second link
    // is stored in reverse canonical order and therefore flips its normal.
    expect(layouts.get('l1')?.offset).toBe(-18);
    expect(layouts.get('l2')?.offset).toBe(-18);
  });

  it('assigns three links as one straight plus two bowed', () => {
    const layouts = computeParallelLinkLayouts([
      input('l1', 'A', 'B'),
      input('l2', 'A', 'B'),
      input('l3', 'B', 'A'),
    ]);
    // Canonical order is l1, l2, l3 → world offsets [0, -26, +26].
    // l1 (forward): 0; l2 (forward): -26; l3 (reversed): -26 (flipped).
    expect(layouts.get('l1')?.offset).toBe(0);
    expect(layouts.get('l2')?.offset).toBe(-26);
    expect(layouts.get('l3')?.offset).toBe(-26);
  });

  it('separates four links with the expected ladder', () => {
    const layouts = computeParallelLinkLayouts([
      input('l1', 'A', 'B'),
      input('l2', 'A', 'B'),
      input('l3', 'A', 'B'),
      input('l4', 'A', 'B'),
    ]);
    expect([...layouts.values()].map((layout) => layout.offset)).toEqual([-36, -12, 12, 36]);
  });

  it('does not auto-offset MANUAL links but keeps them in the group', () => {
    const layouts = computeParallelLinkLayouts([
      input('l1', 'A', 'B'),
      input('l2', 'A', 'B', 'MANUAL'),
      input('l3', 'A', 'B'),
    ]);
    expect(layouts.get('l1')?.siblingCount).toBe(3);
    expect(layouts.get('l2')?.offset).toBe(0);
    expect(layouts.get('l1')?.offset).toBe(0);
    expect(layouts.get('l3')?.offset).toBe(26);
  });

  it('is stable across identical inputs', () => {
    const links = [
      input('l1', 'A', 'B'),
      input('l2', 'B', 'A'),
      input('l3', 'A', 'B'),
    ];
    const first = computeParallelLinkLayouts(links);
    const second = computeParallelLinkLayouts(links);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });
});
