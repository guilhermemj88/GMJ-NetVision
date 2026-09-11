import { describe, expect, it } from 'vitest';
import { computeParallelLinkLayouts, defaultVisualPaths } from '@gmj/shared';
import {
  draggedCurvature,
  manualLinkGeometry,
  resetLinkGeometry,
  PATH_OFFSET_SCALE,
  MAX_CURVATURE,
} from './link-curvature';

describe('link curvature geometry', () => {
  it('projects only onto the source-to-target normal with the cubic midpoint scale', () => {
    const source = { x: 0, y: 0 };
    const target = { x: 300, y: 0 };
    expect(draggedCurvature(0, source, { x: 80, y: 67.5 }, source, target)).toBeCloseTo(100);
    expect(draggedCurvature(0, source, { x: 80, y: -67.5 }, source, target)).toBeCloseTo(-100);
    expect(draggedCurvature(20, source, { x: 80, y: 0 }, source, target)).toBe(20);
  });

  it('handles reversed, vertical and diagonal links in their own normal space', () => {
    const origin = { x: 0, y: 0 };
    expect(draggedCurvature(0, origin, { x: 0, y: 67.5 }, { x: 300, y: 0 }, origin)).toBeCloseTo(
      -100,
    );
    expect(draggedCurvature(0, origin, { x: -67.5, y: 0 }, origin, { x: 0, y: 300 })).toBeCloseTo(
      100,
    );
    expect(
      draggedCurvature(0, origin, { x: -67.5 / Math.sqrt(2), y: 67.5 / Math.sqrt(2) }, origin, {
        x: 300,
        y: 300,
      }),
    ).toBeCloseTo(100);
  });

  it('bakes AUTO into all paths without changing their rendered offsets or metadata', () => {
    const visualPaths = defaultVisualPaths(3).map((path, index) => ({
      ...path,
      curvature: index * 30,
      enabled: index !== 1,
      label: `Path ${index}`,
      customColor: '#123456',
    }));
    const manual = manualLinkGeometry({ visualPaths, linkLayoutMode: 'AUTO' }, -18);
    expect(manual.linkLayoutMode).toBe('MANUAL');
    manual.visualPaths.forEach((path, index) => {
      expect(path.curvature * PATH_OFFSET_SCALE).toBeCloseTo(
        -18 + visualPaths[index]!.curvature * PATH_OFFSET_SCALE,
      );
      expect({ ...path, curvature: 0 }).toEqual({ ...visualPaths[index], curvature: 0 });
    });
    expect(manualLinkGeometry(manual, -18)).toEqual(manual);
  });

  it('resets curves and restores automatic sibling separation on request', () => {
    const link = {
      visualPaths: [{ ...defaultVisualPaths(1)[0]!, curvature: 300 }],
      linkLayoutMode: 'MANUAL' as const,
    };
    expect(resetLinkGeometry(link)).toMatchObject({
      linkLayoutMode: 'MANUAL',
      visualPaths: [{ curvature: 0 }],
    });
    const reset = resetLinkGeometry(link, true);
    const layouts = computeParallelLinkLayouts([
      { id: '1', sourceKey: 'A', targetKey: 'B', layoutMode: reset.linkLayoutMode },
      { id: '2', sourceKey: 'A', targetKey: 'B', layoutMode: 'AUTO' },
    ]);
    expect(reset.visualPaths[0]?.curvature).toBe(0);
    expect(layouts.get('1')?.offset).toBeLessThan(0);
    expect(layouts.get('2')?.offset).toBeGreaterThan(0);
  });

  it('clamps extreme drags and handles coincident endpoints or invalid input', () => {
    const origin = { x: 0, y: 0 };
    expect(draggedCurvature(0, origin, { x: 0, y: 1e9 }, origin, { x: 300, y: 0 })).toBe(
      MAX_CURVATURE,
    );
    expect(draggedCurvature(0, origin, { x: 0, y: -1e9 }, origin, { x: 300, y: 0 })).toBe(
      -MAX_CURVATURE,
    );
    expect(draggedCurvature(15, origin, { x: 0, y: 100 }, origin, origin)).toBe(15);
    expect(draggedCurvature(15, origin, { x: NaN, y: 100 }, origin, { x: 300, y: 0 })).toBe(15);
  });
});
