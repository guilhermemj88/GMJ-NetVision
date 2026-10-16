'use client';

/**
 * MAP-VISUAL-V2 — Fase E: modo da microanimação dos enlaces no preview.
 *
 *  - `smart` (padrão): anima seleção, hover e sentidos em atenção/crítico;
 *  - `always`: todos os sentidos com telemetria válida;
 *  - `off`: nenhum (as setas continuam visíveis).
 *
 * A escolha vive SÓ nesta aba (memória + sessionStorage com chave própria):
 * nada é gravado no mapa, nenhuma preferência de produção é alterada e a V1
 * sequer conhece este controle. `prefers-reduced-motion` é tratado no CSS.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { LinkV2AnimationMode } from './map-visual-v2-weathermap';

export const PREVIEW_ANIMATION_KEY = 'gmj:preview:link-animation';
export const PREVIEW_ANIMATION_DEFAULT: LinkV2AnimationMode = 'smart';

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

/** Escolha do operador nesta aba (null = padrão inteligente). */
export function readPreviewAnimation(): LinkV2AnimationMode | null {
  const raw = storage()?.getItem(PREVIEW_ANIMATION_KEY) ?? null;
  return isLinkV2AnimationMode(raw) ? raw : null;
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

/** Modo efetivo: escolha da aba > padrão inteligente. */
export function useLinkV2AnimationMode(): LinkV2AnimationMode {
  return usePreviewAnimationOverride() ?? PREVIEW_ANIMATION_DEFAULT;
}

export function useSetLinkV2AnimationMode(): (mode: LinkV2AnimationMode | null) => void {
  return useCallback((mode: LinkV2AnimationMode | null) => writePreviewAnimation(mode), []);
}
