/**
 * Fase E — modelo do enlace bidirecional (WeatherMap moderno).
 *
 * Cobre direção por direção, unidades completas, bandas de utilização, estados
 * sem tráfego e a política da microanimação. Os dados vêm do MESMO adaptador do
 * mapa real (`resolveRealLinkV2`), então o teste protege o contrato de ponta.
 */

import { describe, expect, it } from 'vitest';
import { cloneDemoMaps, type NetworkLink } from '@gmj/shared';
import {
  formatLinkV2TrafficBps,
  resolveWeatherMap,
  shouldAnimateHalf,
  weatherHalfDash,
  weatherHalfLabelMode,
  weatherHalfText,
  weatherStreamStyle,
  weatherStrokeWidth,
  WEATHER_HALF_COLOR_VAR,
  type WeatherLabelContext,
} from './map-visual-v2-weathermap';
import { resolveRealLinkV2 } from './map-visual-v2-link';
import type { LinkV2Visual } from './map-visual-v2';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const FRESH = new Date(NOW - 30_000).toISOString();
const G = 1_000_000_000;
const baseLink = cloneDemoMaps()[0]!.links[0]!;

function link(overrides: Partial<NetworkLink> = {}): NetworkLink {
  return {
    ...structuredClone(baseLink),
    capacityBps: 100 * G,
    status: 'UP',
    trafficMode: 'BIDIRECTIONAL',
    sourceInterfaceId: 'if-a',
    targetInterfaceId: 'if-b',
    directions: {
      A_TO_B: {
        bps: 62 * G,
        utilization: 62,
        txBps: null,
        observedRxBps: null,
        deltaPercent: null,
        consistency: 'CONSISTENT',
      },
      B_TO_A: {
        bps: 41 * G,
        utilization: 41,
        txBps: null,
        observedRxBps: null,
        deltaPercent: null,
        consistency: 'CONSISTENT',
      },
    },
    ...overrides,
  };
}

function visualOf(
  target: NetworkLink,
  context: { collectionStamp: string | null } = { collectionStamp: FRESH },
): LinkV2Visual {
  return resolveRealLinkV2(target, { nowMs: NOW, collectionStamp: context.collectionStamp });
}

const NO_FOCUS: WeatherLabelContext = {
  showAll: false,
  selected: false,
  hovered: false,
  adjacentToSelectedNode: false,
};

describe('unidades completas (bps, Kbps, Mbps, Gbps, Tbps)', () => {
  it('usa a unidade completa sem "G"/"M" solto', () => {
    expect(formatLinkV2TrafficBps(38 * G)).toBe('38 Gbps');
    expect(formatLinkV2TrafficBps(3.2 * G)).toBe('3.2 Gbps');
    expect(formatLinkV2TrafficBps(650 * 1_000_000)).toBe('650 Mbps');
    expect(formatLinkV2TrafficBps(25 * 1_000_000)).toBe('25 Mbps');
    expect(formatLinkV2TrafficBps(845_000)).toBe('845 Kbps');
    expect(formatLinkV2TrafficBps(27.4 * G)).toBe('27.4 Gbps');
    expect(formatLinkV2TrafficBps(985 * 1_000_000)).toBe('985 Mbps');
    expect(formatLinkV2TrafficBps(12.5 * 1_000_000)).toBe('12.5 Mbps');
    expect(formatLinkV2TrafficBps(2.5e12)).toBe('2.5 Tbps');
    expect(formatLinkV2TrafficBps(0)).toBe('0 bps');
  });

  it('nunca converte bits em bytes nem inventa valor', () => {
    const texts = [
      formatLinkV2TrafficBps(8 * G),
      formatLinkV2TrafficBps(1_000_000),
      formatLinkV2TrafficBps(999),
    ].join(' | ');
    expect(texts).not.toMatch(/B\/s|bytes|Byte/i);
    expect(formatLinkV2TrafficBps(8 * G)).toBe('8 Gbps');
    expect(formatLinkV2TrafficBps(null)).toBeNull();
    expect(formatLinkV2TrafficBps(Number.NaN)).toBeNull();
    expect(formatLinkV2TrafficBps(-1)).toBeNull();
  });

  it('não arredonda tráfego baixo para zero na unidade maior', () => {
    // 999.999.999 bps arredondaria para "1000 Mbps" — sobe para 1 Gbps.
    expect(formatLinkV2TrafficBps(999_999_999)).toBe('1 Gbps');
    expect(formatLinkV2TrafficBps(999_999)).toBe('1 Mbps');
    expect(formatLinkV2TrafficBps(1_500)).toBe('1.5 Kbps');
  });
});

describe('duas direções', () => {
  it('cada metade mostra o tráfego do seu sentido', () => {
    const weather = resolveWeatherMap(visualOf(link()));
    expect(weather.a2b.bps).toBe(62 * G);
    expect(weather.a2b.percent).toBeCloseTo(62, 5);
    expect(weather.b2a.bps).toBe(41 * G);
    expect(weather.b2a.percent).toBeCloseTo(41, 5);
    expect(weather.a2b.label).toBe('62 Gbps · 62%');
    expect(weather.b2a.label).toBe('41 Gbps · 41%');
  });

  it('a direção A→B é a ponta A e B→A é a ponta B (sem somar TX+RX)', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 10 * G, utilization: 10, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 90 * G, utilization: 90, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    expect(weather.a2b.bps).toBe(10 * G);
    expect(weather.b2a.bps).toBe(90 * G);
    // Nunca a soma dos dois sentidos.
    expect(weather.a2b.bps! + weather.b2a.bps!).toBe(100 * G);
    expect(weather.a2b.percent).toBeLessThan(weather.b2a.percent!);
  });

  it('cores independentes: crítico de um lado, normal do outro', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 94 * G, utilization: 94, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    expect(weather.a2b.state).toBe('normal');
    expect(weather.b2a.state).toBe('critical');
    expect(weather.a2b.color).toBe(WEATHER_HALF_COLOR_VAR.normal);
    expect(weather.b2a.color).toBe(WEATHER_HALF_COLOR_VAR.critical);
    expect(weather.a2b.color).not.toBe(weather.b2a.color);
    // O enlace NÃO é pintado inteiro de vermelho.
    expect(weather.a2b.color).not.toBe(WEATHER_HALF_COLOR_VAR.critical);
  });

  it('faixas 50/80 valem por sentido', () => {
    const cases: Array<[number, string]> = [
      [0, 'normal'],
      [49, 'normal'],
      [50, 'attention'],
      [79, 'attention'],
      [80, 'critical'],
      [100, 'critical'],
    ];
    for (const [percent, expected] of cases) {
      const weather = resolveWeatherMap(
        visualOf(
          link({
            directions: {
              A_TO_B: { bps: (percent / 100) * 100 * G, utilization: percent, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
              B_TO_A: { bps: 1 * G, utilization: 1, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            },
          }),
        ),
      );
      expect(weather.a2b.state).toBe(expected);
      expect(weather.b2a.state).toBe('normal');
    }
  });

  it('espessura é a mesma nas duas metades (capacidade, não tráfego)', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 1 * G, utilization: 1, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 99 * G, utilization: 99, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    expect(weatherStrokeWidth(100 * G)).toBe(4.5);
    expect(weatherStrokeWidth(100 * G)).toBe(weatherStrokeWidth(100 * G));
    expect(weatherStrokeWidth(null)).toBe(1.6);
    // As duas metades nunca recebem largura própria: o renderer usa `strokeWidth`
    // do enlace para ambas (ver teste de renderer).
    expect(Object.keys(weather.a2b)).not.toContain('strokeWidth');
    expect(Object.keys(weather.b2a)).not.toContain('strokeWidth');
  });
});

describe('sentido sem evidência', () => {
  it('só A→B tem amostra: a outra metade fica como desconhecida, sem seta', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          trafficMode: 'SINGLE_ENDED',
          sourceInterfaceId: 'if-a',
          targetInterfaceId: null,
          directions: {
            A_TO_B: { bps: 20 * G, utilization: 20, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 0, utilization: 0, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
          },
        }),
      ),
    );
    expect(weather.a2b.valid).toBe(true);
    expect(weather.a2b.arrow).toBe(true);
    expect(weather.b2a.state).toBe('unknown');
    expect(weather.b2a.valid).toBe(false);
    expect(weather.b2a.arrow).toBe(false);
    expect(weather.b2a.label).toBe('sem dados');
    expect(weather.b2a.animated).toBe(false);
    expect(weather.partial).toBe(true);
  });

  it('nenhum sentido tem amostra: SEM DADOS, sem setas e sem animação', () => {
    const weather = resolveWeatherMap(visualOf(link(), { collectionStamp: null }));
    expect(weather.state).toBe('no-data');
    expect(weather.stateLabel).toBe('SEM DADOS');
    expect(weather.a2b.state).toBe('no-data');
    expect(weather.b2a.state).toBe('no-data');
    expect(weather.a2b.arrow || weather.b2a.arrow).toBe(false);
    expect(weather.animated).toBe(false);
    expect(weather.a2b.dashed).toBe(true);
    expect(weatherHalfDash(weather.a2b)).toBeTruthy();
  });

  it('telemetria antiga não vira tráfego válido', () => {
    const old = new Date(NOW - 30 * 60_000).toISOString();
    const weather = resolveWeatherMap(visualOf(link(), { collectionStamp: old }));
    expect(weather.state).toBe('stale');
    expect(weather.stateLabel).toBe('DADOS ANTIGOS');
    expect(weather.a2b.animated || weather.b2a.animated).toBe(false);
    expect(weather.a2b.arrow || weather.b2a.arrow).toBe(false);
    // O último valor conhecido continua visível, marcado como antigo.
    expect(weather.a2b.label).toContain('antigo');
  });

  it('DOWN prevalece sobre a utilização e não anima', () => {
    const weather = resolveWeatherMap(visualOf(link({ status: 'DOWN' })));
    expect(weather.state).toBe('down');
    expect(weather.stateLabel).toBe('DOWN');
    expect(weather.a2b.state).toBe('down');
    expect(weather.b2a.state).toBe('down');
    expect(weather.a2b.animated).toBe(false);
    expect(weather.b2a.animated).toBe(false);
    expect(weather.a2b.arrow).toBe(false);
    // Nada de tráfego inventado.
    expect(weather.a2b.label).toBeNull();
  });

  it('inconsistente não é pintado como normal', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 5 * G, utilization: 5, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'DIVERGENT' },
            B_TO_A: { bps: 4 * G, utilization: 4, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'DIVERGENT' },
          },
        }),
      ),
    );
    expect(weather.state).toBe('inconsistent');
    expect(weather.a2b.state).toBe('inconsistent');
    expect(weather.a2b.color).toBe(WEATHER_HALF_COLOR_VAR.inconsistent);
    expect(weather.a2b.label).toContain('inconsistente');
    expect(weather.a2b.animated).toBe(false);
  });
});

describe('microanimação', () => {
  it('desligada: nenhuma metade anima', () => {
    const weather = resolveWeatherMap(visualOf(link()), { animation: 'off' });
    expect(weather.animated).toBe(false);
  });

  it('inteligente: anima atenção, crítico, seleção e hover', () => {
    expect(shouldAnimateHalf('attention', 'smart', { selected: false, hovered: false })).toBe(true);
    expect(shouldAnimateHalf('critical', 'smart', { selected: false, hovered: false })).toBe(true);
    expect(shouldAnimateHalf('normal', 'smart', { selected: true, hovered: false })).toBe(true);
    expect(shouldAnimateHalf('normal', 'smart', { selected: false, hovered: true })).toBe(true);
    expect(shouldAnimateHalf('normal', 'smart', { selected: false, hovered: false })).toBe(false);
    expect(shouldAnimateHalf('down', 'smart', { selected: true, hovered: true })).toBe(false);
    expect(shouldAnimateHalf('stale', 'smart', { selected: true, hovered: true })).toBe(false);
    expect(shouldAnimateHalf('no-data', 'smart', { selected: true, hovered: true })).toBe(false);
  });

  it('sempre ativa: anima todo sentido com telemetria, mas nunca DOWN/sem dados', () => {
    expect(shouldAnimateHalf('normal', 'always', { selected: false, hovered: false })).toBe(true);
    expect(shouldAnimateHalf('down', 'always', { selected: false, hovered: false })).toBe(false);
    expect(shouldAnimateHalf('no-data', 'always', { selected: false, hovered: false })).toBe(false);
    expect(shouldAnimateHalf('unknown', 'always', { selected: false, hovered: false })).toBe(false);
  });

  it('no modo inteligente um enlace saudável fica estático, mas selecionado anima', () => {
    const healthy = visualOf(
      link({
        directions: {
          A_TO_B: { bps: 10 * G, utilization: 10, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          B_TO_A: { bps: 12 * G, utilization: 12, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
        },
      }),
    );
    expect(resolveWeatherMap(healthy, { animation: 'smart' }).animated).toBe(false);
    expect(resolveWeatherMap(healthy, { animation: 'smart', selected: true }).animated).toBe(true);
    expect(resolveWeatherMap(healthy, { animation: 'always' }).animated).toBe(true);
  });

  it('o stream é discreto, com período limitado e travessia de ~5 s', () => {
    const style = weatherStreamStyle(300, 1);
    expect(style.period).toBeGreaterThanOrEqual(22);
    expect(style.period).toBeLessThanOrEqual(68);
    expect(style.dashArray.split(' ')).toHaveLength(2);
    // A duração é a de UM período no loop contínuo (sem salto).
    expect(style.durationSeconds).toBeGreaterThan(0.5);
    expect(style.durationSeconds).toBeLessThanOrEqual(3);
    // Velocidade percebida constante: período/duração ≈ metade/5 s.
    expect(style.period / style.durationSeconds).toBeCloseTo(300 / 5, 0);
  });

  it('compensa o zoom mantendo o padrão dentro da faixa de tela', () => {
    // Sem clamp o período encolheria junto com o zoom; na faixa útil ele é o
    // mesmo em PIXELS DE TELA (22 a 68 px), como a espessura do traço.
    const at1 = weatherStreamStyle(300, 1);
    const inRange = weatherStreamStyle(1200, 2);
    expect(at1.period).toBeGreaterThanOrEqual(22);
    expect(at1.period).toBeLessThanOrEqual(68);
    expect(inRange.period * 2).toBeGreaterThanOrEqual(22);
    expect(inRange.period * 2).toBeLessThanOrEqual(68);
    // Num enlace curto, o período respeita o mínimo de tela (nunca vira "poeira").
    const short = weatherStreamStyle(40, 1);
    expect(short.period).toBe(22);
    expect(short.dashArray).toBe('7.04 14.96');
  });
});

describe('política de rótulo', () => {
  it('enlace saudável abaixo de 50% não mostra valor permanente', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 8 * G, utilization: 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 6 * G, utilization: 6, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    expect(weatherHalfLabelMode(weather.a2b, NO_FOCUS)).toBe('hidden');
    expect(weatherHalfLabelMode(weather.b2a, NO_FOCUS)).toBe('hidden');
    expect(weatherHalfText(weather.a2b, 'hidden')).toBeNull();
  });

  it('uma direção acima de 50% mostra só o lado relevante', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 3 * G, utilization: 3, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 94 * G, utilization: 94, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    expect(weatherHalfLabelMode(weather.b2a, NO_FOCUS)).toBe('full');
    expect(weatherHalfLabelMode(weather.a2b, NO_FOCUS)).toBe('hidden');
    expect(weatherHalfText(weather.b2a, 'full')).toBe('94 Gbps · 94%');
  });

  it('hover/seleção/nó adjacente mostram os dois sentidos', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 8 * G, utilization: 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 6 * G, utilization: 6, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    for (const context of [
      { ...NO_FOCUS, hovered: true },
      { ...NO_FOCUS, selected: true },
      { ...NO_FOCUS, adjacentToSelectedNode: true },
      { ...NO_FOCUS, showAll: true },
    ]) {
      expect(weatherHalfLabelMode(weather.a2b, context)).toBe('full');
      expect(weatherHalfLabelMode(weather.b2a, context)).toBe('full');
    }
    expect(weatherHalfText(weather.a2b, 'full')).toBe('8 Gbps · 8%');
  });

  it('estado sem tráfego usa rótulo único, nunca valor inventado', () => {
    const down = resolveWeatherMap(visualOf(link({ status: 'DOWN' })));
    expect(down.stateLabel).toBe('DOWN');
    expect(down.a2b.label).toBeNull();
    expect(down.b2a.label).toBeNull();
  });
});
