'use client';

/**
 * MAP-VISUAL-V2 — Fase D: seletor V1/V2 do preview.
 *
 * Regras (item 4 da especificação):
 *  - o valor INICIAL vem de `Map.filters.visualMode` — mapa sem configuração
 *    explícita continua em V1;
 *  - a troca feita pelo operador vive só nesta aba do preview (memória +
 *    `sessionStorage` com chave própria): NADA é enviado para a API, nenhuma
 *    preferência de produção é gravada;
 *  - trocar de visual só muda a renderização: posições, enlaces, curvaturas,
 *    offsets, zoom e layout salvo continuam vindo do mapa real.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { MapPreferences, MapVisualMode } from '@gmj/shared';
import { resolveMapVisualMode } from './map-visual-mode';

export const PREVIEW_VISUAL_MODE_KEY = 'gmj:preview:map-visual-mode';

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribePreviewVisualMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Escolha do operador nesta aba (null = usar o padrão do mapa). */
export function readPreviewVisualMode(): MapVisualMode | null {
  const raw = storage()?.getItem(PREVIEW_VISUAL_MODE_KEY) ?? null;
  return raw === 'V1' || raw === 'V2' ? raw : null;
}

export function writePreviewVisualMode(mode: MapVisualMode | null): void {
  const store = storage();
  if (!store) return;
  if (mode === null) store.removeItem(PREVIEW_VISUAL_MODE_KEY);
  else store.setItem(PREVIEW_VISUAL_MODE_KEY, mode);
  emit();
}

/** O seletor só aparece em instância de preview (nunca no build de produção). */
export function isVisualModeSelectorEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PREVIEW_MODE === 'true';
}

export function usePreviewVisualModeOverride(): MapVisualMode | null {
  return useSyncExternalStore(subscribePreviewVisualMode, readPreviewVisualMode, () => null);
}

/**
 * Modo visual efetivo do mapa: escolha do preview > `Map.filters.visualMode`
 * > V1. Nunca grava no mapa.
 */
export function useMapVisualMode(
  filters: MapPreferences | null | undefined,
): MapVisualMode {
  const override = usePreviewVisualModeOverride();
  return override ?? resolveMapVisualMode(filters ?? null);
}

export function useSetMapVisualMode(): (mode: MapVisualMode | null) => void {
  return useCallback((mode: MapVisualMode | null) => writePreviewVisualMode(mode), []);
}
