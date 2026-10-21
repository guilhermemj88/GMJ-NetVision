/**
 * FASE M — a legenda acompanha o estilo ativo (item 10 da especificação).
 *
 * No modo DIRECIONAL ela explica a identidade fixa (ciano A→B / roxo B→A) e as
 * plaquetas; no modo OPERACIONAL ela explica que a cor é a utilização de CADA
 * sentido (verde-sálvia / âmbar / coral) e que a seta continua dizendo o
 * sentido. Os estados especiais aparecem nos dois modos.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MapV2Legend } from './map-v2-legend';
import { setPreviewLinkStyleForTests } from '@/lib/map-visual-v2-style';

function legend(style: 'directional' | 'operational' | null): string {
  setPreviewLinkStyleForTests(style);
  try {
    return renderToStaticMarkup(createElement(MapV2Legend, { animation: 'off' }));
  } finally {
    setPreviewLinkStyleForTests(null);
  }
}

afterEach(() => setPreviewLinkStyleForTests(null));

describe('legenda V2 por estilo', () => {
  it('modo DIRECIONAL: identidade fixa e plaquetas de utilização', () => {
    const html = legend('directional');
    expect(html).toContain('data-link-style="directional"');
    expect(html).toContain('Direcional: A→B ciano (seta cheia)');
    expect(html).toContain('B→A roxa (chevron)');
    expect(html).toContain('&lt;50% na cor do sentido');
    expect(html).toContain('50–79% âmbar');
    expect(html).toContain('≥80% crítico');
    expect(html).toContain('data-pill="critical"');
  });

  it('modo OPERACIONAL: verde/âmbar/coral por sentido e seta indicando a direção', () => {
    const html = legend('operational');
    expect(html).toContain('data-link-style="operational"');
    expect(html).toContain('WeatherMap: cor = utilização de cada sentido');
    expect(html).toContain('&lt;50% verde-sálvia');
    expect(html).toContain('50–79% âmbar');
    expect(html).toContain('≥80% coral');
    expect(html).toContain('data-op-band="normal"');
    expect(html).toContain('data-op-band="attention"');
    expect(html).toContain('data-op-band="critical"');
    expect(html).toContain('var(--wm-op-normal)');
    expect(html).toContain('var(--wm-op-critical)');
    expect(html).toContain('A→B (seta cheia)');
    expect(html).toContain('B→A (chevron)');
    // Nada de plaquetas "na cor do sentido" neste modo.
    expect(html).not.toContain('data-pill="normal"');
  });

  it('os estados especiais e a animação OFF aparecem nos dois modos', () => {
    for (const style of ['directional', 'operational'] as const) {
      const html = legend(style);
      expect(html).toContain('DOWN');
      expect(html).toContain('Sem dados');
      expect(html).toContain('Stale');
      expect(html).toContain('Inconsistente / parcial');
      expect(html).toContain('data-state="down"');
      expect(html).toContain('ANIMAÇÃO');
      expect(html).toContain('Desligada');
    }
  });

  it('sem escolha na aba vale o padrão: DIRECIONAL', () => {
    expect(legend(null)).toContain('data-link-style="directional"');
  });
});
