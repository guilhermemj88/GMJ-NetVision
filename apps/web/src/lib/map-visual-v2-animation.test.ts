/**
 * Fase E/I — controle de animação do preview.
 *
 * A escolha vive só na aba (sessionStorage, chave VERSIONADA) e NUNCA no
 * mapa/banco. A Fase I inverteu o padrão para DESLIGADA e passou a ignorar a
 * preferência das fases anteriores, para a aba não reabrir animando.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_ANIMATION_DEFAULT,
  PREVIEW_ANIMATION_KEY,
  PREVIEW_ANIMATION_LEGACY_KEY,
  discardLegacyPreviewAnimation,
  isLinkV2AnimationMode,
  readPreviewAnimation,
  subscribePreviewAnimation,
  writePreviewAnimation,
} from './map-visual-v2-animation';

describe('modo de animação do preview', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    };
  });

  it('a chave é própria e versionada, e o padrão é DESLIGADA (Fase I)', () => {
    expect(PREVIEW_ANIMATION_KEY).toBe('gmj:preview:link-animation:v2');
    expect(PREVIEW_ANIMATION_LEGACY_KEY).toBe('gmj:preview:link-animation');
    expect(PREVIEW_ANIMATION_DEFAULT).toBe('off');
    expect(readPreviewAnimation()).toBeNull();
  });

  it('a preferência das fases anteriores NÃO reativa a animação', () => {
    // Simula uma aba antiga que estava em "inteligente" (ou "sempre ativa").
    store.set(PREVIEW_ANIMATION_LEGACY_KEY, 'smart');
    expect(readPreviewAnimation()).toBeNull();
    store.set(PREVIEW_ANIMATION_LEGACY_KEY, 'always');
    expect(readPreviewAnimation()).toBeNull();
    // A higiene remove a chave velha e preserva a escolha nova da aba.
    writePreviewAnimation('smart');
    discardLegacyPreviewAnimation();
    expect(store.has(PREVIEW_ANIMATION_LEGACY_KEY)).toBe(false);
    expect(readPreviewAnimation()).toBe('smart');
  });

  it('aceita apenas os três modos válidos', () => {
    expect(isLinkV2AnimationMode('off')).toBe(true);
    expect(isLinkV2AnimationMode('smart')).toBe(true);
    expect(isLinkV2AnimationMode('always')).toBe(true);
    expect(isLinkV2AnimationMode('turbo')).toBe(false);
    expect(isLinkV2AnimationMode(null)).toBe(false);
  });

  it('grava, lê e limpa a escolha da aba', () => {
    let calls = 0;
    const unsubscribe = subscribePreviewAnimation(() => {
      calls += 1;
    });
    writePreviewAnimation('always');
    expect(readPreviewAnimation()).toBe('always');
    expect(calls).toBe(1);
    writePreviewAnimation(null);
    expect(readPreviewAnimation()).toBeNull();
    expect(calls).toBe(2);
    unsubscribe();
    writePreviewAnimation('off');
    expect(calls).toBe(2);
    expect(readPreviewAnimation()).toBe('off');
  });

  it('escolha explícita de Inteligente fica registrada na aba', () => {
    writePreviewAnimation('smart');
    expect(readPreviewAnimation()).toBe('smart');
    // E volta para o padrão quando o operador limpa a escolha.
    writePreviewAnimation(null);
    expect(readPreviewAnimation() ?? PREVIEW_ANIMATION_DEFAULT).toBe('off');
  });

  it('valor inválido no storage não vira modo', () => {
    window.sessionStorage.setItem(PREVIEW_ANIMATION_KEY, 'SEMPRE');
    expect(readPreviewAnimation()).toBeNull();
  });

  it('fora do navegador não quebra (SSR)', () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(readPreviewAnimation()).toBeNull();
    expect(() => writePreviewAnimation('off')).not.toThrow();
    expect(() => discardLegacyPreviewAnimation()).not.toThrow();
  });
});
