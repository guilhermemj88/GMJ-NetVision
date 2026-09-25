import type { TechnicalLed, TechnicalLedTone } from './physical-technical';
import {
  type FixedFaceplateLayoutSpec,
  type FixedFaceplateZone,
  FIXED_FACEPLATE_PADDING,
  FIXED_INTERFACE_LINE_PX,
  TECHNICAL_FIXED_MAX_HEIGHT,
  buildFixedFaceplateLayout,
  fixedFaceplateDisplayHeight,
  fixedFaceplateRegions,
} from './fixed-faceplate/fixed-faceplate-layout';

/**
 * Faceplate **FIXO** da primeira passada (camada exclusivamente visual).
 *
 * Sobrou aqui o desenho do **F1A-8H20Q** (fora do escopo da migração para a
 * biblioteca visual) e os reexports do motor compartilhado, que agora vive em
 * `./fixed-faceplate/fixed-faceplate-layout.ts`. Os demais equipamentos fixos
 * migraram para `fixedFaceplateProfileFor()` (perfil visual por SKU).
 *
 * O catálogo (`physical-catalog-v1.yaml`) continua sendo a fonte da verdade:
 * quais portas existem, com qual conector, qual `groupKey` e qual numeração
 * física (`panelNumber`). O que este módulo decide é **somente o desenho**.
 */

export {
  FIXED_FACEPLATE_PADDING,
  FIXED_INTERFACE_LINE_PX,
  TECHNICAL_FIXED_MAX_HEIGHT,
  buildFixedFaceplateLayout,
  fixedFaceplateRegions,
};
export type {
  FixedFaceplateBandSpec,
  FixedFaceplateGroupSpec,
  FixedFaceplateRegion,
  FixedFaceplateZone,
} from './fixed-faceplate/fixed-faceplate-layout';

/** Metadata **visual** de um modelo fixo (nunca um segundo catálogo técnico). */
export interface FixedFaceplateSpec extends FixedFaceplateLayoutSpec {
  /** SKU exato do catálogo (transparência da camada visual). */
  readonly catalogKey: string;
  /** Serigrafia de marca/modelo. */
  readonly brand?: FixedFaceplateZone;
  /** LEDs de status do chassi. */
  readonly leds?: FixedFaceplateZone & { readonly labels?: readonly string[] };
  /** Ventilação localizada (proporcional, não uma faixa vazia). */
  readonly vents?: readonly FixedFaceplateZone[];
}

const LED_TONES: Record<string, TechnicalLedTone> = {
  PWR: 'pwr',
  ALM: 'off',
  ACT: 'act',
  RUN: 'on',
  FAN: 'fan',
};

/**
 * Faceplate do **Huawei NetEngine 8000 F1A-8H20Q**.
 *
 * Painel real: 56 jaulas em UMA faixa contínua de 28 colunas × 2 fileiras
 * (par em cima, ímpar embaixo), numeração física 0–55 — 0–27 SFP+, 28–35 e
 * 36–47 SFP28, 48–55 QSFP28. O desenho distribui os quatro blocos lado a lado
 * ocupando a largura útil, com serigrafia/LEDs à esquerda e ventilação à
 * direita, e mantém as duas fileiras alinhadas entre os blocos (mesma altura de
 * célula), como no frontal real.
 */
const F1A_8H20Q: FixedFaceplateSpec = {
  catalogKey: 'huawei-ne8000-f1a-8h20q',
  chassis: { width: 119, height: 7.9 },
  // respiro acima das jaulas e faixa da legenda/rodapé abaixo delas
  chrome: { top: 0.6, bottom: 1.75 },
  ports: { x: 7.5, y: 0.6, width: 108.4, height: 5.6 },
  bands: [
    {
      groups: [
        { groupKey: 'sfpplus-10g', gapX: 0.5 },
        { groupKey: 'sfp28-25g-a', gapX: 0.5 },
        { groupKey: 'sfp28-25g-b', gapX: 0.5 },
        { groupKey: 'qsfp28-100g', gapX: 0.5 },
      ],
    },
  ],
  groupGap: 0.6,
  rowGap: 0.35,
  justify: 'between',
  brand: { x: 1.5, y: 0.7, width: 5.9, height: 2.9 },
  leds: { x: 1.5, y: 3.8, width: 5.9, height: 2.5, labels: ['PWR', 'ALM', 'ACT'] },
  vents: [{ x: 116.1, y: 0.9, width: 2.4, height: 5 }],
};

/** Faceplates desta camada, por SKU exato do catálogo. */
const FIXED_FACEPLATES: readonly FixedFaceplateSpec[] = [F1A_8H20Q];

const BY_KEY = new Map(FIXED_FACEPLATES.map((spec) => [spec.catalogKey, spec]));

/** `true` quando o modelo tem faceplate próprio nesta camada. */
export function hasFixedFaceplate(catalogKey: string | null | undefined): boolean {
  return Boolean(catalogKey && BY_KEY.has(catalogKey));
}

/** Metadata visual do modelo (ou `null`: outro renderer cuida do desenho). */
export function fixedTechnicalFaceplateFor(
  catalogKey: string | null | undefined,
): FixedFaceplateSpec | null {
  if (!catalogKey) return null;
  return BY_KEY.get(catalogKey) ?? null;
}

/** Todos os SKUs com faceplate nesta camada (transparência para testes e UI). */
export const FIXED_FACEPLATE_CATALOG_KEYS: readonly string[] = FIXED_FACEPLATES.map(
  (spec) => spec.catalogKey,
);

/** LEDs do chassi (aparência; o estado real vem do backend quando existir). */
export function fixedFaceplateLeds(spec: FixedFaceplateSpec): TechnicalLed[] {
  return (spec.leds?.labels ?? ['PWR', 'ALM', 'ACT']).map((label) => ({
    label,
    tone: LED_TONES[label] ?? 'off',
  }));
}

/**
 * Altura visual de um equipamento fixo com faceplate desta camada: proporção do
 * chassi declarado, com teto próprio (`TECHNICAL_FIXED_MAX_HEIGHT`). A ocupação
 * no rack (`heightU`) continua exatamente a mesma.
 */
export function technicalFixedFaceplateHeight(input: {
  spec: FixedFaceplateSpec;
  /** largura útil do painel no rack (px) */
  panelWidthPx: number;
  heightU: number;
  baseUnitHeight: number;
  /** cabeçalho + respiro já existentes na faceplate (px) */
  chromePx: number;
  /** linha extra pedida pelo conteúdo (ex.: faixa de interfaces CLI do grupo) */
  extraHeightPx?: number | undefined;
  /** teto do desenho (default: `TECHNICAL_FIXED_MAX_HEIGHT`) */
  maxHeightPx?: number | undefined;
}): number {
  return fixedFaceplateDisplayHeight({
    gridHeight: input.spec.chassis.height,
    gridWidth: input.spec.chassis.width,
    panelWidthPx: input.panelWidthPx,
    heightU: input.heightU,
    baseUnitHeight: input.baseUnitHeight,
    chromePx: input.chromePx,
    extraHeightPx: input.extraHeightPx,
    maxHeightPx: input.maxHeightPx,
  });
}
