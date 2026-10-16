/**
 * Fase E — controle de animação do preview.
 *
 * A escolha vive só na aba (sessionStorage) e NUNCA no mapa/banco: o teste
 * garante o padrão inteligente, a leitura/escrita e a recusa de valores
 * inválidos vindos do storage.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_ANIMATION_DEFAULT,
  PREVIEW_ANIMATION_KEY,
  isLinkV2AnimationMode,
  readPreviewAnimation,
  subscribePreviewAnimation,
  writePreviewAnimation,
} from './map-visual-v2-animation';

describe('modo de animação do preview', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
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

  it('a chave é própria e o padrão é inteligente', () => {
    expect(PREVIEW_ANIMATION_KEY).toBe('gmj:preview:link-animation');
    expect(PREVIEW_ANIMATION_DEFAULT).toBe('smart');
    expect(readPreviewAnimation()).toBeNull();
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

  it('valor inválido no storage não vira modo', () => {
    window.sessionStorage.setItem(PREVIEW_ANIMATION_KEY, 'SEMPRE');
    expect(readPreviewAnimation()).toBeNull();
  });

  it('fora do navegador não quebra (SSR)', () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(readPreviewAnimation()).toBeNull();
    expect(() => writePreviewAnimation('off')).not.toThrow();
  });
});
