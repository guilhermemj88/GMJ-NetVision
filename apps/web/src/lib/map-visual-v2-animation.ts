'use client';

/**
 * MAP-VISUAL-V2 — Fase I: modo da microanimação dos enlaces no preview.
 *
 *  - `off` (PADRÃO desde a Fase I): nenhum runner se move. As setas continuam
 *    estáticas e visíveis, os sentidos seguem diferenciados por cor/forma e as
 *    plaquetas mantêm velocidade e percentual;
 *  - `smart` (opcional, escolha explícita): anima seleção, hover e sentidos em
 *    atenção/crítico;
 *  - `always` (experimental, escolha explícita): todos os sentidos válidos.
 *
 * Política de persistência (por ABA, nunca no mapa nem no banco):
 *  - vale apenas a chave VERSIONADA (`gmj:preview:link-animation:v2`);
 *  - a chave das fases E–H (`gmj:preview:link-animation`) é ignorada e
 *    descartada — uma aba antiga que estava em "inteligente" não reativa o
 *    movimento depois da atualização;
 *  - sem escolha explícita nesta aba, o modo é `off`.
 *
 * `prefers-reduced-motion` continua tratado no CSS. Nada aqui cria render por
 * frame nem altera a cadência das métricas.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { LinkV2AnimationMode } from './map-visual-v2-weathermap';

export const PREVIEW_ANIMATION_KEY = 'gmj:preview:link-animation:v2';
/** Chave das Fases E–H: sobrevive no storage, mas nunca é lida. */
export const PREVIEW_ANIMATION_LEGACY_KEY = 'gmj:preview:link-animation';
export const PREVIEW_ANIMATION_DEFAULT: LinkV2AnimationMode = 'off';

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribePreviewAnimation(listener: () => void): () => void {
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

export function isLinkV2AnimationMode(value: unknown): value is LinkV2AnimationMode {
  return value === 'off' || value === 'smart' || value === 'always';
}

/** Escolha do operador NESTA aba e NESTA versão (null = padrão da fase). */
export function readPreviewAnimation(): LinkV2AnimationMode | null {
  const raw = storage()?.getItem(PREVIEW_ANIMATION_KEY) ?? null;
  return isLinkV2AnimationMode(raw) ? raw : null;
}

/**
 * Higiene da sessão: apaga a preferência das fases anteriores. Chamada uma vez
 * pela barra do preview (não é leitura, então não fica no getSnapshot).
 */
export function discardLegacyPreviewAnimation(): void {
  storage()?.removeItem(PREVIEW_ANIMATION_LEGACY_KEY);
}

export function writePreviewAnimation(mode: LinkV2AnimationMode | null): void {
  const store = storage();
  if (!store) return;
  if (mode === null) store.removeItem(PREVIEW_ANIMATION_KEY);
  else store.setItem(PREVIEW_ANIMATION_KEY, mode);
  emit();
}

export function usePreviewAnimationOverride(): LinkV2AnimationMode | null {
  return useSyncExternalStore(subscribePreviewAnimation, readPreviewAnimation, () => null);
}

/** Modo efetivo: escolha da aba > padrão (animação DESLIGADA). */
export function useLinkV2AnimationMode(): LinkV2AnimationMode {
  return usePreviewAnimationOverride() ?? PREVIEW_ANIMATION_DEFAULT;
}

export function useSetLinkV2AnimationMode(): (mode: LinkV2AnimationMode | null) => void {
  return useCallback((mode: LinkV2AnimationMode | null) => writePreviewAnimation(mode), []);
}

/**
 * FASE N — modo de animação que a UI deve usar.
 *
 * No PRODUTO a decisão do operador é "sem animação nesta versão": o modo é
 * sempre `off`, mesmo que alguma aba tenha uma preferência antiga guardada (o
 * código dos runners permanece no lugar, apenas não é acionado). No preview a
 * preferência da aba continua valendo para os experimentos.
 */
export function resolveLinkV2AnimationModeForUi(
  preference: LinkV2AnimationMode | null,
  previewInstance: boolean,
): LinkV2AnimationMode {
  if (!previewInstance) return PREVIEW_ANIMATION_DEFAULT;
  return preference ?? PREVIEW_ANIMATION_DEFAULT;
}

/** Descarta a preferência legada na primeira montagem da barra do preview. */
export function useDiscardLegacyPreviewAnimation(): void {
  useEffect(() => {
    discardLegacyPreviewAnimation();
  }, []);
}
