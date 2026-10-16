/**
 * Fase E — corte da curva e setas convergentes.
 *
 * O ponto crítico é que a divisão usa o COMPRIMENTO do trajeto (não a média de
 * X/Y) e que as duas setas apontam para o centro em qualquer orientação.
 */

import { describe, expect, it } from 'vitest';
import { buildBezierGeometry, cubicPointAt, type BezierGeometry } from './map-visual-v2-geometry';
import {
  angleAtPathLength,
  buildArcTable,
  halfAnchorPoint,
  halfArrowPlacement,
  lengthAtParam,
  paramAtLength,
  pointAtPathLength,
  splitCubicAt,
  splitGeometryAtLength,
} from './map-visual-v2-arc';

/** Cúbica realmente reta (controles a 1/3 e 2/3 do segmento). */
function straight(x1: number, y1: number, x2: number, y2: number): BezierGeometry {
  return {
    path: `M${x1},${y1} C${x1 + (x2 - x1) / 3},${y1 + (y2 - y1) / 3} ${x1 + (2 * (x2 - x1)) / 3},${y1 + (2 * (y2 - y1)) / 3} ${x2},${y2}`,
    p0: { x: x1, y: y1 },
    p1: { x: x1 + (x2 - x1) / 3, y: y1 + (y2 - y1) / 3 },
    p2: { x: x1 + (2 * (x2 - x1)) / 3, y: y1 + (2 * (y2 - y1)) / 3 },
    p3: { x: x2, y: y2 },
  };
}

function line(x1: number, y1: number, x2: number, y2: number): BezierGeometry {
  return buildBezierGeometry({
    sourceX: x1,
    sourceY: y1,
    sourcePosition: 'right',
    targetX: x2,
    targetY: y2,
    targetPosition: 'left',
    curvature: 0,
    offset: 0,
  });
}

/** Curva assimétrica: controle não proporcional, t=0.5 bem longe do meio do arco. */
const asymmetric: BezierGeometry = {
  path: 'M0,0 C320,0 40,120 200,200',
  p0: { x: 0, y: 0 },
  p1: { x: 320, y: 0 },
  p2: { x: 40, y: 120 },
  p3: { x: 200, y: 200 },
};

describe('comprimento de arco', () => {
  it('mede uma reta com erro desprezível', () => {
    const geometry = straight(0, 0, 300, 400); // 500 de comprimento
    const table = buildArcTable(geometry, 64);
    expect(table.total).toBeGreaterThan(499);
    expect(table.total).toBeLessThan(500.5);
  });

  it('converte comprimento ↔ parâmetro nas duas direções', () => {
    const geometry = line(0, 0, 400, 0);
    const table = buildArcTable(geometry, 64);
    expect(paramAtLength(table, 200)).toBeCloseTo(0.5, 2);
    expect(lengthAtParam(table, 0.5)).toBeCloseTo(200, 1);
    const point = pointAtPathLength(geometry, table, 200);
    expect(point.x).toBeCloseTo(200, 1);
    expect(point.y).toBeCloseTo(0, 1);
  });

  it('divide pela METADE DO TRAJETO, não pela média de X/Y', () => {
    const table = buildArcTable(asymmetric, 64);
    const split = splitGeometryAtLength(asymmetric, table, 0.5);
    // Metade exata do comprimento (tolerância de 1%).
    expect(split.firstLength).toBeCloseTo(table.total / 2, -Math.log10(table.total * 0.01));
    // E o parâmetro do corte NÃO é 0.5 nessa curva assimétrica.
    expect(split.param).not.toBeCloseTo(0.5, 2);
  });

  it('as duas metades reconstroem a curva original', () => {
    const table = buildArcTable(asymmetric, 96);
    const split = splitGeometryAtLength(asymmetric, table, 0.5);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const original = cubicPointAt(asymmetric.p0, asymmetric.p1, asymmetric.p2, asymmetric.p3, t);
      const mapped =
        t <= split.param
          ? cubicPointAt(split.first.p0, split.first.p1, split.first.p2, split.first.p3, t / split.param)
          : cubicPointAt(
              split.second.p0,
              split.second.p1,
              split.second.p2,
              split.second.p3,
              (t - split.param) / (1 - split.param),
            );
      expect(mapped.x).toBeCloseTo(original.x, 6);
      expect(mapped.y).toBeCloseTo(original.y, 6);
    }
  });

  it('o corte fecha exatamente no ponto médio do arco', () => {
    const table = buildArcTable(asymmetric, 96);
    const split = splitGeometryAtLength(asymmetric, table, 0.5);
    const middleByArc = pointAtPathLength(asymmetric, table, table.total / 2);
    expect(split.first.p3.x).toBeCloseTo(middleByArc.x, 6);
    expect(split.first.p3.y).toBeCloseTo(middleByArc.y, 6);
    // A segunda metade começa no mesmo ponto.
    expect(split.second.p0.x).toBeCloseTo(middleByArc.x, 6);
    expect(split.second.p0.y).toBeCloseTo(middleByArc.y, 6);
  });

  it('splitCubicAt é seguro nos extremos', () => {
    const [a, b] = splitCubicAt(asymmetric, 0);
    expect(a.p3.x).toBeCloseTo(asymmetric.p0.x, 6);
    expect(b.p0.x).toBeCloseTo(asymmetric.p0.x, 6);
    const [c] = splitCubicAt(asymmetric, 1);
    expect(c.p3.x).toBeCloseTo(asymmetric.p3.x, 6);
  });
});

/** Vetor unitário do ângulo (em graus, eixo Y do SVG para baixo). */
function direction(angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

describe('setas convergentes', () => {
  const cases: Array<[string, BezierGeometry]> = [
    ['horizontal', line(0, 0, 400, 0)],
    ['vertical', line(0, 0, 0, 400)],
    ['diagonal', line(0, 0, 300, 300)],
    ['diagonal inversa', line(300, 0, 0, 300)],
    ['curva', asymmetric],
  ];

  for (const [name, geometry] of cases) {
    it(`as duas metades apontam para o centro em enlace ${name}`, () => {
      const table = buildArcTable(geometry, 64);
      const split = splitGeometryAtLength(geometry, table, 0.5);
      const center = pointAtPathLength(geometry, table, table.total / 2);
      for (const half of ['first', 'second'] as const) {
        const arrow = halfArrowPlacement(geometry, table, split, half, 0.72);
        const toCenter = { x: center.x - arrow.x, y: center.y - arrow.y };
        const heading = direction(arrow.angleDeg);
        const dot = heading.x * toCenter.x + heading.y * toCenter.y;
        // Produto escalar positivo = a seta aponta para o centro.
        expect(dot).toBeGreaterThan(0);
        // E está bem alinhada (cos > 0.8).
        const cos = dot / (Math.hypot(toCenter.x, toCenter.y) || 1);
        expect(cos).toBeGreaterThan(0.8);
      }
    });
  }

  it('em reta horizontal: A→B aponta para a direita e B→A para a esquerda', () => {
    const geometry = line(0, 0, 400, 0);
    const table = buildArcTable(geometry, 64);
    const split = splitGeometryAtLength(geometry, table, 0.5);
    expect(halfArrowPlacement(geometry, table, split, 'first').angleDeg).toBeCloseTo(0, 1);
    expect(Math.abs(halfArrowPlacement(geometry, table, split, 'second').angleDeg)).toBeCloseTo(180, 1);
  });

  it('em reta vertical: as setas apontam para baixo e para cima', () => {
    const geometry = line(0, 0, 0, 400);
    const table = buildArcTable(geometry, 64);
    const split = splitGeometryAtLength(geometry, table, 0.5);
    expect(halfArrowPlacement(geometry, table, split, 'first').angleDeg).toBeCloseTo(90, 1);
    expect(halfArrowPlacement(geometry, table, split, 'second').angleDeg).toBeCloseTo(-90, 1);
  });

  it('a seta usa a tangente LOCAL (curva ≠ reta entre as pontas)', () => {
    const table = buildArcTable(asymmetric, 64);
    const split = splitGeometryAtLength(asymmetric, table, 0.5);
    const arrow = halfArrowPlacement(asymmetric, table, split, 'first', 0.72);
    const straight = (Math.atan2(asymmetric.p3.y - asymmetric.p0.y, asymmetric.p3.x - asymmetric.p0.x) * 180) / Math.PI;
    expect(Math.abs(arrow.angleDeg - straight)).toBeGreaterThan(5);
    // E a tangente no ponto bate com o ângulo reportado.
    const along = split.firstLength * 0.72;
    expect(angleAtPathLength(asymmetric, table, along)).toBeCloseTo(arrow.angleDeg, 4);
  });

  it('as setas ficam próximas do centro, sem se sobrepor', () => {
    const geometry = line(0, 0, 400, 0);
    const table = buildArcTable(geometry, 64);
    const split = splitGeometryAtLength(geometry, table, 0.5);
    const first = halfArrowPlacement(geometry, table, split, 'first', 0.72);
    const second = halfArrowPlacement(geometry, table, split, 'second', 0.72);
    const center = pointAtPathLength(geometry, table, table.total / 2);
    expect(first.x).toBeLessThan(center.x);
    expect(second.x).toBeGreaterThan(center.x);
    expect(second.x - first.x).toBeGreaterThan(1);
  });

  it('em enlace curto as setas continuam dentro do traçado', () => {
    const geometry = line(0, 0, 60, 0);
    const table = buildArcTable(geometry, 32);
    const split = splitGeometryAtLength(geometry, table, 0.5);
    for (const half of ['first', 'second'] as const) {
      const arrow = halfArrowPlacement(geometry, table, split, half, 0.9);
      expect(arrow.x).toBeGreaterThanOrEqual(-0.001);
      expect(arrow.x).toBeLessThanOrEqual(60.001);
    }
  });
});

describe('âncora do rótulo por metade', () => {
  it('fica no meio de cada metade (1/4 e 3/4 do trajeto)', () => {
    const geometry = line(0, 0, 400, 0);
    const table = buildArcTable(geometry, 64);
    const split = splitGeometryAtLength(geometry, table, 0.5);
    const a = halfAnchorPoint(geometry, table, split, 'first', 0.5);
    const b = halfAnchorPoint(geometry, table, split, 'second', 0.5);
    expect(a.x).toBeCloseTo(100, 1);
    expect(b.x).toBeCloseTo(300, 1);
  });

  it('nunca sai do próprio traçado mesmo com fração extrema', () => {
    const geometry = line(0, 0, 400, 0);
    const table = buildArcTable(geometry, 64);
    const split = splitGeometryAtLength(geometry, table, 0.5);
    const a = halfAnchorPoint(geometry, table, split, 'first', 0.01);
    const b = halfAnchorPoint(geometry, table, split, 'second', 1);
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(b.x).toBeLessThanOrEqual(400.001);
  });
});
