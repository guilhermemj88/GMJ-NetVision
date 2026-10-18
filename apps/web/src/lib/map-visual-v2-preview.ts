'use client';

/**
 * MAP-VISUAL-V2 — Fase D: seletor V1/V2 do preview (Fase N: sessão no produto).
 *
 * Regras (item 4 da especificação):
 *  - o valor INICIAL vem de `Map.filters.visualMode` — mapa sem configuração
 *    explícita continua em V1 no produto;
 *  - a troca feita pelo operador vive só nesta aba (memória + `sessionStorage`
 *    com chave própria): NADA é enviado para a API, nenhuma preferência de
 *    produção é gravada;
 *  - exceção combinada com o operador: na instância de PREVIEW, mapa sem flag
 *    explícita abre em V2 (`PREVIEW_DEFAULT_VISUAL_MODE`) para a avaliação
 *    visual começar pelo desenho novo; a flag explícita do mapa sempre vence e
 *    o seletor continua permitindo voltar para V1 na hora;
 *  - Fase N: o seletor de SESSÃO passou a existir também na produção — é por ele
 *    que o operador usa a V2 num mapa sem escrever no banco (a flag persistida
 *    continua sendo o padrão do mapa, e mapas sem flag seguem em V1);
 *  - trocar de visual só muda a renderização: posições, enlaces, curvaturas,
 *    offsets, zoom e layout salvo continuam vindo do mapa real.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { MapPreferences, MapVisualMode } from '@gmj/shared';
import { isMapVisualMode, resolveMapVisualMode } from './map-visual-mode';

export const PREVIEW_VISUAL_MODE_KEY = 'gmj:preview:map-visual-mode';

/** Padrão da instância de preview quando o mapa não tem flag explícita. */
export const PREVIEW_DEFAULT_VISUAL_MODE: MapVisualMode = 'V2';

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

/**
 * A instância é o PREVIEW (3004)? Só lá existem comportamentos especiais:
 * V2 por padrão em mapa sem flag, laboratório e controle de animação.
 * No produto (3000) a flag do mapa decide e a animação é sempre desligada.
 */
export function isPreviewInstance(): boolean {
  return process.env.NEXT_PUBLIC_PREVIEW_MODE === 'true';
}

/**
 * O seletor V1/V2 de SESSÃO está disponível em QUALQUER instância (Fase N):
 * é a forma de o operador usar a V2 sem gravar nada no banco. Não muda o padrão
 * do mapa — `Map.filters.visualMode` continua decidindo o que abre por padrão e
 * mapa sem flag continua em V1 no produto.
 */
export function isVisualModeSessionSelectorEnabled(): boolean {
  return true;
}

/** Compatibilidade: o seletor antigo do preview (mesma semântica de instância). */
export function isVisualModeSelectorEnabled(): boolean {
  return isPreviewInstance();
}

export function usePreviewVisualModeOverride(): MapVisualMode | null {
  return useSyncExternalStore(subscribePreviewVisualMode, readPreviewVisualMode, () => null);
}

/**
 * Modo visual inicial do mapa na instância de preview: a flag explícita do mapa
 * sempre vence; sem flag, o preview abre em V2 e o produto continua em V1.
 */
export function resolvePreviewMapVisualMode(
  filters: Pick<MapPreferences, 'visualMode'> | null | undefined,
  previewEnabled: boolean = isVisualModeSelectorEnabled(),
): MapVisualMode {
  const resolved = resolveMapVisualMode(filters ?? null);
  if (!previewEnabled) return resolved;
  return isMapVisualMode(filters?.visualMode) ? resolved : PREVIEW_DEFAULT_VISUAL_MODE;
}

/**
 * Modo visual efetivo do mapa: escolha do preview > `Map.filters.visualMode`
 * (ou V2 no preview, quando o mapa não tem flag) > V1. Nunca grava no mapa.
 */
export function useMapVisualMode(
  filters: MapPreferences | null | undefined,
): MapVisualMode {
  const override = usePreviewVisualModeOverride();
  return override ?? resolvePreviewMapVisualMode(filters);
}

export function useSetMapVisualMode(): (mode: MapVisualMode | null) => void {
  return useCallback((mode: MapVisualMode | null) => writePreviewVisualMode(mode), []);
}
