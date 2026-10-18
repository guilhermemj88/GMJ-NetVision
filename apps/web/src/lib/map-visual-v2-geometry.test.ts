import { describe, expect, it } from 'vitest';
import {
  arrowPlacement,
  buildBezierGeometry,
  cubicPointAt,
  cubicTangentAngleDeg,
  normalizeAngleDeg,
  perpendicularOf,
  pointOnBezier,
} from './map-visual-v2-geometry';

describe('geometria Bézier do enlace V2', () => {
  it('mantém o path da V1 para um enlace reto horizontal', () => {
    const geometry = buildBezierGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: 'right',
      targetX: 100,
      targetY: 0,
      targetPosition: 'left',
      curvature: 0.24,
      offset: 0,
    });
    expect(geometry.path).toBe('M0,0 C50,0 50,0 100,0');
  });

  it('aplica o offset perpendicular nos dois pontos de controle', () => {
    const geometry = buildBezierGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: 'right',
      targetX: 100,
      targetY: 0,
      targetPosition: 'left',
      curvature: 0.24,
      offset: 20,
    });
    expect(geometry.path).toBe('M0,0 C50,20 50,20 100,0');
    // Mesmo peso 0.75 no meio da curva usado pela V1 (PATH_OFFSET_SCALE * 3/4).
    expect(pointOnBezier(geometry, 0.5)).toEqual({ x: 50, y: 15 });
  });

  it('ponto e tangente em curva explícita', () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 0, y: 50 };
    const p2 = { x: 100, y: 50 };
    const p3 = { x: 100, y: 100 };
    expect(cubicPointAt(p0, p1, p2, p3, 0)).toEqual(p0);
    expect(cubicPointAt(p0, p1, p2, p3, 1)).toEqual(p3);
    expect(cubicPointAt(p0, p1, p2, p3, 0.5)).toEqual({ x: 50, y: 50 });
    // Tangente (150, 75) → atan(0.5) = 26.565°.
    expect(cubicTangentAngleDeg(p0, p1, p2, p3, 0.5)).toBeCloseTo(26.565, 3);
  });

  it('tangente cobre retas horizontal, vertical e diagonal', () => {
    const horizontal = {
      p0: { x: 0, y: 0 },
      p1: { x: 33, y: 0 },
      p2: { x: 66, y: 0 },
      p3: { x: 100, y: 0 },
    };
    expect(cubicTangentAngleDeg(horizontal.p0, horizontal.p1, horizontal.p2, horizontal.p3, 0.5)).toBe(0);
    expect(
      cubicTangentAngleDeg({ x: 0, y: 0 }, { x: 0, y: 33 }, { x: 0, y: 66 }, { x: 0, y: 100 }, 0.5),
    ).toBe(90);
    expect(
      cubicTangentAngleDeg(
        { x: 0, y: 100 },
        { x: 33, y: 66 },
        { x: 66, y: 33 },
        { x: 100, y: 0 },
        0.5,
      ),
    ).toBe(-45);
  });

  it('normaliza ângulos para [-180, 180)', () => {
    expect(normalizeAngleDeg(0)).toBe(0);
    expect(normalizeAngleDeg(360)).toBe(0);
    expect(normalizeAngleDeg(270)).toBe(-90);
    expect(normalizeAngleDeg(540)).toBe(180);
    expect(normalizeAngleDeg(-270)).toBe(90);
  });

  it('a seta segue a tangente e inverte quando o sentido é B→A', () => {
    const geometry = buildBezierGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: 'right',
      targetX: 100,
      targetY: 0,
      targetPosition: 'left',
      curvature: 0.24,
      offset: 0,
    });
    const forward = arrowPlacement(geometry, 'a2b');
    const backward = arrowPlacement(geometry, 'b2a');
    expect(forward.angleDeg).toBe(0);
    expect(backward.angleDeg).toBe(180);
    expect(forward.x).toBeCloseTo(pointOnBezier(geometry, 0.55).x, 6);
    expect(forward.y).toBeCloseTo(0, 6);

    const vertical = buildBezierGeometry({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: 'bottom',
      targetX: 0,
      targetY: 100,
      targetPosition: 'top',
      curvature: 0.24,
      offset: 0,
    });
    expect(arrowPlacement(vertical, 'a2b').angleDeg).toBe(90);
    expect(arrowPlacement(vertical, 'b2a').angleDeg).toBe(-90);
  });

  it('arrow fica sobre o traço também em enlace curvo e invertido', () => {
    const geometry = buildBezierGeometry({
      sourceX: 100,
      sourceY: 100,
      sourcePosition: 'left',
      targetX: 0,
      targetY: 0,
      targetPosition: 'right',
      curvature: 0.24,
      offset: -12,
    });
    const placement = arrowPlacement(geometry, 'a2b', 0.55);
    const onCurve = pointOnBezier(geometry, 0.55);
    expect(placement.x).toBeCloseTo(onCurve.x, 6);
    expect(placement.y).toBeCloseTo(onCurve.y, 6);
    // Enlace invertido: a seta aponta para cima-esquerda e o inverso gira 180°.
    expect(placement.angleDeg).toBeLessThan(0);
    const flipped = arrowPlacement(geometry, 'b2a', 0.55);
    expect(normalizeAngleDeg(flipped.angleDeg - placement.angleDeg)).toBe(180);
  });

  it('perpendicular é unitária e independe da origem', () => {
    const geometry = buildBezierGeometry({
      sourceX: 10,
      sourceY: 20,
      sourcePosition: 'right',
      targetX: 110,
      targetY: 20,
      targetPosition: 'left',
      curvature: 0,
      offset: 0,
    });
    const normal = perpendicularOf(geometry);
    expect(normal.x).toBeCloseTo(0, 6);
    expect(normal.y).toBeCloseTo(1, 6);
    expect(Math.hypot(normal.x, normal.y)).toBeCloseTo(1, 6);
  });
});
