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

export function resolveMapVisualMode(
  preferences: Pick<MapPreferences, 'visualMode'> | null | undefined,
): MapVisualMode {
  const value = preferences?.visualMode;
  return isMapVisualMode(value) ? value : DEFAULT_MAP_VISUAL_MODE;
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
