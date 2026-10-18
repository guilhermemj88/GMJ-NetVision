'use client';

/**
 * FASE M — estilo dos enlaces (experimento A/B do preview).
 *
 *  - `directional` (PADRÃO): visual atual (Fase L) — A→B ciano, B→A violeta, a
 *    utilização só na plaqueta;
 *  - `operational`: a cor de cada METADE representa a SUA utilização
 *    (verde-sálvia / âmbar fosco / coral fosco) na linha, na seta e na borda da
 *    plaqueta.
 *
 * Política de persistência (igual à da animação: por ABA, nunca no mapa nem no
 * banco):
 *  - chave própria e versionada (`gmj:preview:link-style:v1`);
 *  - nenhuma escrita em `Map.filters.visualMode` e nenhuma chamada de rede;
 *  - sem escolha explícita nesta aba, o estilo é `directional`, ou seja, o
 *    fallback do experimento é exatamente o visual aprovado na Fase L.
 *
 * O estilo é INDEPENDENTE da alternância V1/V2: trocar de estilo não remonta o
 * canvas, não recalcula geometria/anticolisão e não altera seleção, zoom, pan,
 * ContextDrawer nem gráficos — só as cores do desenho.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { isLinkV2StyleMode, type LinkV2StyleMode } from './map-visual-v2-weathermap';

export const PREVIEW_LINK_STYLE_KEY = 'gmj:preview:link-style:v1';
export const PREVIEW_LINK_STYLE_DEFAULT: LinkV2StyleMode = 'directional';

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribePreviewLinkStyle(listener: () => void): () => void {
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

/**
 * Seam de TESTE (a aplicação nunca chama): fixa o estilo sem storage, para os
 * testes de marcação estática conseguirem renderizar o modo operacional.
 */
let testOverride: LinkV2StyleMode | null = null;

export function setPreviewLinkStyleForTests(mode: LinkV2StyleMode | null): void {
  testOverride = mode;
  emit();
}

/** Escolha do operador NESTA aba (null = padrão da fase). */
export function readPreviewLinkStyle(): LinkV2StyleMode | null {
  const raw = storage()?.getItem(PREVIEW_LINK_STYLE_KEY) ?? null;
  return isLinkV2StyleMode(raw) ? raw : null;
}

export function writePreviewLinkStyle(mode: LinkV2StyleMode | null): void {
  const store = storage();
  if (store) {
    if (mode === null) store.removeItem(PREVIEW_LINK_STYLE_KEY);
    else store.setItem(PREVIEW_LINK_STYLE_KEY, mode);
  }
  emit();
}

export function usePreviewLinkStyleOverride(): LinkV2StyleMode | null {
  return useSyncExternalStore(
    subscribePreviewLinkStyle,
    () => testOverride ?? readPreviewLinkStyle(),
    () => testOverride ?? null,
  );
}

/** Estilo efetivo: escolha da aba > padrão (DIRECIONAL, o visual aprovado). */
export function useLinkV2StyleMode(): LinkV2StyleMode {
  return usePreviewLinkStyleOverride() ?? PREVIEW_LINK_STYLE_DEFAULT;
}

export function useSetLinkV2StyleMode(): (mode: LinkV2StyleMode | null) => void {
  return useCallback((mode: LinkV2StyleMode | null) => writePreviewLinkStyle(mode), []);
}
