/**
 * MAP-VISUAL-V2 — anticolisão determinística dos rótulos de enlace (Fase B).
 *
 * Versão do laboratório: roda sobre os dados mock, sem persistir nada e sem
 * tocar offsets manuais. Dado o mesmo conjunto de entradas, o resultado é
 * SEMPRE o mesmo (ordenação por prioridade e id), o que mantém as capturas
 * reproduzíveis.
 *
 * Estratégias (Fase L, nesta ordem): tamanho completo SOBRE a linha (deslizando
 * ao longo da curva) → mesmo valor com chrome menor sobre a linha → versão
 * compacta (valor com unidade, sem %) sobre a linha → deslocamento perpendicular
 * MÍNIMO → ocultação de rótulos secundários. Seleção, DOWN e alarme nunca são
 * ocultados: no pior caso ficam compactos fora dos nós.
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
  /** Texto compacto, ainda com unidade ("448 Mbps"). */
  compactText: string;
  /**
   * Fase J — direção TANGENTE (unitária) e orçamento de deslizamento em
   * unidades de fluxo. Deslizar a plaqueta AO LONGO do traço resolve conflitos
   * sem afastá-la da linha (evita "pílula flutuante" e preserva a associação
   * valor↔sentido). Opcional: quem não informa continua no comportamento antigo.
   */
  tangent?: Point;
  tangentBudget?: number;
}

export interface LinkV2NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Formatos da plaqueta na hierarquia de degradação da Fase L. */
export type LinkV2LabelMode = 'full' | 'small' | 'compact' | 'hidden';

export interface LinkV2LabelPlacement {
  mode: LinkV2LabelMode;
  /** Deslocamento final aplicado à âncora (unidades de fluxo). */
  dx: number;
  dy: number;
}

export const LINK_V2_LABEL_KEEP_PRIORITY = 2;
export const LINK_V2_LABEL_HEIGHT = 20;
/** Deslocamento perpendicular inicial da pílula, para não sentar no traço. */
export const LINK_V2_LABEL_LIFT = 14;
/** Último recurso: deslocamento de uma altura de rótulo (associação preservada). */
export const LINK_V2_LABEL_EXTRA_OFFSETS = [17, -17];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Retângulo da plaqueta para uma posição: deslocamento perpendicular (em
 * unidades de fluxo) + deslizamento opcional AO LONGO do traço (Fase J).
 */
function rectAt(
  anchor: Point,
  normal: Point,
  offset: number,
  width: number,
  scale: number,
  options: { height?: number; tangent?: Point | undefined; slide?: number } = {},
): Rect {
  const boxHeight = (options.height ?? LINK_V2_LABEL_HEIGHT) * scale;
  const slide = options.slide ?? 0;
  const slideX = options.tangent ? options.tangent.x * slide : 0;
  const slideY = options.tangent ? options.tangent.y * slide : 0;
  const cx = anchor.x + normal.x * offset + slideX;
  const cy = anchor.y + normal.y * offset + slideY;
  return { x: cx - width / 2, y: cy - boxHeight / 2, width, height: boxHeight };
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
 *
 * `fontSize`/`height` permitem declarar o tamanho REAL da pílula (Fase G: plaqueta
 * de tráfego pequena e embutida). `fontSizeSmall`/`heightSmall` e
 * `fontSizeCompact`/`heightCompact` descrevem as degradações da Fase L.
 *
 * HIERARQUIA (Fase L) — a plaqueta só sai de cima da linha em último caso:
 *   1. `full` sobre a linha, deslizando ao longo da curva;
 *   2. `small` (mesmo valor, chrome menor) sobre a linha;
 *   3. `compact` (valor com unidade, sem %) sobre a linha;
 *   4. deslocamento perpendicular MÍNIMO (≤ `extraOffsets`) com `compact`;
 *   5. rótulos de prioridade alta ainda podem ficar compactos fora do lugar
 *      canônico (nunca cobrindo nó) para não desaparecerem.
 */
export function resolveLinkV2LabelPlacements(
  candidates: readonly LinkV2LabelCandidate[],
  nodeRects: readonly LinkV2NodeRect[],
  options: {
    margin?: number;
    extraOffsets?: readonly number[];
    scale?: number;
    fontSize?: number;
    height?: number;
    fontSizeSmall?: number;
    heightSmall?: number;
    fontSizeCompact?: number;
    heightCompact?: number;
  } = {},
): Map<string, LinkV2LabelPlacement> {
  const margin = options.margin ?? 6;
  const extraOffsets = options.extraOffsets ?? LINK_V2_LABEL_EXTRA_OFFSETS;
  const fontSize = options.fontSize && options.fontSize > 0 ? options.fontSize : undefined;
  const fontSizeSmall =
    options.fontSizeSmall && options.fontSizeSmall > 0 ? options.fontSizeSmall : fontSize;
  const fontSizeCompact =
    options.fontSizeCompact && options.fontSizeCompact > 0 ? options.fontSizeCompact : fontSizeSmall;
  const labelHeight = options.height && options.height > 0 ? options.height : LINK_V2_LABEL_HEIGHT;
  const labelHeightSmall =
    options.heightSmall && options.heightSmall > 0 ? options.heightSmall : labelHeight;
  const labelHeightCompact =
    options.heightCompact && options.heightCompact > 0 ? options.heightCompact : labelHeightSmall;
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
    const widthAt = (text: string, size: number | undefined) =>
      estimateLabelWidth(text, size) * scale;
    const full = { mode: 'full' as const, text: candidate.text, width: widthAt(candidate.text, fontSize), height: labelHeight };
    const small = {
      mode: 'small' as const,
      text: candidate.text,
      width: widthAt(candidate.text, fontSizeSmall),
      height: labelHeightSmall,
    };
    const compact = {
      mode: 'compact' as const,
      text: candidate.compactText,
      width: widthAt(candidate.compactText, fontSizeCompact),
      height: labelHeightCompact,
    };
    const sizes = [full, small, compact];
    /** Deslocamentos: a linha (lane) primeiro; fora dela só o mínimo necessário. */
    const offsets = [
      candidate.laneOffset,
      ...extraOffsets.map((extra) => candidate.laneOffset + extra * scale),
    ];
    /**
     * Fase J/L: antes de sair da linha, a plaqueta desliza AO LONGO do traço.
     * A escadinha é fina de propósito (20/35/50/70/85/100/115% do orçamento):
     * quanto mais posições sobre a curva, menos degradação de tamanho e menos
     * deslocamento perpendicular — a plaqueta continua lendo como parte do
     * enlace. A ordem é determinística, sempre partindo do meio da metade.
     */
    const budget = candidate.tangent && (candidate.tangentBudget ?? 0) > 0 ? candidate.tangentBudget! : 0;
    const slides =
      budget > 0
        ? [
            0, -0.2, 0.2, -0.35, 0.35, -0.5, 0.5, -0.7, 0.7, -0.85, 0.85, -1, 1, -1.15, 1.15, -1.3,
            1.3, -1.5, 1.5,
          ].map((f) => f * budget)
        : [0];
    const rectOf = (offset: number, width: number, height: number, slide: number) =>
      rectAt(candidate.anchor, candidate.normal, offset, width, scale, {
        height,
        tangent: candidate.tangent,
        slide,
      });
    const placementAt = (mode: LinkV2LabelMode, offset: number, slide: number) => ({
      mode,
      dx: candidate.normal.x * offset + (candidate.tangent?.x ?? 0) * slide,
      dy: candidate.normal.y * offset + (candidate.tangent?.y ?? 0) * slide,
    });

    let placement: LinkV2LabelPlacement | null = null;

    // 1..3) Tamanhos, na ordem, sempre SOBRE a linha (offset de lane).
    for (const size of sizes) {
      for (const slide of slides) {
        const rect = rectOf(candidate.laneOffset, size.width, size.height, slide);
        if (!collides(rect, obstacles) && !collides(rect, placedRects)) {
          placement = placementAt(size.mode, candidate.laneOffset, slide);
          placedRects.push(rect);
          break;
        }
      }
      if (placement) break;
    }

    // 4) Só então o deslocamento perpendicular mínimo (valor com unidade).
    if (!placement) {
      for (const offset of offsets.slice(1)) {
        for (const slide of slides) {
          const rect = rectOf(offset, compact.width, compact.height, slide);
          if (!collides(rect, obstacles) && !collides(rect, placedRects)) {
            placement = placementAt('compact', offset, slide);
            placedRects.push(rect);
            break;
          }
        }
        if (placement) break;
      }
    }

    if (!placement && candidate.priority >= LINK_V2_LABEL_KEEP_PRIORITY) {
      // Prioridade não é ocultada: fica compacta na primeira posição que não
      // cobre um nó (mesmo que outro rótulo já ocupe o lugar).
      let found: { offset: number; slide: number } | null = null;
      for (const offset of offsets) {
        const slide = slides.find(
          (value) => !collides(rectOf(offset, compact.width, compact.height, value), obstacles),
        );
        if (slide !== undefined) {
          found = { offset, slide };
          break;
        }
      }
      const { offset, slide } = found ?? { offset: candidate.laneOffset, slide: 0 };
      placement = placementAt('compact', offset, slide);
      placedRects.push(rectOf(offset, compact.width, compact.height, slide));
    }

    result.set(
      candidate.id,
      placement ?? {
        mode: 'hidden',
        dx: candidate.normal.x * candidate.laneOffset,
        dy: candidate.normal.y * candidate.laneOffset,
      },
    );
  }

  return result;
}
