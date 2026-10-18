/**
 * MAP-VISUAL-V2 — Fase D: glifos do MAPA REAL no motor V2.
 *
 * O catálogo/laboratório continua comparando o desenho provisório com o
 * candidato (`resolveDeviceGlyphV2`, sem alteração). Aqui fica a decisão de
 * PRODUÇÃO do V2, autorizada pela especificação da Fase D: o tipo CORE_SWITCH
 * passa a usar o glifo próprio de dois chassis.
 *
 * Isto NÃO altera taxonomia nem valores persistidos: só escolhe o desenho de
 * tipos que já existem no banco. A V1 segue com os glifos atuais.
 */

import {
  resolveDeviceGlyphV2,
  type DeviceGlyphV2Type,
} from '@/components/network-device-glyphs-v2';

/** Tamanho base do ícone no nó (igual ao `size` usado pelo renderer V1). */
export const MAP_GLYPH_BASE_SIZE = 32;

/** Limite aprovado para a variante compacta do BNG. */
export const MAP_GLYPH_COMPACT_MAX_PX = 24;

export function resolveMapDeviceGlyphV2(legacyType: string): DeviceGlyphV2Type | null {
  if (legacyType === 'CORE_SWITCH') return 'CORE_SWITCH';
  return resolveDeviceGlyphV2(legacyType);
}

/**
 * Tamanho efetivo do glifo na tela: o nó inteiro é escalado por `--node-scale`
 * (CSS `zoom`), então 100% = 32 px e 75% = 24 px.
 */
export function mapGlyphEffectiveSize(nodeScale: number, baseSize = MAP_GLYPH_BASE_SIZE): number {
  const scale = Number.isFinite(nodeScale) && nodeScale > 0 ? nodeScale / 100 : 1;
  return baseSize * scale;
}

/** BNG compacta até 24 px; normal a partir de 32 px (preferência aprovada). */
export function isMapGlyphCompact(
  type: DeviceGlyphV2Type,
  effectiveSizePx: number,
): boolean {
  if (type !== 'BNG') return false;
  return effectiveSizePx <= MAP_GLYPH_COMPACT_MAX_PX;
}
