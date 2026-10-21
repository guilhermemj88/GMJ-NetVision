/**
 * MAP-VISUAL-V2 — feature flag visual POR MAPA (Fase C, preparação isolada).
 *
 * O campo vive no JSON de `Map.filters` (`MapPreferences.visualMode`), então
 * não exige migration nem coluna nova. Regras:
 *  - ausente/desconhecido → V1 (padrão obrigatório do produto);
 *  - só mapas explicitamente marcados usam V2;
 *  - rollback = remover/sobrescrever o campo no mapa (sem perder geometria,
 *    links, curvas ou labels manuais).
 *
 * Este módulo é puro: o laboratório só demonstra a leitura/escrita do campo em
 * memória. Nenhum mapa real é alterado nesta fase.
 */

import type { MapPreferences, MapVisualMode } from '@gmj/shared';

export const DEFAULT_MAP_VISUAL_MODE: MapVisualMode = 'V1';

export function isMapVisualMode(value: unknown): value is MapVisualMode {
  return value === 'V1' || value === 'V2';
}

/**
 * Fase J: a flag aceita também os nomes explícitos da especificação
 * (`MAP_VISUAL_V1` / `MAP_VISUAL_V2`) além dos valores canônicos persistidos
 * ('V1'/'V2'). Qualquer outro valor é desconhecido → V1.
 */
export function normalizeMapVisualMode(value: unknown): MapVisualMode | null {
  if (value === 'V1' || value === 'MAP_VISUAL_V1') return 'V1';
  if (value === 'V2' || value === 'MAP_VISUAL_V2') return 'V2';
  return null;
}

export function resolveMapVisualMode(
  preferences: Pick<MapPreferences, 'visualMode'> | null | undefined,
): MapVisualMode {
  return normalizeMapVisualMode(preferences?.visualMode) ?? DEFAULT_MAP_VISUAL_MODE;
}

/** Devolve novas preferências com o modo ajustado (não muta a entrada). */
export function withMapVisualMode<T extends Pick<MapPreferences, 'visualMode'>>(
  preferences: T,
  mode: MapVisualMode,
): T {
  return { ...preferences, visualMode: mode };
}

/** V2 habilitado apenas quando o mapa pede explicitamente. */
export function isMapVisualV2Enabled(
  preferences: Pick<MapPreferences, 'visualMode'> | null | undefined,
): boolean {
  return resolveMapVisualMode(preferences) === 'V2';
}
