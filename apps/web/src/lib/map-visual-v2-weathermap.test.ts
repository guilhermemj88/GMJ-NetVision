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
  weatherArrowShape,
  weatherCenterGap,
  weatherHalfDash,
  weatherHalfLabelMode,
  weatherHalfText,
  weatherPillColorVar,
  weatherRunnerCount,
  weatherRunnerDuration,
  weatherStreamStyle,
  weatherStrokeWidth,
  WEATHER_CENTER_GAP_MAX_HALF_SHARE,
  WEATHER_CENTER_GAP_PX,
  WEATHER_DIRECTION_COLOR_VAR,
  WEATHER_HALF_COLOR_VAR,
  WEATHER_PILL_LANE_OFFSET,
  WEATHER_PILL_MIN_ZOOM,
  WEATHER_PILL_NORMAL_MIN_ZOOM,
  WEATHER_RUNNER_MAX,
  type WeatherLabelContext,
} from './map-visual-v2-weathermap';
import { resolveRealLinkV2 } from './map-visual-v2-link';
import type { LinkV2Visual } from './map-visual-v2';
import {
  WEATHER_OPERATIONAL_COLOR_VAR,
  WEATHER_OPERATIONAL_TEXT_VAR,
  WEATHER_PILL_FONT_SIZE,
  WEATHER_PILL_FONT_SIZE_COMPACT,
  WEATHER_PILL_FONT_SIZE_SMALL,
  WEATHER_PILL_HEIGHT,
  WEATHER_PILL_HEIGHT_COMPACT,
  WEATHER_PILL_HEIGHT_SMALL,
  isLinkV2StyleMode,
  weatherBandOfState,
  weatherHalfStyle,
  weatherOperationalColorVar,
  weatherStateStyleColor,
  type WeatherHalf,
  type WeatherHalfState,
} from './map-visual-v2-weathermap';

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

  it('faixas independentes: crítico de um lado, normal do outro (Fase G)', () => {
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
    // O traço continua na cor fixa da direção dos DOIS lados...
    expect(weather.a2b.color).toBe(WEATHER_DIRECTION_COLOR_VAR.a2b);
    expect(weather.b2a.color).toBe(WEATHER_DIRECTION_COLOR_VAR.b2a);
    // ...o enlace NÃO é pintado inteiro de vermelho e a utilização só muda a plaqueta.
    expect(weather.a2b.pillColor).toBe(WEATHER_DIRECTION_COLOR_VAR.a2b);
    expect(weather.b2a.pillColor).toBe(WEATHER_HALF_COLOR_VAR.critical);
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
              // Origem declarada (TX da ponta A): distingue 0% medido de "sem medição".
              A_TO_B: { bps: (percent / 100) * 100 * G, utilization: percent, txBps: (percent / 100) * 100 * G, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
              B_TO_A: { bps: 1 * G, utilization: 1, txBps: 1 * G, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
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

describe('cores fixas de direção e plaquetas de utilização (Fase G)', () => {
  const directions = (aPercent: number, bPercent: number) => ({
    A_TO_B: {
      bps: (aPercent / 100) * 100 * G,
      utilization: aPercent,
      txBps: null,
      observedRxBps: null,
      deltaPercent: null,
      consistency: 'CONSISTENT' as const,
    },
    B_TO_A: {
      bps: (bPercent / 100) * 100 * G,
      utilization: bPercent,
      txBps: null,
      observedRxBps: null,
      deltaPercent: null,
      consistency: 'CONSISTENT' as const,
    },
  });

  it('A→B é sempre ciano com 8%, 62% e 94% de utilização', () => {
    for (const percent of [8, 62, 94]) {
      const weather = resolveWeatherMap(visualOf(link({ directions: directions(percent, 10) })));
      expect(weather.a2b.color).toBe(WEATHER_DIRECTION_COLOR_VAR.a2b);
      expect(weather.a2b.color).toBe('var(--wm-dir-a2b)');
    }
  });

  it('B→A é sempre roxa com 5%, 75% e 99% de utilização', () => {
    for (const percent of [5, 75, 99]) {
      const weather = resolveWeatherMap(visualOf(link({ directions: directions(10, percent) })));
      expect(weather.b2a.color).toBe(WEATHER_DIRECTION_COLOR_VAR.b2a);
      expect(weather.b2a.color).toBe('var(--wm-dir-b2a)');
    }
  });

  it('a plaqueta passa de direção para âmbar em 50% e para coral em 80%', () => {
    expect(weatherPillColorVar('a2b', 'normal')).toBe('var(--wm-dir-a2b)');
    expect(weatherPillColorVar('b2a', 'normal')).toBe('var(--wm-dir-b2a)');
    expect(weatherPillColorVar('a2b', 'attention')).toBe('var(--wm-util-attention)');
    expect(weatherPillColorVar('b2a', 'attention')).toBe('var(--wm-util-attention)');
    expect(weatherPillColorVar('a2b', 'critical')).toBe('var(--wm-util-critical)');

    const below = resolveWeatherMap(visualOf(link({ directions: directions(49, 49) })));
    expect(below.a2b.band).toBe('normal');
    expect(below.a2b.pillColor).toBe('var(--wm-dir-a2b)');

    const at50 = resolveWeatherMap(visualOf(link({ directions: directions(50, 50) })));
    expect(at50.a2b.band).toBe('attention');
    expect(at50.a2b.pillColor).toBe('var(--wm-util-attention)');

    const at79 = resolveWeatherMap(visualOf(link({ directions: directions(79, 79) })));
    expect(at79.b2a.band).toBe('attention');

    const at80 = resolveWeatherMap(visualOf(link({ directions: directions(80, 80) })));
    expect(at80.b2a.band).toBe('critical');
    expect(at80.b2a.pillColor).toBe('var(--wm-util-critical)');
  });

  it('a utilização muda SOMENTE a plaqueta — o traço continua na cor da direção', () => {
    const low = resolveWeatherMap(visualOf(link({ directions: directions(8, 5) })));
    const high = resolveWeatherMap(visualOf(link({ directions: directions(94, 99) })));
    expect(low.a2b.color).toBe(high.a2b.color);
    expect(low.b2a.color).toBe(high.b2a.color);
    expect(low.a2b.pillColor).not.toBe(high.a2b.pillColor);
    // Nem a espessura reage à utilização: ela é da capacidade.
    expect(low.strokeWidth).toBe(high.strokeWidth);
  });

  it('cores especiais aparecem apenas nos estados operacionais previstos', () => {
    const down = resolveWeatherMap(visualOf(link({ status: 'DOWN' })));
    expect(down.a2b.color).toBe(WEATHER_HALF_COLOR_VAR.down);
    expect(down.b2a.color).toBe(WEATHER_HALF_COLOR_VAR.down);
    expect(down.a2b.pillColor).toBe(WEATHER_HALF_COLOR_VAR.down);

    const noData = resolveWeatherMap(visualOf(link(), { collectionStamp: null }));
    expect(noData.a2b.color).toBe(WEATHER_HALF_COLOR_VAR['no-data']);
    expect(noData.a2b.color).not.toBe(WEATHER_DIRECTION_COLOR_VAR.a2b);

    const stale = resolveWeatherMap(
      visualOf(link(), { collectionStamp: new Date(NOW - 30 * 60_000).toISOString() }),
    );
    expect(stale.a2b.color).toBe(WEATHER_HALF_COLOR_VAR.stale);

    const inconsistent = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 5 * G, utilization: 5, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'DIVERGENT' },
            B_TO_A: { bps: 4 * G, utilization: 4, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'DIVERGENT' },
          },
        }),
      ),
    );
    expect(inconsistent.a2b.color).toBe(WEATHER_HALF_COLOR_VAR.inconsistent);
  });
});

describe('diferenciação dos sentidos e leitura do centro', () => {
  it('a forma da seta reforça a direção sem depender da cor', () => {
    expect(weatherArrowShape('a2b')).toBe('solid');
    expect(weatherArrowShape('b2a')).toBe('chevron');
  });

  it('a plaqueta é embutida na linha (offset zero como candidato preferido)', () => {
    expect(WEATHER_PILL_LANE_OFFSET).toBe(0);
  });

  it('o vão central é explícito e limitado em enlaces curtos', () => {
    const at1 = weatherCenterGap(1, 150);
    expect(at1.units).toBeCloseTo(WEATHER_CENTER_GAP_PX, 5);
    // Mais zoom = mesmo vão na TELA (unidades de fluxo menores).
    expect(weatherCenterGap(2, 150).units).toBeCloseTo(WEATHER_CENTER_GAP_PX / 2, 5);
    // Enlace curto: o vão encolhe para não engolir as metades.
    expect(weatherCenterGap(1, 12).units).toBeLessThan(12 * 2 * WEATHER_CENTER_GAP_MAX_HALF_SHARE + 0.001);
  });

  it('as setas móveis respeitam zoom, tamanho do enlace e velocidade', () => {
    expect(weatherRunnerCount(0.3, 200)).toBe(0);
    expect(weatherRunnerCount(0.6, 30)).toBe(0);
    expect(weatherRunnerCount(0.6, 200)).toBe(2);
    expect(weatherRunnerCount(1, 120)).toBe(2);
    expect(weatherRunnerCount(2, 200)).toBe(WEATHER_RUNNER_MAX);
    const short = weatherRunnerDuration(80, 1);
    const long = weatherRunnerDuration(400, 1);
    expect(short).toBeGreaterThanOrEqual(2.6);
    expect(long).toBeLessThanOrEqual(6.5);
    expect(long).toBeGreaterThan(short);
  });
});

describe('microanimação', () => {
  it('Fase I: sem modo explícito a animação fica DESLIGADA', () => {
    const weather = resolveWeatherMap(visualOf(link()));
    expect(weather.animated).toBe(false);
    expect(weather.a2b.animated).toBe(false);
    expect(weather.b2a.animated).toBe(false);
  });

  it('Fase I: hover e seleção NÃO animam quando o modo está Desligada', () => {
    expect(shouldAnimateHalf('attention', 'off', { selected: true, hovered: true })).toBe(false);
    expect(shouldAnimateHalf('critical', 'off', { selected: true, hovered: true })).toBe(false);
    expect(shouldAnimateHalf('normal', 'off', { selected: true, hovered: true })).toBe(false);
    const weather = resolveWeatherMap(visualOf(link()), {
      animation: 'off',
      selected: true,
      hovered: true,
    });
    expect(weather.animated).toBe(false);
    // O desenho continua completo: setas e valores nos dois sentidos.
    expect(weather.a2b.arrow && weather.b2a.arrow).toBe(true);
    expect(weather.a2b.label).not.toBeNull();
    expect(weather.b2a.label).not.toBeNull();
  });

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

describe('política de rótulo (Fase G: plaquetas permanentes)', () => {
  const healthy = () =>
    resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 8 * G, utilization: 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 6 * G, utilization: 6, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );

  it('enlace saudável abaixo de 50% MOSTRA os dois valores sem hover', () => {
    const weather = healthy();
    expect(weatherHalfLabelMode(weather.a2b, NO_FOCUS, 1)).toBe('full');
    expect(weatherHalfLabelMode(weather.b2a, NO_FOCUS, 1)).toBe('full');
    expect(weatherHalfText(weather.a2b, 'full')).toBe('8 Gbps · 8%');
    expect(weatherHalfText(weather.b2a, 'full')).toBe('6 Gbps · 6%');
  });

  it('no zoom operacional reduzido as plaquetas normais continuam visíveis', () => {
    const weather = healthy();
    expect(WEATHER_PILL_NORMAL_MIN_ZOOM).toBeLessThanOrEqual(0.5);
    expect(weatherHalfLabelMode(weather.a2b, NO_FOCUS, 0.5)).toBe('full');
    expect(weatherHalfLabelMode(weather.a2b, NO_FOCUS, 0.83)).toBe('full');
  });

  it('a degradação em zoom extremo é determinística e documentada', () => {
    const weather = healthy();
    // Abaixo do limite da plaqueta normal: some só o sentido saudável.
    expect(weatherHalfLabelMode(weather.a2b, NO_FOCUS, WEATHER_PILL_NORMAL_MIN_ZOOM - 0.01)).toBe('hidden');
    // Atenção/crítico seguem legíveis mesmo em zoom extremo.
    const attention = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 62 * G, utilization: 62, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 94 * G, utilization: 94, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    expect(weatherHalfLabelMode(attention.a2b, NO_FOCUS, 0.2)).toBe('full');
    expect(weatherHalfLabelMode(attention.b2a, NO_FOCUS, 0.2)).toBe('full');
    // Estado anômalo degrada para compacto (nunca desaparece).
    const stale = resolveWeatherMap(
      visualOf(link(), { collectionStamp: new Date(NOW - 30 * 60_000).toISOString() }),
    );
    expect(weatherHalfLabelMode(stale.a2b, NO_FOCUS, WEATHER_PILL_MIN_ZOOM - 0.01)).toBe('compact');
    expect(weatherHalfLabelMode(stale.a2b, NO_FOCUS, 1)).toBe('full');
  });

  it('hover/seleção/nó adjacente promovem as duas plaquetas', () => {
    const weather = healthy();
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

/**
 * FASE M — experimento A/B de estilo dos enlaces (preview).
 *
 * O estilo é aplicado DEPOIS do modelo: `weatherHalfStyle` só devolve cores, de
 * modo que posições, rótulos e anticolisão continuam idênticos nos dois modos.
 */
describe('Fase M — estilo dos enlaces: DIRECIONAL x OPERACIONAL', () => {
  const dir = (percent: number, bps = (percent / 100) * 100 * G) => ({
    bps,
    utilization: percent,
    txBps: null,
    observedRxBps: null,
    deltaPercent: null,
    consistency: 'CONSISTENT' as const,
  });
  const directions = (a: number, b: number) => ({
    A_TO_B: dir(a),
    B_TO_A: dir(b),
  });
  const weatherAt = (a: number, b: number, overrides: Partial<NetworkLink> = {}) =>
    resolveWeatherMap(visualOf(link({ directions: directions(a, b), ...overrides })));

  const STYLE_MODES = ['directional', 'operational'] as const;

  it('1. o modo DIRECIONAL é byte a byte a Fase L (traço/seta na direção, plaqueta na utilização)', () => {
    const weather = weatherAt(30, 30);
    for (const mode of STYLE_MODES) {
      const style = weatherHalfStyle(weather.a2b, mode);
      if (mode === 'directional') {
        expect(style.stroke).toBe(weather.a2b.color);
        expect(style.stroke).toBe(WEATHER_DIRECTION_COLOR_VAR.a2b);
        expect(style.pillBorder).toBe(weather.a2b.pillColor);
        expect(style.pillText).toBeNull();
      }
      expect(style.pillBorder).toBe(mode === 'directional' ? 'var(--wm-dir-a2b)' : 'var(--wm-op-normal)');
    }
    // Atenção/crítico no modo direcional continuam âmbar/coral na plaqueta.
    const high = weatherAt(94, 94);
    expect(weatherHalfStyle(high.a2b, 'directional')).toEqual({
      stroke: 'var(--wm-dir-a2b)',
      pillBorder: WEATHER_HALF_COLOR_VAR.critical,
      pillText: null,
    });
  });

  it('2. OPERACIONAL normal: verde-sálvia na linha, na seta e na borda, texto branco suave', () => {
    const weather = weatherAt(12, 12);
    const style = weatherHalfStyle(weather.a2b, 'operational');
    expect(style.stroke).toBe('var(--wm-op-normal)');
    expect(style.pillBorder).toBe(style.stroke);
    expect(style.pillText).toBe(WEATHER_OPERATIONAL_TEXT_VAR);
    expect(WEATHER_OPERATIONAL_COLOR_VAR.normal).toBe('var(--wm-op-normal)');
  });

  it('3. OPERACIONAL atenção: âmbar fosco com o mesmo valor de leitura', () => {
    const weather = weatherAt(62, 41);
    const style = weatherHalfStyle(weather.a2b, 'operational');
    expect(weather.a2b.band).toBe('attention');
    expect(style.stroke).toBe('var(--wm-op-attention)');
    expect(style.pillBorder).toBe('var(--wm-op-attention)');
    expect(weather.a2b.label).toBe(weatherHalfText(weather.a2b, 'full'));
  });

  it('4. OPERACIONAL crítico: coral fosco', () => {
    const weather = weatherAt(94, 10);
    const style = weatherHalfStyle(weather.a2b, 'operational');
    expect(weather.a2b.band).toBe('critical');
    expect(style.stroke).toBe('var(--wm-op-critical)');
    expect(style.pillBorder).toBe('var(--wm-op-critical)');
  });

  it('5. A→B crítico e B→A normal: cada metade com a SUA cor (sem pintar o enlace inteiro)', () => {
    const weather = weatherAt(94, 18);
    const a2b = weatherHalfStyle(weather.a2b, 'operational');
    const b2a = weatherHalfStyle(weather.b2a, 'operational');
    expect(a2b.stroke).toBe('var(--wm-op-critical)');
    expect(b2a.stroke).toBe('var(--wm-op-normal)');
    expect(a2b.stroke).not.toBe(b2a.stroke);
    // Nada é agregado: o percentual de cada metade continua o do seu sentido.
    expect(weather.a2b.percent).toBe(94);
    expect(weather.b2a.percent).toBe(18);
  });

  it('6. A→B normal e B→A crítico: a cor segue o sentido, não a posição no desenho', () => {
    const weather = weatherAt(9, 88);
    expect(weatherHalfStyle(weather.a2b, 'operational').stroke).toBe('var(--wm-op-normal)');
    expect(weatherHalfStyle(weather.b2a, 'operational').stroke).toBe('var(--wm-op-critical)');
    // A identidade do sentido continua explícita na forma da seta.
    expect(weatherArrowShape('a2b')).toBe('solid');
    expect(weatherArrowShape('b2a')).toBe('chevron');
  });

  it('7. limites exatos: 49% normal, 50% atenção, 79% atenção, 80% crítico (por sentido)', () => {
    const expected: Array<[number, string]> = [
      [49, 'var(--wm-op-normal)'],
      [50, 'var(--wm-op-attention)'],
      [79, 'var(--wm-op-attention)'],
      [80, 'var(--wm-op-critical)'],
    ];
    for (const [percent, color] of expected) {
      const weather = weatherAt(percent, percent);
      expect(weatherHalfStyle(weather.a2b, 'operational').stroke).toBe(color);
      expect(weatherHalfStyle(weather.b2a, 'operational').stroke).toBe(color);
      // O percentual exibido é o do modelo, sem recálculo no renderer.
      expect(weather.a2b.percent).toBe(percent);
    }
    // Assimétrico: 80% só de um lado.
    const asymmetric = weatherAt(80, 79);
    expect(weatherHalfStyle(asymmetric.a2b, 'operational').stroke).toBe('var(--wm-op-critical)');
    expect(weatherHalfStyle(asymmetric.b2a, 'operational').stroke).toBe('var(--wm-op-attention)');
  });

  it('8. SINGLE_ENDED: TX e RX da MESMA interface viram as duas metades, cada uma com a sua cor', () => {
    const single = {
      trafficMode: 'SINGLE_ENDED' as const,
      sourceInterfaceId: 'if-a',
      targetInterfaceId: null,
      directions: {
        A_TO_B: { bps: 2 * G, utilization: 2, txBps: 2 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' as const },
        B_TO_A: { bps: 90 * G, utilization: 90, txBps: null, observedRxBps: 90 * G, deltaPercent: null, consistency: 'UNKNOWN' as const },
      },
    };
    const weather = resolveWeatherMap(visualOf(link(single)));
    expect(weather.a2b.state).toBe('normal');
    expect(weather.b2a.state).toBe('critical');
    expect(weatherHalfStyle(weather.a2b, 'operational').stroke).toBe('var(--wm-op-normal)');
    expect(weatherHalfStyle(weather.b2a, 'operational').stroke).toBe('var(--wm-op-critical)');
    // Nenhuma metade vira "sem dados" por causa do estilo.
    expect(weather.a2b.valid).toBe(true);
    expect(weather.b2a.valid).toBe(true);
  });

  it('9. DOUBLE_ENDED (BIDIRECTIONAL) não tem regressão: cada lado com a sua faixa', () => {
    const weather = weatherAt(30, 84);
    expect(weather.a2b.band).toBe('normal');
    expect(weather.b2a.band).toBe('critical');
    expect(weatherHalfStyle(weather.a2b, 'operational').pillBorder).toBe('var(--wm-op-normal)');
    expect(weatherHalfStyle(weather.b2a, 'operational').pillBorder).toBe('var(--wm-op-critical)');
  });

  it('10. capacidade desconhecida NÃO vira verde: estado neutro', () => {
    const visual = visualOf(
      link({
        capacityBps: 0,
        directions: {
          A_TO_B: dir(0, 3 * G),
          B_TO_A: dir(0, 2 * G),
        },
      }),
    );
    const weather = resolveWeatherMap(visual);
    expect(visual.reason).toBe('capacity-unknown');
    expect(weather.a2b.percent).toBeNull();
    expect(weather.a2b.band).toBeNull();
    expect(weather.a2b.state).toBe('no-data');
    expect(weatherHalfStyle(weather.a2b, 'operational').stroke).toBe('var(--wm-state-no-data)');
    expect(weatherHalfStyle(weather.a2b, 'operational').stroke).not.toBe('var(--wm-op-normal)');
  });

  it('11. percentual indisponível não é lido como 0% (nem ganha seta verde)', () => {
    const weather = resolveWeatherMap(
      visualOf(
        link({
          capacityBps: 0,
          directions: {
            A_TO_B: dir(0, 2 * G),
            B_TO_A: dir(0, 1 * G),
          },
        }),
      ),
    );
    expect(weather.a2b.percent).toBeNull();
    expect(weather.a2b.band).toBeNull();
    expect(weather.a2b.state).not.toBe('normal');
    expect(weather.a2b.label).toBeNull();
    expect(weather.a2b.arrow).toBe(false);
    expect(weather.stateLabel).toBeTruthy();
    expect(weatherHalfStyle(weather.a2b, 'operational').stroke).toBe(
      WEATHER_HALF_COLOR_VAR[weather.a2b.state],
    );
  });

  it('12. zero VÁLIDO é diferente de ausência de telemetria (zero confiável = verde-sálvia)', () => {
    // TX = 0 tem origem (contador da ponta A), então é medição válida.
    const zero = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 0, utilization: 0, txBps: 0, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            B_TO_A: { bps: 0, utilization: 0, txBps: null, observedRxBps: 0, deltaPercent: null, consistency: 'CONSISTENT' },
          },
        }),
      ),
    );
    expect(zero.a2b.valid).toBe(true);
    expect(zero.a2b.band).toBe('normal');
    expect(weatherHalfStyle(zero.a2b, 'operational').stroke).toBe('var(--wm-op-normal)');
    expect(zero.a2b.label).toContain('0%');
    const absent = resolveWeatherMap(visualOf(link(), { collectionStamp: null }));
    expect(absent.a2b.valid).toBe(false);
    expect(weatherHalfStyle(absent.a2b, 'operational').stroke).toBe('var(--wm-state-no-data)');
  });

  it('13. DOWN manda: falha operacional nunca aparece verde-sálvia', () => {
    const down = weatherAt(5, 5, { status: 'DOWN' });
    expect(down.state).toBe('down');
    expect(weatherHalfStyle(down.a2b, 'operational').stroke).toBe('var(--wm-state-down)');
    expect(weatherHalfStyle(down.b2a, 'operational').stroke).toBe('var(--wm-state-down)');
    expect(weatherStateStyleColor('down', 'operational')).toBe('var(--wm-state-down)');
    expect(weatherHalfStyle(down.a2b, 'operational').stroke).not.toBe('var(--wm-op-normal)');
    // A linha continua tracejada no estado de falha.
    expect(weatherHalfDash(down.a2b)).not.toBeUndefined();
  });

  it('14. sem dados fica neutro e NUNCA verde', () => {
    const noData = resolveWeatherMap(visualOf(link(), { collectionStamp: null }));
    expect(noData.a2b.state).toBe('no-data');
    expect(weatherHalfStyle(noData.a2b, 'operational').stroke).toBe('var(--wm-state-no-data)');
    expect(weatherHalfStyle(noData.a2b, 'operational').stroke).not.toBe('var(--wm-op-normal)');
  });

  it('15. stale não é apresentado como leitura atual saudável', () => {
    const stale = resolveWeatherMap(
      visualOf(link(), { collectionStamp: new Date(NOW - 30 * 60_000).toISOString() }),
    );
    expect(stale.a2b.state).toBe('stale');
    expect(weatherHalfStyle(stale.a2b, 'operational').stroke).toBe('var(--wm-state-stale)');
    expect(weatherHalfStyle(stale.a2b, 'operational').stroke).not.toBe('var(--wm-op-normal)');
  });

  it('16. inconsistente permanece identificável (tracejado + token próprio, sem dominar)', () => {
    const inconsistent = resolveWeatherMap(
      visualOf(
        link({
          directions: {
            A_TO_B: { bps: 5 * G, utilization: 5, txBps: null, observedRxBps: null, deltaPercent: 40, consistency: 'DIVERGENT' },
            B_TO_A: { bps: 4 * G, utilization: 4, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'DIVERGENT' },
          },
        }),
      ),
    );
    expect(inconsistent.a2b.state).toBe('inconsistent');
    expect(weatherHalfStyle(inconsistent.a2b, 'operational').stroke).toBe(
      'var(--wm-state-inconsistent)',
    );
    expect(weatherHalfDash(inconsistent.a2b)).not.toBeUndefined();
    expect(inconsistent.a2b.label).toContain('inconsistente');
  });

  it('17. alternar o estilo não altera geometria, rótulo, faixa nem tracejado', () => {
    const weather = weatherAt(94, 41);
    const snapshot = (half: WeatherHalf) => ({
      state: half.state,
      band: half.band,
      percent: half.percent,
      bps: half.bps,
      label: half.label,
      compactLabel: half.compactLabel,
      valid: half.valid,
      arrow: half.arrow,
      dashed: half.dashed,
      animated: half.animated,
    });
    const before = {
      a2b: snapshot(weather.a2b),
      b2a: snapshot(weather.b2a),
      strokeWidth: weather.strokeWidth,
      stateLabel: weather.stateLabel,
    };
    for (const mode of STYLE_MODES) {
      weatherHalfStyle(weather.a2b, mode);
      weatherHalfStyle(weather.b2a, mode);
    }
    const after = {
      a2b: snapshot(weather.a2b),
      b2a: snapshot(weather.b2a),
      strokeWidth: weather.strokeWidth,
      stateLabel: weather.stateLabel,
    };
    expect(after).toEqual(before);
    // O mesmo enlace resolvido de novo (o estilo não participa do modelo).
    expect(snapshot(resolveWeatherMap(visualOf(link({ directions: directions(94, 41) }))).a2b)).toEqual(
      before.a2b,
    );
  });

  it('18. as plaquetas continuam as da Fase L (tamanhos e textos idênticos nos dois modos)', () => {
    expect(WEATHER_PILL_FONT_SIZE).toBe(9);
    expect(WEATHER_PILL_HEIGHT).toBe(15);
    expect(WEATHER_PILL_FONT_SIZE_SMALL).toBe(8);
    expect(WEATHER_PILL_HEIGHT_SMALL).toBe(13);
    expect(WEATHER_PILL_FONT_SIZE_COMPACT).toBe(8);
    expect(WEATHER_PILL_HEIGHT_COMPACT).toBe(13);
    const weather = weatherAt(94, 12);
    for (const mode of STYLE_MODES) {
      expect(weatherHalfText(weather.a2b, 'full')).toBe(weather.a2b.label);
      expect(weatherHalfText(weather.b2a, 'compact')).toBe(weather.b2a.compactLabel);
      expect(weatherHalfLabelMode(weather.a2b, NO_FOCUS, 1)).toBe('full');
      expect(mode).toBeTruthy();
    }
    // Offsets/prioridades da anticolisão não entram no cálculo de cor.
    expect(weatherHalfStyle(weather.b2a, 'operational').stroke).toBe('var(--wm-op-normal)');
  });

  it('22. a animação continua DESLIGADA nos dois estilos', () => {
    const weather = resolveWeatherMap(visualOf(link({ directions: directions(94, 12) })), {
      animation: 'off',
    });
    expect(weather.a2b.animated).toBe(false);
    expect(weather.b2a.animated).toBe(false);
    for (const key of ['a2b', 'b2a'] as const) {
      expect(shouldAnimateHalf(weather[key].state, 'off', { selected: true, hovered: true })).toBe(
        false,
      );
    }
    expect(weatherHalfStyle(weather.a2b, 'operational').stroke).not.toContain('animation');
  });

  it('o mapeamento estado → faixa é único e não inventa faixa para estados anômalos', () => {
    expect(weatherBandOfState('normal')).toBe('normal');
    expect(weatherBandOfState('attention')).toBe('attention');
    expect(weatherBandOfState('critical')).toBe('critical');
    for (const state of ['down', 'no-data', 'stale', 'inconsistent', 'unknown'] as WeatherHalfState[]) {
      expect(weatherBandOfState(state)).toBeNull();
      expect(weatherOperationalColorVar(state, null)).toBe(WEATHER_HALF_COLOR_VAR[state]);
    }
  });

  it('aceita apenas os dois estilos previstos', () => {
    expect(isLinkV2StyleMode('directional')).toBe(true);
    expect(isLinkV2StyleMode('operational')).toBe(true);
    expect(isLinkV2StyleMode('rainbow')).toBe(false);
    expect(isLinkV2StyleMode(null)).toBe(false);
  });

  it('o rótulo de estado agregado segue o modo ativo', () => {
    expect(weatherStateStyleColor('no-data', 'directional')).toBe('var(--wm-state-no-data)');
    expect(weatherStateStyleColor('no-data', 'operational')).toBe('var(--wm-state-no-data)');
    expect(weatherStateStyleColor('critical', 'directional')).toBe('var(--wm-util-critical)');
    expect(weatherStateStyleColor('critical', 'operational')).toBe('var(--wm-op-critical)');
    expect(weatherStateStyleColor('normal', 'operational')).toBe('var(--wm-op-normal)');
  });
});
