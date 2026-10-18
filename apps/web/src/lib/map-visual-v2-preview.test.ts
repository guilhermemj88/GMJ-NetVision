import { describe, expect, it } from 'vitest';
import {
  PREVIEW_DEFAULT_VISUAL_MODE,
  PREVIEW_VISUAL_MODE_KEY,
  isPreviewInstance,
  isVisualModeSelectorEnabled,
  isVisualModeSessionSelectorEnabled,
  readPreviewVisualMode,
  resolvePreviewMapVisualMode,
  subscribePreviewVisualMode,
  writePreviewVisualMode,
} from './map-visual-v2-preview';
import { resolveMapVisualMode } from './map-visual-mode';

describe('seletor V1/V2 do preview', () => {
  it('o valor padrão vem de Map.filters.visualMode', () => {
    expect(resolveMapVisualMode(undefined)).toBe('V1');
    expect(resolveMapVisualMode({})).toBe('V1');
    expect(resolveMapVisualMode({ visualMode: 'V2' })).toBe('V2');
  });

  it('no preview, mapa sem flag explícita abre em V2 (decisão do operador)', () => {
    expect(PREVIEW_DEFAULT_VISUAL_MODE).toBe('V2');
    expect(resolvePreviewMapVisualMode(undefined, true)).toBe('V2');
    expect(resolvePreviewMapVisualMode({}, true)).toBe('V2');
    expect(resolvePreviewMapVisualMode({ visualMode: 'V2' }, true)).toBe('V2');
  });

  it('a flag explícita do mapa vence o padrão do preview', () => {
    expect(resolvePreviewMapVisualMode({ visualMode: 'V1' }, true)).toBe('V1');
    expect(resolvePreviewMapVisualMode({ visualMode: 'V1' }, false)).toBe('V1');
    expect(resolvePreviewMapVisualMode({ visualMode: 'V2' }, false)).toBe('V2');
  });

  it('fora do preview (produção) o padrão continua V1', () => {
    expect(resolvePreviewMapVisualMode(undefined, false)).toBe('V1');
    expect(resolvePreviewMapVisualMode({}, false)).toBe('V1');
    // Valor inválido no JSON do mapa não liga a V2.
    expect(
      resolvePreviewMapVisualMode({ visualMode: 'MODERNO' as never }, true),
    ).toBe('V2');
    expect(
      resolvePreviewMapVisualMode({ visualMode: 'MODERNO' as never }, false),
    ).toBe('V1');
  });

  it('a escolha do operador vive numa chave própria do preview', () => {
    expect(PREVIEW_VISUAL_MODE_KEY).toBe('gmj:preview:map-visual-mode');
    expect(PREVIEW_VISUAL_MODE_KEY).not.toMatch(/gmj:traffic-labels/);
  });

  it('fora do navegador não há leitura nem escrita (nada quebra no SSR)', () => {
    expect(readPreviewVisualMode()).toBeNull();
    expect(() => writePreviewVisualMode('V2')).not.toThrow();
    expect(readPreviewVisualMode()).toBeNull();
  });

  it('o seletor só é habilitado em instância de preview', () => {
    // O ambiente de teste não define NEXT_PUBLIC_PREVIEW_MODE.
    expect(isVisualModeSelectorEnabled()).toBe(false);
  });

  it('Fase N: o seletor de SESSÃO V1/V2 existe também no produto (sem gravar nada)', () => {
    // Vale nas duas instâncias: é como o operador usa a V2 sem tocar no banco.
    expect(isVisualModeSessionSelectorEnabled()).toBe(true);
    expect(isPreviewInstance()).toBe(false);
    delete process.env.NEXT_PUBLIC_PREVIEW_MODE;
    expect(isVisualModeSessionSelectorEnabled()).toBe(true);
    expect(isPreviewInstance()).toBe(false);
    process.env.NEXT_PUBLIC_PREVIEW_MODE = 'true';
    expect(isPreviewInstance()).toBe(true);
    // Mesmo com o preview ligado, o padrão do mapa sem flag continua resolvido
    // por quem decide (a produção usa `isPreviewInstance()` só para V2-default).
    expect(isVisualModeSessionSelectorEnabled()).toBe(true);
    delete process.env.NEXT_PUBLIC_PREVIEW_MODE;
  });

  it('assinatura de mudança é estável e cancelável', () => {
    const previous = (globalThis as { window?: unknown }).window;
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
    try {
      let calls = 0;
      const unsubscribe = subscribePreviewVisualMode(() => {
        calls += 1;
      });

      writePreviewVisualMode('V2');
      expect(calls).toBe(1);
      expect(readPreviewVisualMode()).toBe('V2');
      expect(store.get(PREVIEW_VISUAL_MODE_KEY)).toBe('V2');

      unsubscribe();
      writePreviewVisualMode(null);
      expect(calls).toBe(1);
      expect(readPreviewVisualMode()).toBeNull();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});
