import type { ModularChassisMap } from './modular-chassis-map';
import type { PanelLayout, PlacedConnector } from './physical-panel-layout';
import type { PhysicalVisualMode } from './physical-types';

/**
 * Visão **TÉCNICA** (protótipo controlado).
 *
 * A visão técnica é apenas **outra camada de renderização**: não duplica modelo
 * de dados nem cria estrutura paralela. A verdade continua sendo
 * catálogo → panel layout / chassis map → slots → módulos → portas → conexões.
 *
 * Nesta primeira fase só os modelos abaixo trocam de desenho. Qualquer outro
 * equipamento permanece com o desenho REAL mesmo com o modo técnico ligado, de
 * propósito: o protótipo é controlado e não redesenha o projeto inteiro.
 */
export const TECHNICAL_RENDER_CATALOG_KEYS: readonly string[] = [
  'huawei-ne8000-f1a-8h20q',
  'huawei-s6730-h48x6c',
  'huawei-s6730-h48x6c-v2',
  'huawei-s6750-h48x8c',
  'huawei-s6750-h48y8c',
  'huawei-s6750-h48y8c-b',
  'huawei-ma5800-x7',
];

const TECHNICAL_KEYS = new Set(TECHNICAL_RENDER_CATALOG_KEYS);

/** Altura mínima de cada slot no chassi técnico (px) — legibilidade das placas. */
export const TECHNICAL_SLOT_MIN_HEIGHT = 64;

/** Altura de cada linha do painel técnico (px) — portas clicáveis e legíveis. */
export const TECHNICAL_ROW_HEIGHT = 19;

/** `true` somente para os modelos com desenho técnico nesta fase. */
export function hasTechnicalRenderer(catalogKey: string | null | undefined): boolean {
  return Boolean(catalogKey && TECHNICAL_KEYS.has(catalogKey));
}

/** Resolve se o equipamento deve usar o desenho técnico no modo atual. */
export function assetUsesTechnicalRenderer(
  catalogKey: string | null | undefined,
  mode: PhysicalVisualMode,
): boolean {
  return mode === 'TECHNICAL' && hasTechnicalRenderer(catalogKey);
}

/**
 * Chassi técnico: o mesmo mapa (a verdade de posição dos slots), sem a
 * fotografia. Sem `image` o painel modular desenha a moldura lógica e os slots
 * posicionados pelo bbox normalizado — os anchors continuam os mesmos.
 */
export function technicalChassisMap(map: ModularChassisMap): ModularChassisMap {
  const { image: _image, ...rest } = map;
  return rest;
}

/**
 * Altura visual do chassi técnico: espaça os slots para a placa caber legível,
 * respeitando a ocupação física (`heightU`) e o teto dos painéis por imagem.
 */
export function technicalChassisDisplayHeight(input: {
  slotCount: number;
  heightU: number;
  baseUnitHeight: number;
  chromePx: number;
  maxHeightPx: number;
}): number {
  const physical = Math.max(1, input.heightU) * input.baseUnitHeight;
  const slots = Math.max(1, input.slotCount);
  const desired = input.chromePx + slots * TECHNICAL_SLOT_MIN_HEIGHT;
  return Math.max(physical, Math.min(input.maxHeightPx, desired));
}

/**
 * Altura visual do painel técnico de um equipamento fixo.
 *
 * A grade é a mesma do catálogo; o que muda é o respiro por linha, para as
 * portas ficarem desenhadas (e clicáveis) em vez de comprimidas na altura
 * física. Nunca é menor que a ocupação física (`heightU`).
 */
export function technicalPanelDisplayHeight(input: {
  gridHeight: number;
  heightU: number;
  baseUnitHeight: number;
  chromePx: number;
  maxHeightPx: number;
}): number {
  const physical = Math.max(1, input.heightU) * input.baseUnitHeight;
  const desired = input.chromePx + Math.max(2.4, input.gridHeight) * TECHNICAL_ROW_HEIGHT;
  return Math.max(physical, Math.min(input.maxHeightPx, Math.round(desired)));
}

export interface TechnicalCaption {
  /** chave do grupo no layout (agrupamento visual) */
  key: string;
  /** rótulo legível, ex.: `10GE × 28` */
  label: string;
  /** posição no grid do painel (canto superior esquerdo da legenda) */
  x: number;
  y: number;
  count: number;
}

/** Família do rótulo da porta: `10GE-1` → `10GE`, `GPON-16` → `GPON`. */
export function portFamilyPrefix(portName: string): string {
  const trimmed = portName.trim();
  const stripped = trimmed.replace(/[\s_-]*\d+$/, '');
  return stripped || trimmed;
}

/** Ordinal curto para o rótulo dentro do conector: `10GE-12` → `12`. */
export function portOrdinalLabel(portName: string): string | null {
  const match = /(\d+)(?!.*\d)/.exec(portName.trim());
  return match ? match[1]! : null;
}

/**
 * Legendas de grupo do painel técnico.
 *
 * Uma legenda por grupo do layout (`groupKey`), com o nome da família derivado
 * dos nomes já declarados das portas — nada é inventado: se as portas do grupo
 * não compartilham o mesmo prefixo, vale o rótulo do conector.
 */
export function technicalPanelCaptions(
  layout: Pick<PanelLayout, 'connectors'>,
): TechnicalCaption[] {
  const groups = new Map<string, PlacedConnector[]>();
  for (const connector of layout.connectors) {
    const key = connector.groupKey ?? connector.kind;
    const bucket = groups.get(key);
    if (bucket) bucket.push(connector);
    else groups.set(key, [connector]);
  }

  const captions: TechnicalCaption[] = [];
  for (const [key, connectors] of groups) {
    const families = new Set(connectors.map((connector) => portFamilyPrefix(connector.portName)));
    const family =
      families.size === 1
        ? [...families][0]!
        : (connectors[0]?.shape.label ?? key.toUpperCase());
    const top = Math.min(...connectors.map((connector) => connector.y));
    captions.push({
      key,
      label: `${family} × ${connectors.length}`,
      x: Math.min(...connectors.map((connector) => connector.x)),
      y: Math.max(0, top - 2.4),
      count: connectors.length,
    });
  }
  return captions.sort((left, right) => left.y - right.y);
}
