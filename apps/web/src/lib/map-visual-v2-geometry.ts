/**
 * MAP-VISUAL-V2 — geometria Bézier do enlace (Fase B).
 *
 * Mesma matemática de controle usada pela V1 (`traffic-edge.tsx`), extraída
 * para funções puras e testáveis: a curvatura persistida de um enlace produz a
 * MESMA curva nos dois renderers — o que muda no V2 é só o desenho da linha.
 *
 * Coordenadas em unidades de fluxo (as mesmas dos nós). Zero dependência de
 * React/React Flow.
 */

export type SidePosition = 'left' | 'right' | 'top' | 'bottom';

/**
 * Mesma curvatura base usada pelo renderer V1 (`EDGE_CURVATURE` em
 * traffic-edge.tsx): com o MESMO offset, V1 e V2 desenham a mesma curva.
 */
export const LINK_V2_EDGE_CURVATURE = 0.24;

export interface Point {
  x: number;
  y: number;
}

export interface BezierGeometry {
  /** Atributo `d` do path SVG. */
  path: string;
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

/** Fração padrão do caminho onde a seta de direção fica. */
export const LINK_V2_ARROW_T = 0.55;

function calculateControlOffset(distance: number, curvature: number): number {
  if (distance >= 0) return 0.5 * distance;
  return curvature * 25 * Math.sqrt(-distance);
}

function controlWithCurvature({
  pos,
  x1,
  y1,
  x2,
  y2,
  c,
}: {
  pos: SidePosition;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: number;
}): Point {
  switch (pos) {
    case 'left':
      return { x: x1 - calculateControlOffset(x1 - x2, c), y: y1 };
    case 'right':
      return { x: x1 + calculateControlOffset(x2 - x1, c), y: y1 };
    case 'top':
      return { x: x1, y: y1 - calculateControlOffset(y1 - y2, c) };
    case 'bottom':
      return { x: x1, y: y1 + calculateControlOffset(y2 - y1, c) };
  }
}

export function buildBezierGeometry({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  curvature,
  offset,
}: {
  sourceX: number;
  sourceY: number;
  sourcePosition: SidePosition;
  targetX: number;
  targetY: number;
  targetPosition: SidePosition;
  /** Curvatura (mesma semântica da V1: deslocamento perpendicular do miolo). */
  curvature: number;
  /** Deslocamento perpendicular adicional (irmãos paralelos / rota visual). */
  offset: number;
}): BezierGeometry {
  const sourceControl = controlWithCurvature({
    pos: sourcePosition,
    x1: sourceX,
    y1: sourceY,
    x2: targetX,
    y2: targetY,
    c: curvature,
  });
  const targetControl = controlWithCurvature({
    pos: targetPosition,
    x1: targetX,
    y1: targetY,
    x2: sourceX,
    y2: sourceY,
    c: curvature,
  });
  const deltaX = targetX - sourceX;
  const deltaY = targetY - sourceY;
  const length = Math.hypot(deltaX, deltaY) || 1;
  const normalX = -deltaY / length;
  const normalY = deltaX / length;

  const p0 = { x: sourceX, y: sourceY };
  const p1 = { x: sourceControl.x + normalX * offset, y: sourceControl.y + normalY * offset };
  const p2 = { x: targetControl.x + normalX * offset, y: targetControl.y + normalY * offset };
  const p3 = { x: targetX, y: targetY };

  return {
    path: `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`,
    p0,
    p1,
    p2,
    p3,
  };
}

export function cubicPointAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const u2 = u * u;
  const t2 = t * t;
  return {
    x: u2 * u * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t2 * t * p3.x,
    y: u2 * u * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t2 * t * p3.y,
  };
}

export function cubicTangentAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const x =
    3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
  const y =
    3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
  return { x, y };
}

/** Ângulo normalizado em [-180, 180). */
export function normalizeAngleDeg(angle: number): number {
  const wrapped = ((angle + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function cubicTangentAngleDeg(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): number {
  const tangent = cubicTangentAt(p0, p1, p2, p3, t);
  return normalizeAngleDeg((Math.atan2(tangent.y, tangent.x) * 180) / Math.PI);
}

export function pointOnBezier(geometry: BezierGeometry, t: number): Point {
  return cubicPointAt(geometry.p0, geometry.p1, geometry.p2, geometry.p3, t);
}

export interface ArrowPlacement {
  x: number;
  y: number;
  angleDeg: number;
}

/**
 * Posição e rotação da única seta do enlace, alinhada à tangente da curva.
 * `b2a` gira 180° sobre a mesma tangente — a seta continua "grudada" no traço.
 */
export function arrowPlacement(
  geometry: BezierGeometry,
  direction: 'a2b' | 'b2a',
  t: number = LINK_V2_ARROW_T,
): ArrowPlacement {
  const point = pointOnBezier(geometry, t);
  const angle = cubicTangentAngleDeg(geometry.p0, geometry.p1, geometry.p2, geometry.p3, t);
  return {
    x: point.x,
    y: point.y,
    angleDeg: normalizeAngleDeg(direction === 'b2a' ? angle + 180 : angle),
  };
}

/** Normal unitária do enlace (perpendicular ao vetor ponta A → ponta B). */
export function perpendicularOf(geometry: BezierGeometry): Point {
  const deltaX = geometry.p3.x - geometry.p0.x;
  const deltaY = geometry.p3.y - geometry.p0.y;
  const length = Math.hypot(deltaX, deltaY) || 1;
  return { x: -deltaY / length, y: deltaX / length };
}

/**
 * Tangente unitária do enlace (Fase J): direção em que a plaqueta pode deslizar
 * AO LONGO do traço sem sair da linha nem mudar a geometria desenhada.
 */
export function tangentOf(geometry: BezierGeometry): Point {
  const deltaX = geometry.p3.x - geometry.p0.x;
  const deltaY = geometry.p3.y - geometry.p0.y;
  const length = Math.hypot(deltaX, deltaY) || 1;
  return { x: deltaX / length, y: deltaY / length };
}
