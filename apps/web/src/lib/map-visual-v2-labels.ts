/**
 * MAP-VISUAL-V2 — anticolisão determinística dos rótulos de enlace (Fase B).
 *
 * Versão do laboratório: roda sobre os dados mock, sem persistir nada e sem
 * tocar offsets manuais. Dado o mesmo conjunto de entradas, o resultado é
 * SEMPRE o mesmo (ordenação por prioridade e id), o que mantém as capturas
 * reproduzíveis.
 *
 * Estratégias (na ordem): deslocamento perpendicular da pílula → formato
 * compacto (só percentual) → ocultação de rótulos secundários. Seleção, DOWN e
 * alarme nunca são ocultados: no pior caso ficam compactos fora dos nós.
 */

import type { Point } from './map-visual-v2-geometry';

export interface LinkV2LabelCandidate {
  id: string;
  /** Ponto de ancoragem na curva (unidades de fluxo). */
  anchor: Point;
  /** Normal unitária do enlace — direção do deslocamento. */
  normal: Point;
  /** Deslocamento base (irmãos paralelos já separados). */
  laneOffset: number;
  /** 3 = selecionado, 2 = DOWN/alarme, 1 = informativo, 0 = saudável. */
  priority: number;
  /** Texto completo ("25G · 62% · parcial"). */
  text: string;
  /** Texto compacto ("62%"). */
  compactText: string;
}

export interface LinkV2NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LinkV2LabelPlacement {
  mode: 'full' | 'compact' | 'hidden';
  /** Deslocamento final aplicado à âncora (unidades de fluxo). */
  dx: number;
  dy: number;
}

export const LINK_V2_LABEL_KEEP_PRIORITY = 2;
export const LINK_V2_LABEL_HEIGHT = 20;
export const LINK_V2_LABEL_EXTRA_OFFSETS = [18, -18, 36, -36, 56, -56];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectFor(
  anchor: Point,
  normal: Point,
  offset: number,
  width: number,
  scale: number,
): Rect {
  const cx = anchor.x + normal.x * offset;
  const cy = anchor.y + normal.y * offset;
  const height = LINK_V2_LABEL_HEIGHT * scale;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** Largura estimada da pílula — suficiente para a anticolisão, sem medir fonte. */
export function estimateLabelWidth(text: string, fontSize = 11): number {
  return Math.round(text.length * fontSize * 0.62) + 18;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function collides(rect: Rect, obstacles: readonly Rect[]): boolean {
  return obstacles.some((obstacle) => overlaps(rect, obstacle));
}

function expand(rect: LinkV2NodeRect, margin: number): Rect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

/**
 * Resolve posição e formato de cada rótulo.
 *
 * `nodeRects` são as caixas dos nós (a pílula nunca cobre ícone, nome ou
 * badge de alarme). O resultado é o mapa id → colocação.
 */
export function resolveLinkV2LabelPlacements(
  candidates: readonly LinkV2LabelCandidate[],
  nodeRects: readonly LinkV2NodeRect[],
  options: { margin?: number; extraOffsets?: readonly number[]; scale?: number } = {},
): Map<string, LinkV2LabelPlacement> {
  const margin = options.margin ?? 6;
  const extraOffsets = options.extraOffsets ?? LINK_V2_LABEL_EXTRA_OFFSETS;
  /**
   * Rótulos têm tamanho praticamente constante na TELA, mas as contas rodam em
   * unidades de fluxo: com zoom < 1, cada px de tela vale mais unidades de
   * fluxo. `scale = 1/zoom` mantém a checagem fiel ao que o operador vê.
   */
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const obstacles = nodeRects.map((rect) => expand(rect, margin));
  const sorted = [...candidates].sort((a, b) =>
    b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const placedRects: Rect[] = [];
  const result = new Map<string, LinkV2LabelPlacement>();

  for (const candidate of sorted) {
    const fullWidth = estimateLabelWidth(candidate.text) * scale;
    const compactWidth = estimateLabelWidth(candidate.compactText) * scale;
    const offsets = [
      candidate.laneOffset,
      ...extraOffsets.map((extra) => candidate.laneOffset + extra * scale),
    ];

    let placement: LinkV2LabelPlacement | null = null;

    for (const offset of offsets) {
      const rect = rectFor(candidate.anchor, candidate.normal, offset, fullWidth, scale);
      if (!collides(rect, obstacles) && !collides(rect, placedRects)) {
        placement = { mode: 'full', dx: candidate.normal.x * offset, dy: candidate.normal.y * offset };
        placedRects.push(rect);
        break;
      }
    }

    if (!placement) {
      for (const offset of offsets) {
        const rect = rectFor(candidate.anchor, candidate.normal, offset, compactWidth, scale);
        if (!collides(rect, obstacles) && !collides(rect, placedRects)) {
          placement = {
            mode: 'compact',
            dx: candidate.normal.x * offset,
            dy: candidate.normal.y * offset,
          };
          placedRects.push(rect);
          break;
        }
      }
    }

    if (!placement && candidate.priority >= LINK_V2_LABEL_KEEP_PRIORITY) {
      // Prioridade não é ocultada: fica compacta no primeiro deslocamento que
      // não cobre um nó (mesmo que outro rótulo já ocupe o lugar).
      const offset =
        offsets.find(
          (value) =>
            !collides(
              rectFor(candidate.anchor, candidate.normal, value, compactWidth, scale),
              obstacles,
            ),
        ) ?? candidate.laneOffset;
      placement = {
        mode: 'compact',
        dx: candidate.normal.x * offset,
        dy: candidate.normal.y * offset,
      };
      placedRects.push(rectFor(candidate.anchor, candidate.normal, offset, compactWidth, scale));
    }

    result.set(
      candidate.id,
      placement ?? { mode: 'hidden', dx: candidate.normal.x * candidate.laneOffset, dy: candidate.normal.y * candidate.laneOffset },
    );
  }

  return result;
}
