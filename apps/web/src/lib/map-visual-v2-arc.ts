/**
 * MAP-VISUAL-V2 — Fase E: comprimento de arco e corte da Bézier.
 *
 * O WeatherMap moderno precisa dividir a curva pelo COMPRIMENTO percorrido
 * (não pela média de X/Y): cada metade recebe exatamente 50% do trajeto e as
 * setas saem da tangente LOCAL do ponto de corte. Este módulo é 100% puro
 * (sem React, sem DOM, sem `getTotalLength`) para poder ser testado e para não
 * medir o SVG a cada frame em 31 enlaces reais.
 *
 * Tabela de arco: amostragem uniforme em `t` com distância acumulada; a busca
 * por comprimento é binária e o resultado é interpolado dentro do segmento, o
 * que mantém o erro abaixo de ~0.5% mesmo com 48 amostras.
 */

import {
  cubicPointAt,
  cubicTangentAt,
  normalizeAngleDeg,
  type BezierGeometry,
  type Point,
} from './map-visual-v2-geometry';

/** Amostras por curva: erro de comprimento desprezível e custo baixo. */
export const ARC_SAMPLES_DEFAULT = 48;

export interface ArcTable {
  /** Comprimento acumulado até t = i / samples (índice 0 = 0). */
  readonly cumulative: readonly number[];
  readonly total: number;
  readonly samples: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function buildArcTable(
  geometry: BezierGeometry,
  samples: number = ARC_SAMPLES_DEFAULT,
): ArcTable {
  const steps = Math.max(4, Math.round(samples));
  const cumulative: number[] = [0];
  let previous = cubicPointAt(geometry.p0, geometry.p1, geometry.p2, geometry.p3, 0);
  for (let index = 1; index <= steps; index += 1) {
    const point = cubicPointAt(geometry.p0, geometry.p1, geometry.p2, geometry.p3, index / steps);
    cumulative.push((cumulative[index - 1] ?? 0) + distance(previous, point));
    previous = point;
  }
  return { cumulative, total: cumulative[steps] ?? 0, samples: steps };
}

/** `t` correspondente a um comprimento percorrido (interpolado). */
export function paramAtLength(table: ArcTable, target: number): number {
  if (!Number.isFinite(target) || target <= 0) return 0;
  if (target >= table.total) return 1;
  const cumulative = table.cumulative;
  let low = 0;
  let high = cumulative.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((cumulative[middle] ?? 0) <= target) low = middle;
    else high = middle;
  }
  const before = cumulative[low] ?? 0;
  const after = cumulative[low + 1] ?? before;
  const span = after - before;
  const ratio = span > 0 ? (target - before) / span : 0;
  return (low + ratio) / table.samples;
}

/** Comprimento percorrido no parâmetro `t` (interpolado). */
export function lengthAtParam(table: ArcTable, t: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t >= 1) return table.total;
  const scaled = t * table.samples;
  const index = Math.floor(scaled);
  const ratio = scaled - index;
  const before = table.cumulative[index] ?? 0;
  const after = table.cumulative[index + 1] ?? before;
  return before + (after - before) * ratio;
}

export function pointAtPathLength(
  geometry: BezierGeometry,
  table: ArcTable,
  length: number,
): Point {
  const t = paramAtLength(table, length);
  return cubicPointAt(geometry.p0, geometry.p1, geometry.p2, geometry.p3, t);
}

/** Ângulo da tangente local (graus) no comprimento informado. */
export function angleAtPathLength(
  geometry: BezierGeometry,
  table: ArcTable,
  length: number,
): number {
  const t = paramAtLength(table, length);
  const tangent = cubicTangentAt(geometry.p0, geometry.p1, geometry.p2, geometry.p3, t);
  return normalizeAngleDeg((Math.atan2(tangent.y, tangent.x) * 180) / Math.PI);
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function pathOf(p0: Point, p1: Point, p2: Point, p3: Point): BezierGeometry {
  return {
    path: `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`,
    p0,
    p1,
    p2,
    p3,
  };
}

/** Corte exato da cúbica em `t` (de Casteljau): as duas metades formam a mesma curva. */
export function splitCubicAt(geometry: BezierGeometry, t: number): [BezierGeometry, BezierGeometry] {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
  const { p0, p1, p2, p3 } = geometry;
  const p01 = lerp(p0, p1, clamped);
  const p12 = lerp(p1, p2, clamped);
  const p23 = lerp(p2, p3, clamped);
  const p012 = lerp(p01, p12, clamped);
  const p123 = lerp(p12, p23, clamped);
  const middle = lerp(p012, p123, clamped);
  return [pathOf(p0, p01, p012, middle), pathOf(middle, p123, p23, p3)];
}

export interface SplitGeometry {
  /** Metade inicial do caminho (ponta A → centro). */
  first: BezierGeometry;
  /** Metade final do caminho (centro → ponta B). */
  second: BezierGeometry;
  /** Parâmetro do corte (o mesmo usado nas duas metades). */
  param: number;
  firstLength: number;
  secondLength: number;
  /** Comprimento total da curva original. */
  total: number;
}

/**
 * Divide a curva em `fraction` do COMPRIMENTO percorrido (padrão 50%).
 * O ponto de encontro fica exatamente na metade do trajeto.
 */
export function splitGeometryAtLength(
  geometry: BezierGeometry,
  table: ArcTable,
  fraction = 0.5,
): SplitGeometry {
  const safeFraction = Math.min(0.95, Math.max(0.05, Number.isFinite(fraction) ? fraction : 0.5));
  const target = table.total * safeFraction;
  const param = paramAtLength(table, target);
  const [first, second] = splitCubicAt(geometry, param);
  return {
    first,
    second,
    param,
    firstLength: lengthAtParam(table, param),
    secondLength: table.total - lengthAtParam(table, param),
    total: table.total,
  };
}

export interface HalfArrowPlacement {
  x: number;
  y: number;
  angleDeg: number;
}

/**
 * Seta de uma metade apontando SEMPRE para o centro do enlace.
 *
 * `first` percorre a curva no sentido A→B, então a seta usa a tangente direta.
 * `second` percorre no sentido B→A (contra a parametrização), então a seta gira
 * 180°: as duas convergem para o ponto de corte em qualquer orientação
 * (horizontal, vertical, diagonal ou curva).
 */
export function halfArrowPlacement(
  geometry: BezierGeometry,
  table: ArcTable,
  split: SplitGeometry,
  half: 'first' | 'second',
  fractionWithinHalf = 0.72,
): HalfArrowPlacement {
  const fraction = Math.min(0.98, Math.max(0.05, fractionWithinHalf));
  const along = half === 'first' ? split.firstLength * fraction : split.total - split.secondLength * fraction;
  const point = pointAtPathLength(geometry, table, along);
  const angle = angleAtPathLength(geometry, table, along);
  return {
    x: point.x,
    y: point.y,
    angleDeg: normalizeAngleDeg(half === 'second' ? angle + 180 : angle),
  };
}

/** Ponto de ancoragem de um rótulo da metade (fração do próprio arco). */
export function halfAnchorPoint(
  geometry: BezierGeometry,
  table: ArcTable,
  split: SplitGeometry,
  half: 'first' | 'second',
  fractionWithinHalf = 0.5,
): Point {
  const fraction = Math.min(0.98, Math.max(0.02, fractionWithinHalf));
  const along =
    half === 'first'
      ? split.firstLength * fraction
      : split.total - split.secondLength * fraction;
  return pointAtPathLength(geometry, table, along);
}
