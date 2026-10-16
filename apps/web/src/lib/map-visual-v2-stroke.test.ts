import { describe, expect, it } from 'vitest';
import {
  LINK_V2_SCREEN_MAX_PX,
  LINK_V2_SCREEN_MIN_PX,
  LINK_V2_UNKNOWN_CAPACITY_WIDTH,
  linkV2ArrowScale,
  linkV2ScreenStrokeWidth,
  linkV2StrokeWidth,
  resolveLinkV2EdgeStroke,
  scaleStrokeDasharray,
  type LinkV2StrokeMode,
} from './map-visual-v2';

const G = 1_000_000_000;
const CAPACITIES: readonly (number | null)[] = [null, G, 10 * G, 40 * G, 100 * G];
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2.2] as const;
const MODES: readonly LinkV2StrokeMode[] = ['zoom', 'non-scaling', 'none'];

describe('espessura de enlace independente do zoom (Fase C)', () => {
  it('nenhuma classe de capacidade fica fora do clamp de tela', () => {
    for (const capacityBps of CAPACITIES) {
      const width = linkV2ScreenStrokeWidth(capacityBps);
      expect(width).toBeGreaterThanOrEqual(LINK_V2_SCREEN_MIN_PX);
      expect(width).toBeLessThanOrEqual(LINK_V2_SCREEN_MAX_PX);
    }
    expect(linkV2ScreenStrokeWidth(null)).toBe(LINK_V2_UNKNOWN_CAPACITY_WIDTH);
  });

  it('modo "none" reproduz exatamente a baseline da Fase B (sem compensação)', () => {
    for (const capacityBps of CAPACITIES) {
      const stroke = resolveLinkV2EdgeStroke({
        mode: 'none',
        capacityBps,
        dash: '6 4',
        zoom: 0.25,
      });
      expect(stroke.strokeWidth).toBe(linkV2StrokeWidth(capacityBps));
      expect(stroke.strokeDasharray).toBe('6 4');
      expect(stroke.nonScaling).toBe(false);
    }
  });

  it('modo "zoom" mantém a largura constante em pixels de tela', () => {
    for (const mode of ['zoom'] as const) {
      for (const capacityBps of CAPACITIES) {
        const target = linkV2ScreenStrokeWidth(capacityBps);
        for (const zoom of ZOOMS) {
          const stroke = resolveLinkV2EdgeStroke({ mode, capacityBps, dash: undefined, zoom });
          expect(stroke.strokeWidth * zoom).toBeCloseTo(target, 6);
          expect(stroke.nonScaling).toBe(false);
        }
      }
    }
  });

  it('modo "non-scaling" deixa o valor na largura de tela e liga o vector-effect', () => {
    const stroke = resolveLinkV2EdgeStroke({
      mode: 'non-scaling',
      capacityBps: 100 * G,
      dash: '6 4',
      zoom: 0.25,
    });
    expect(stroke.strokeWidth).toBe(linkV2ScreenStrokeWidth(100 * G));
    expect(stroke.strokeDasharray).toBe('6 4');
    expect(stroke.nonScaling).toBe(true);
  });

  it('zoom inválido cai para 1 sem gerar NaN/Infinity', () => {
    for (const zoom of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const stroke = resolveLinkV2EdgeStroke({ mode: 'zoom', capacityBps: 40 * G, dash: undefined, zoom });
      expect(Number.isFinite(stroke.strokeWidth)).toBe(true);
      expect(stroke.strokeWidth).toBe(linkV2ScreenStrokeWidth(40 * G));
    }
  });

  it('escala o tracejado junto com a espessura para o padrão ser o mesmo na tela', () => {
    expect(scaleStrokeDasharray('6 4', 4)).toBe('24 16');
    expect(scaleStrokeDasharray('6,4', 0.5)).toBe('3 2');
    expect(scaleStrokeDasharray('6 4', 1)).toBe('6 4');
  });

  it('preserva o tracejado original quando não há como escalar', () => {
    expect(scaleStrokeDasharray(undefined, 2)).toBeUndefined();
    expect(scaleStrokeDasharray('', 2)).toBe('');
    expect(scaleStrokeDasharray('6 4', 0)).toBe('6 4');
    expect(scaleStrokeDasharray('6 4', Number.NaN)).toBe('6 4');
    expect(scaleStrokeDasharray('none', 2)).toBe('none');
  });

  it('o dash escalado acompanha o fator 1/zoom do modo "zoom"', () => {
    const stroke = resolveLinkV2EdgeStroke({
      mode: 'zoom',
      capacityBps: 10 * G,
      dash: '6 4',
      zoom: 0.5,
    });
    expect(stroke.strokeDasharray).toBe('12 8');
  });
});

describe('escala da seta (Fase C)', () => {
  it('no modo baseline a seta continua escalando com o zoom (fator 1)', () => {
    for (const zoom of ZOOMS) {
      expect(linkV2ArrowScale('none', linkV2ScreenStrokeWidth(100 * G), zoom)).toBe(1);
    }
  });

  it('com compensação a seta acompanha 1/zoom e fica limitada a uma faixa útil', () => {
    const width = linkV2ScreenStrokeWidth(100 * G);
    const at100 = linkV2ArrowScale('zoom', width, 1);
    const at25 = linkV2ArrowScale('zoom', width, 0.25);
    const at220 = linkV2ArrowScale('zoom', width, 2.2);

    expect(at100).toBeCloseTo((8 + width) / 12, 6);
    expect(at25).toBeGreaterThan(at100);
    expect(at220).toBeLessThan(at100);
    for (const zoom of ZOOMS) {
      const scale = linkV2ArrowScale('zoom', width, zoom);
      expect(scale).toBeGreaterThanOrEqual(0.4);
      expect(scale).toBeLessThanOrEqual(5);
      expect(scale * zoom).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('seta e espessura usam o mesmo fator de compensação por modo', () => {
    for (const mode of MODES) {
      const scale = linkV2ArrowScale(mode, linkV2ScreenStrokeWidth(40 * G), 0.25);
      expect(mode === 'none' ? scale === 1 : scale !== 1).toBe(true);
    }
  });
});
