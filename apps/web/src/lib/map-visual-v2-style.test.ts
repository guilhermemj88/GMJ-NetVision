/**
 * FASE M — seletor A/B de estilo dos enlaces.
 *
 * A escolha vive só na ABA (sessionStorage, chave própria e versionada) e NUNCA
 * no mapa/banco: nenhuma escrita em `Map.filters.visualMode`, nenhuma chamada de
 * rede. Sem escolha explícita o estilo é DIRECIONAL — o visual aprovado na
 * Fase L é o fallback do experimento.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_LINK_STYLE_DEFAULT,
  PREVIEW_LINK_STYLE_KEY,
  readPreviewLinkStyle,
  subscribePreviewLinkStyle,
  writePreviewLinkStyle,
} from './map-visual-v2-style';
import {
  PREVIEW_ANIMATION_KEY,
  readPreviewAnimation,
  writePreviewAnimation,
} from './map-visual-v2-animation';

describe('estilo dos enlaces do preview (Fase M)', () => {
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

  it('24. a preferência é exclusiva do preview: chave própria e versionada, padrão DIRECIONAL', () => {
    expect(PREVIEW_LINK_STYLE_KEY).toBe('gmj:preview:link-style:v1');
    expect(PREVIEW_LINK_STYLE_DEFAULT).toBe('directional');
    expect(readPreviewLinkStyle()).toBeNull();
  });

  it('grava, lê e limpa a escolha da aba, avisando os assinantes', () => {
    let calls = 0;
    const unsubscribe = subscribePreviewLinkStyle(() => {
      calls += 1;
    });
    writePreviewLinkStyle('operational');
    expect(readPreviewLinkStyle()).toBe('operational');
    writePreviewLinkStyle('directional');
    expect(readPreviewLinkStyle()).toBe('directional');
    writePreviewLinkStyle(null);
    expect(readPreviewLinkStyle()).toBeNull();
    expect(calls).toBe(3);
    unsubscribe();
    writePreviewLinkStyle('operational');
    expect(calls).toBe(3);
  });

  it('ignora valor inválido vindo de uma aba antiga', () => {
    store.set(PREVIEW_LINK_STYLE_KEY, 'rainbow');
    expect(readPreviewLinkStyle()).toBeNull();
  });

  it('não toca nas outras preferências do preview (animação/V1-V2)', () => {
    writePreviewLinkStyle('operational');
    expect([...store.keys()]).toEqual([PREVIEW_LINK_STYLE_KEY]);
    // A animação continua no padrão DESLIGADA e a chave dela não foi criada.
    expect(store.has(PREVIEW_ANIMATION_KEY)).toBe(false);
    expect(readPreviewAnimation()).toBeNull();
    writePreviewAnimation('always');
    expect(readPreviewLinkStyle()).toBe('operational');
    expect(readPreviewAnimation()).toBe('always');
    expect(store.size).toBe(2);
  });

  it('23. nenhuma requisição é disparada ao ler/gravar o estilo', () => {
    let requested = 0;
    (globalThis as { fetch?: unknown }).fetch = () => {
      requested += 1;
      return Promise.resolve({ ok: true });
    };
    readPreviewLinkStyle();
    writePreviewLinkStyle('operational');
    readPreviewLinkStyle();
    expect(requested).toBe(0);
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('o módulo não conhece API, banco nem feature flag (só sessão da aba)', async () => {
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(new URL('./map-visual-v2-style.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('prisma');
    // Cita `Map.filters.visualMode` apenas na documentação: nada é escrito nele.
    expect(source).not.toMatch(/visualMode\s*[:=]/);
    expect(source).toContain('sessionStorage');
  });

  it('20/21. o estilo é lido só no desenho: geometria, anticolisão e seleção não o conhecem', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (relative: string) =>
      readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    // O canvas (nós, enlaces, seleção, ContextDrawer, zoom/pan) e o resolvedor
    // determinístico de rótulos NÃO importam o estilo: nenhuma troca de cor pode
    // alterar layout, anticolisão ou seleção.
    expect(read('../components/network-canvas.tsx')).not.toContain('map-visual-v2-style');
    expect(read('./map-visual-v2-labels.ts')).not.toContain('map-visual-v2-style');
    expect(read('./map-visual-v2-labels.ts')).not.toContain('--wm-op-');
    // Quem lê o estilo são apenas os três pontos de apresentação.
    expect(read('../components/traffic-edge-v2-weathermap.tsx')).toContain('useLinkV2StyleMode');
    expect(read('../components/map-v2-legend.tsx')).toContain('useLinkV2StyleMode');
    expect(read('../components/top-bar.tsx')).toContain('useSetLinkV2StyleMode');
  });
});
