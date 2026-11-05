import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROWTH_THRESHOLDS,
  FastGrowthTracker,
  classifyGrowth,
} from './fast-growth-analysis';

const IF = 'sim-if-1';
const STEP = 5_000;
const T0 = 1_760_000_000_000;

/** Alimenta n amostras com utilidades dadas (5 s de passo). */
function feed(tracker: FastGrowthTracker, values: number[], startMs = T0): number {
  let at = startMs;
  for (const value of values) {
    tracker.record(IF, at, value);
    at += STEP;
  }
  return at - STEP;
}

describe('classificacao de crescimento (informativa)', () => {
  it('limites: 30+ BRUSCO, 10..29 MODERADO, <10 GRADUAL', () => {
    expect(classifyGrowth(45)).toBe('BRUSCO');
    expect(classifyGrowth(30)).toBe('BRUSCO');
    expect(classifyGrowth(29.9)).toBe('MODERADO');
    expect(classifyGrowth(10)).toBe('MODERADO');
    expect(classifyGrowth(9.9)).toBe('GRADUAL_OU_ESTAVEL');
    expect(classifyGrowth(-80)).toBe('GRADUAL_OU_ESTAVEL');
    expect(classifyGrowth(null)).toBe('INDETERMINADO');
    expect(classifyGrowth(Number.NaN)).toBe('INDETERMINADO');
    expect(DEFAULT_GROWTH_THRESHOLDS).toEqual({ sudden: 30, moderate: 10 });
  });

  it('subida BRUSCA de 20% para 95%', () => {
    const tracker = new FastGrowthTracker();
    let at = T0;
    for (let i = 0; i < 12; i += 1) tracker.record(IF, (at += STEP), 20);
    // amostra de ~30 s atras (20%) e a atual (95%)
    tracker.record(IF, at + 35_000, 95);
    const analysis = tracker.analyze(IF, DEFAULT_GROWTH_THRESHOLDS, at + 35_000);
    expect(analysis.currentUtilizationPct).toBe(95);
    expect(analysis.baselineAverage5mPct).toBe(20);
    expect(analysis.deltaPercentagePoints).toBe(75);
    expect(analysis.growthClassification).toBe('BRUSCO');
  });

  it('subida MODERADA (15 pontos em 30 s)', () => {
    const tracker = new FastGrowthTracker();
    const at = feed(tracker, [80, 80, 80, 80, 80, 80, 80]);
    tracker.record(IF, at + 35_000, 95);
    const analysis = tracker.analyze(IF, DEFAULT_GROWTH_THRESHOLDS, at + 35_000);
    expect(analysis.delta30sPercentagePoints).toBe(15);
    expect(analysis.growthClassification).toBe('MODERADO');
  });

  it('subida GRADUAL (5 pontos em 30 s)', () => {
    const tracker = new FastGrowthTracker();
    const at = feed(tracker, [88, 89, 90, 90, 90, 90, 90]);
    tracker.record(IF, at + 35_000, 95);
    const analysis = tracker.analyze(IF, DEFAULT_GROWTH_THRESHOLDS, at + 35_000);
    expect(analysis.delta30sPercentagePoints).toBe(5);
    expect(analysis.growthClassification).toBe('GRADUAL_OU_ESTAVEL');
  });

  it('historico insuficiente vira INDETERMINADO sem inventar valor', () => {
    const tracker = new FastGrowthTracker();
    tracker.record(IF, T0, 95);
    const analysis = tracker.analyze(IF, DEFAULT_GROWTH_THRESHOLDS, T0);
    expect(analysis.growthClassification).toBe('INDETERMINADO');
    expect(analysis.baselineAverage5mPct).toBeNull();
    expect(analysis.deltaPercentagePoints).toBeNull();
    expect(analysis.delta30sPercentagePoints).toBeNull();
    expect(analysis.samples5m).toBe(1);
  });

  it('amostras invalidas (null) nao entram na media nem na variacao', () => {
    const tracker = new FastGrowthTracker();
    let at = T0;
    for (const value of [20, null, 20, null, 20]) {
      tracker.record(IF, (at += STEP), value);
    }
    tracker.record(IF, at + 35_000, 60);
    const analysis = tracker.analyze(IF, DEFAULT_GROWTH_THRESHOLDS, at + 35_000);
    expect(analysis.baselineAverage5mPct).toBe(20);
    expect(analysis.samples5m).toBe(3);
  });

  it('buffer circular mantem no maximo 60 amostras', () => {
    const tracker = new FastGrowthTracker();
    let at = T0;
    for (let i = 0; i < 100; i += 1) tracker.record(IF, (at += STEP), 10);
    expect(tracker.size(IF)).toBe(60);
  });

  it('congela a referencia no primeiro disparo (nao contamina com o pos-disparo)', () => {
    const tracker = new FastGrowthTracker();
    let at = T0;
    for (let i = 0; i < 12; i += 1) tracker.record(IF, (at += STEP), 20);
    tracker.record(IF, at + 35_000, 95);
    const frozen = tracker.freezeAtThreshold(IF, DEFAULT_GROWTH_THRESHOLDS, at + 35_000);
    expect(frozen.frozen).toBe(true);
    expect(frozen.baselineAverage5mPct).toBe(20);
    // Amostras posteriores mudam a analise corrente, mas NAO o congelado.
    tracker.record(IF, at + 40_000, 99);
    tracker.record(IF, at + 45_000, 100);
    expect(tracker.analyze(IF, DEFAULT_GROWTH_THRESHOLDS, at + 45_000).currentUtilizationPct).toBe(100);
    expect(tracker.frozenAnalysis(IF)!.currentUtilizationPct).toBe(95);
    expect(tracker.freezeAtThreshold(IF).currentUtilizationPct).toBe(95);
  });

  it('isolamento: buffers sao por interface', () => {
    const tracker = new FastGrowthTracker();
    let at = T0;
    for (let i = 0; i < 5; i += 1) tracker.record('a', (at += STEP), 10);
    tracker.record('b', at, 90);
    expect(tracker.analyze('a', DEFAULT_GROWTH_THRESHOLDS, at).baselineAverage5mPct).toBe(10);
    expect(tracker.analyze('b', DEFAULT_GROWTH_THRESHOLDS, at).growthClassification).toBe(
      'INDETERMINADO',
    );
    tracker.clearFreeze('a');
    tracker.reset();
    expect(tracker.size('a')).toBe(0);
  });
});
