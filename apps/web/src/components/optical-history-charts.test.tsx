import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HistoryPeriod, NetworkInterface, OpticalHistoryPoint } from '@gmj/shared';
import {
  OpticalHistoryTooltip,
  OpticalHistoryView,
  OpticalThresholdChips,
  OpticalScalePicker,
  axisWindow,
  chartScale,
  formatAxisDbm,
  laneIdsWithPower,
  limitsWindow,
  opticalChartData,
  opticalDots,
  opticalSeries,
  opticalThresholdRange,
  thresholdHint,
  thresholdMarkers,
} from './optical-history-charts';

const point: OpticalHistoryPoint = {
  timestamp: '2026-08-23T12:00:00.000Z',
  sampleCount: 2,
  rxAvg: -12,
  rxMin: -13,
  rxMax: -11,
  txAvg: 0.2,
  txMin: 0.1,
  txMax: 0.3,
  lanes: [0, 1, 2, 3].map((lane) => ({
    lane,
    sampleCount: 2,
    rxAvg: -12 + lane,
    rxMin: -13 + lane,
    rxMax: -11 + lane,
    txAvg: 0.2 + lane,
    txMin: 0.1 + lane,
    txMax: 0.3 + lane,
  })),
};

describe('optical history rendering', () => {
  it('uses one scalar series for single-lane optics', () => {
    expect(opticalSeries([], 'rx')).toEqual([
      { dataKey: 'rxAvg', name: 'RX', stroke: '#43d6b5' },
    ]);
  });

  it('uses one independent RX and TX series per optical lane', () => {
    expect(opticalSeries([0, 1, 2, 3], 'rx').map((series) => series.dataKey)).toEqual([
      'lane_0_rxAvg', 'lane_1_rxAvg', 'lane_2_rxAvg', 'lane_3_rxAvg',
    ]);
    expect(opticalSeries([0, 1, 2, 3], 'tx').map((series) => series.dataKey)).toEqual([
      'lane_0_txAvg', 'lane_1_txAvg', 'lane_2_txAvg', 'lane_3_txAvg',
    ]);
  });

  it('maps four-lane history and exposes lane average, min and max in the tooltip', () => {
    const data = opticalChartData([point], [0, 1, 2, 3], '1h');
    expect(data[0]).toMatchObject({
      lane_0_rxAvg: -12,
      lane_3_rxAvg: -9,
      lane_0_txAvg: 0.2,
      lane_3_txAvg: 3.2,
    });
    const html = renderToStaticMarkup(
      <OpticalHistoryTooltip
        active
        direction="rx"
        laneIds={[0, 1, 2, 3]}
        payload={[{ payload: data[0]! }]}
      />,
    );
    expect(html).toContain('Lane 0 · média');
    expect(html).toContain('· mín');
    expect(html).toContain('· máx');
    expect(html).toContain('2 amostras no bucket');
  });

  it('generates four-lane series for 15m, 1h and 6h without dropping valid lanes', () => {
    for (const period of ['15m', '1h', '6h'] as const) {
      const data = opticalChartData([point], [0, 1, 2, 3], period);
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        lane_0_rxAvg: -12,
        lane_1_rxAvg: -11,
        lane_2_rxAvg: -10,
        lane_3_rxAvg: -9,
      });
    }
  });

  it('breaks lane series only across unexpectedly long collection gaps', () => {
    const at = (timestamp: string): OpticalHistoryPoint => ({ ...point, timestamp });
    const continuous = opticalChartData([
      at('2026-08-23T12:00:00.000Z'),
      at('2026-08-23T12:05:00.000Z'),
      at('2026-08-23T12:10:00.000Z'),
      at('2026-08-23T12:15:00.000Z'),
    ], [0, 1, 2, 3], '1h');
    const broken = opticalChartData([
      at('2026-08-23T12:00:00.000Z'),
      at('2026-08-23T12:05:00.000Z'),
      at('2026-08-23T12:10:00.000Z'),
      at('2026-08-23T12:30:00.000Z'),
    ], [0, 1, 2, 3], '1h');

    expect(continuous.every((item) => item.source !== null)).toBe(true);
    expect(broken.filter((item) => item.source === null)).toHaveLength(1);
    expect(broken.find((item) => item.source === null)).toMatchObject({
      lane_0_rxAvg: null,
      lane_3_txAvg: null,
    });
  });

  it('excludes bias-only lanes from power series and falls back to scalar when needed', () => {
    const biasOnly: OpticalHistoryPoint = {
      timestamp: '2026-08-23T12:00:00.000Z',
      sampleCount: 1,
      rxAvg: -4.2,
      rxMin: -4.2,
      rxMax: -4.2,
      txAvg: -3.01,
      txMin: -3.01,
      txMax: -3.01,
      lanes: [{ lane: 0, sampleCount: 1, rxAvg: null, rxMin: null, rxMax: null, txAvg: null, txMin: null, txMax: null }],
    };

    expect(laneIdsWithPower([biasOnly], [0], 'rx')).toEqual([]);
    expect(laneIdsWithPower([biasOnly], [0], 'tx')).toEqual([]);
    expect(opticalSeries([], 'rx')).toEqual([
      { dataKey: 'rxAvg', name: 'RX', stroke: '#43d6b5' },
    ]);
    expect(opticalSeries([], 'tx')).toEqual([
      { dataKey: 'txAvg', name: 'TX', stroke: '#44a8e8' },
    ]);
  });

  it('selects RX lanes independently of TX lanes', () => {
    const mixed: OpticalHistoryPoint = {
      timestamp: '2026-08-23T12:00:00.000Z',
      sampleCount: 1,
      rxAvg: -4.2,
      rxMin: -4.2,
      rxMax: -4.2,
      txAvg: -3.01,
      txMin: -3.01,
      txMax: -3.01,
      lanes: [
        { lane: 0, sampleCount: 1, rxAvg: -3.7, rxMin: -3.7, rxMax: -3.7, txAvg: null, txMin: null, txMax: null },
        { lane: 1, sampleCount: 1, rxAvg: null, rxMin: null, rxMax: null, txAvg: 0.6, txMin: 0.6, txMax: 0.6 },
      ],
    };

    expect(laneIdsWithPower([mixed], [0, 1], 'rx')).toEqual([0]);
    expect(laneIdsWithPower([mixed], [0, 1], 'tx')).toEqual([1]);
  });

  it('formats the Y-axis with two decimals and no dBm suffix', () => {
    expect(formatAxisDbm(1.37)).toBe('1.37');
    expect(formatAxisDbm(1.1)).toBe('1.10');
    expect(formatAxisDbm(-4.2)).toBe('-4.20');
    expect(formatAxisDbm(0)).toBe('0.00');
  });
});

describe('thresholds no grafico optico (F7.5)', () => {
  const baseInterface = {
    id: 'if-1', deviceId: 'dev-1', name: '100GE1/0/1', alias: '', description: '',
    ifIndex: 1, mac: '', mtu: 1500, speedBps: 100_000_000_000,
    adminStatus: 'UP', operStatus: 'UP', rxBps: 0, txBps: 0, rxUtilization: 0,
    txUtilization: 0, rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0,
    dataSources: ['SNMP'],
  } as unknown as NetworkInterface;

  it('le o MESMO opticalThresholds canonico (scalar do modulo, com origem)', () => {
    const range = opticalThresholdRange({
      ...baseInterface,
      opticalThresholds: {
        version: 1,
        scalar: {
          rx: { lowAlarmDbm: -12.31, highAlarmDbm: 3.4, lowSource: 'DEVICE', highSource: 'DEVICE' },
          tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
        },
        lanes: [],
      },
    }, 'rx');
    expect(range).toEqual({ low: -12.31, high: 3.4, source: 'DEVICE', scope: 'MODULE' });
  });

  it('sem scalar usa a envoltoria dos limites por lane e nunca inventa valor', () => {
    const range = opticalThresholdRange({
      ...baseInterface,
      opticalThresholds: {
        version: 1,
        scalar: {
          rx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
          tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
        },
        lanes: [
          { lane: 0, rx: { lowAlarmDbm: -13.5, highAlarmDbm: 2, lowSource: 'USER', highSource: 'USER' }, tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null } },
          { lane: 1, rx: { lowAlarmDbm: -11, highAlarmDbm: 3, lowSource: 'USER', highSource: 'USER' }, tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null } },
        ],
      },
    }, 'rx');
    expect(range).toMatchObject({ low: -13.5, high: 3, source: 'USER', scope: 'LANE' });

    expect(opticalThresholdRange(baseInterface, 'rx')).toEqual({
      low: null, high: null, source: null, scope: null,
    });
  });

  it('janela Y vem SO dos dados: threshold distante nao achata as lanes', () => {
    const window = axisWindow([0.19, 0.69, 1.02, 0.11]);
    expect(window?.[0]).toBeLessThan(0.11);
    expect(window?.[1]).toBeGreaterThan(1.02);
    // Faixa real das 4 lanes (0.11..1.02) preservada, sem incluir -12.31/+3.40.
    expect(window?.[0]).toBeGreaterThan(-1);

    const markers = thresholdMarkers({ low: -12.31, high: 3.4, source: 'DEVICE', scope: 'MODULE' }, window);
    // LOW abaixo da janela e HIGH acima: chip mostra a direcao, sem linha falsa.
    expect(markers.low).toEqual({ value: -12.31, visible: false, hint: 'below' });
    expect(markers.high).toEqual({ value: 3.4, visible: false, hint: 'above' });
  });

  it('threshold dentro da janela vira linha de referencia visivel', () => {
    const window = axisWindow([-3.0, -2.4, -2.8]);
    const markers = thresholdMarkers({ low: -3.0, high: -2.5, source: 'DEVICE', scope: 'MODULE' }, window);
    expect(markers.low?.visible).toBe(true);
    expect(markers.high?.visible).toBe(true);
    expect(markers.low?.hint).toBeNull();
  });

  it('sem dados nao ha janela e nenhum threshold e desenhado', () => {
    expect(axisWindow([null, undefined])).toBeNull();
    expect(thresholdMarkers({ low: null, high: null, source: null, scope: null }, null))
      .toEqual({ low: null, high: null });
  });
});

describe('escala AUTO/LIMITES do historico optico (F9.4.2)', () => {
  // Valores reais do CEM-CEN-6730-MPLS-01 / 100GE0/0/2 no preview.
  const rxValues = [-13.7, -12.3, -13.1, -12.8];
  const device = { low: -21.48, high: -2.5, source: 'DEVICE' as const, scope: 'MODULE' as const };

  it('AUTO: dominio SO dos dados e LOW/HIGH fora viram chip direcional', () => {
    const scale = chartScale('AUTO', rxValues, device);
    // Nao achata as lanes ate -21.48/-2.50.
    expect(scale.domain?.[0]).toBeGreaterThan(-14);
    expect(scale.domain?.[1]).toBeLessThan(-12);
    expect(scale.showHints).toBe(true);
    expect(scale.low).toEqual({ value: -21.48, visible: false, hint: 'below' });
    expect(scale.high).toEqual({ value: -2.5, visible: false, hint: 'above' });
    expect(thresholdHint(scale.low)).toBe('↓ abaixo da janela');
    expect(thresholdHint(scale.high)).toBe('↑ acima da janela');
  });

  it('AUTO: threshold dentro do dominio vira ReferenceLine, sem hint de janela', () => {
    const scale = chartScale('AUTO', [-3, -2.4, -2.8], {
      low: -3, high: -2.5, source: 'USER', scope: 'MODULE',
    });
    expect(scale.low?.visible).toBe(true);
    expect(scale.high?.visible).toBe(true);
    expect(scale.low?.hint).toBeNull();
    expect(thresholdHint(scale.low)).toBeNull();
    expect(thresholdHint(scale.high)).toBeNull();
  });

  it('LIMITES: o dominio passa a incluir LOW e HIGH, com padding', () => {
    const domain = limitsWindow(rxValues, device);
    expect(domain?.[0]).toBeLessThan(-21.48);
    expect(domain?.[1]).toBeGreaterThan(-2.5);

    const scale = chartScale('LIMITS', rxValues, device);
    expect(scale.domain).toEqual(domain);
    expect(scale.low?.visible).toBe(true);
    expect(scale.high?.visible).toBe(true);
    expect(scale.showHints).toBe(false);
  });

  it('LIMITES: as duas linhas de referencia aparecem e nenhum chip fala em janela', () => {
    const scale = chartScale('LIMITS', rxValues, device);
    const html = renderToStaticMarkup(<OpticalThresholdChips thresholds={device} scale={scale} />);
    expect(html.match(/<span class="chart-thresholds__chip/g)).toHaveLength(3);
    expect(html).toContain('-21.48 dBm');
    expect(html).toContain('-2.50 dBm');
    expect(html).toContain('DEVICE');
    expect(html).not.toContain('janela');
  });

  it('AUTO/LIMITES nao mexem nos dados nem nas series (troca so o dominio)', () => {
    const auto = chartScale('AUTO', rxValues, device);
    const limits = chartScale('LIMITS', rxValues, device);
    expect(auto.domain).not.toEqual(limits.domain);

    const series = opticalSeries([0, 1, 2, 3], 'rx');
    const data = opticalChartData([point], [0, 1, 2, 3], '1h');
    // Mesmo array/series para os dois modos: nada e refeito ou perdido.
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ lane_0_rxAvg: -12, lane_3_rxAvg: -9 });
    expect(Math.max(...series.map((item) => item.dataKey.length))).toBeGreaterThan(0);
    expect(chartScale('AUTO', rxValues, device).domain).toEqual(auto.domain);
  });

  it('RX e TX calculam dominios independentes', () => {
    const rx = chartScale('AUTO', rxValues, device);
    const tx = chartScale('AUTO', [0.4, 0.8], { low: -2.5, high: 6.5, source: 'DEVICE', scope: 'MODULE' });
    expect(rx.domain).not.toEqual(tx.domain);
    expect(rx.low?.hint).toBe('below');
    expect(tx.low?.hint).toBe('below');
    expect(tx.high?.hint).toBe('above');
  });

  it('chips: LOW, HIGH e fonte em blocos separados, hint dentro do proprio chip', () => {
    const scale = chartScale('AUTO', rxValues, device);
    const html = renderToStaticMarkup(<OpticalThresholdChips thresholds={device} scale={scale} />);
    expect(html.match(/<span class="chart-thresholds__chip/g)).toHaveLength(3);
    expect(html).toContain('chart-thresholds__chip--source');
    expect(html).toContain('<em>LOW</em>');
    expect(html).toContain('<em>HIGH</em>');
    expect(html).toContain('<em>FONTE</em>');
    expect(html).toContain('↓ abaixo da janela');
    expect(html).toContain('↑ acima da janela');
    // Nada concatenado: depois de "janela" sempre vem markup, nunca outro rotulo.
    expect(html).not.toMatch(/janela[A-Z]/);
  });

  it('sem threshold real os chips mostram N/D e nenhum hint', () => {
    const empty = { low: null, high: null, source: null, scope: null } as const;
    const scale = chartScale('AUTO', rxValues, empty);
    const html = renderToStaticMarkup(<OpticalThresholdChips thresholds={empty} scale={scale} />);
    expect(html).toContain('N/D');
    expect(html).not.toContain('janela');
  });

  it('single sample desenha os pontos; com historico a linha volta a ser linha', () => {
    expect(opticalDots(1)).toBe(true);
    expect(opticalDots(2)).toBe(false);
    expect(opticalDots(0)).toBe(false);
  });

  it('seletor de escala nasce em AUTO e expoe os dois modos', () => {
    const auto = renderToStaticMarkup(<OpticalScalePicker mode="AUTO" onChange={() => {}} />);
    expect(auto).toContain('AUTO');
    expect(auto).toContain('LIMITES');
    const active = auto.match(/class="is-active"[^>]*>([^<]+)</);
    expect(active?.[1]).toBe('AUTO');
    const limits = renderToStaticMarkup(<OpticalScalePicker mode="LIMITS" onChange={() => {}} />);
    expect(limits).toMatch(/class="is-active"[\s\S]*LIMITES/);
  });
});


/**
 * F9.6: o histórico óptico vazio informa a idade da última coleta óptica
 * (escalar ou lanes, o que for mais recente) em vez de só dizer "sem amostras".
 */
describe('estado vazio do historico optico (F9.6)', () => {
  const NETWORK_INTERFACE = {
    id: 'if-1',
    deviceId: 'dev-1',
    name: '100GE0/0/2',
    alias: '',
    description: '',
    ifIndex: 2,
    mac: '',
    mtu: 1500,
    speedBps: 100_000_000_000,
    adminStatus: 'UP',
    operStatus: 'UP',
    rxBps: 0,
    txBps: 0,
    rxUtilization: 0,
    txUtilization: 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    dataSources: ['SNMP'],
    opticalLanes: [0, 1, 2, 3].map((lane) => ({ lane })),
    opticalUpdatedAt: '2026-10-07T16:54:21.000Z',
    opticalLanesUpdatedAt: '2026-10-08T00:40:10.000Z',
  } as unknown as NetworkInterface;

  function renderView(points: OpticalHistoryPoint[], period: HistoryPeriod = '6h'): string {
    return renderToStaticMarkup(
      <OpticalHistoryView
        networkInterface={NETWORK_INTERFACE}
        points={points}
        period={period}
        scaleMode="AUTO"
        onPeriodChange={() => {}}
        onScaleModeChange={() => {}}
      />,
    );
  }

  it('sem amostras mostra a janela e a idade da ultima coleta optica', () => {
    const html = renderView([]);
    expect(html).toContain('Sem amostras nas últimas 6 h');
    expect(html).toContain('Última coleta: há');
  });

  it('sem coleta anterior o texto e explicito', () => {
    const withoutOptics = {
      ...NETWORK_INTERFACE,
      opticalUpdatedAt: null,
      opticalLanesUpdatedAt: null,
    } as unknown as NetworkInterface;
    const html = renderToStaticMarkup(
      <OpticalHistoryView
        networkInterface={withoutOptics}
        points={[]}
        period="24h"
        scaleMode="AUTO"
        onPeriodChange={() => {}}
        onScaleModeChange={() => {}}
      />,
    );
    expect(html).toContain('Sem amostras nas últimas 24 h');
    expect(html).toContain('Sem coleta anterior');
  });

  it('com amostras no periodo nao mostra aviso de vazio', () => {
    const html = renderView([
      {
        timestamp: '2026-10-08T00:40:10.000Z',
        sampleCount: 1,
        rxAvg: -13.67,
        rxMin: -13.67,
        rxMax: -13.67,
        txAvg: 0.76,
        txMin: 0.76,
        txMax: 0.76,
        lanes: [0, 1, 2, 3].map((lane) => ({
          lane,
          sampleCount: 1,
          rxAvg: -13.7 + lane * 0.3,
          rxMin: -13.7 + lane * 0.3,
          rxMax: -13.7 + lane * 0.3,
          txAvg: 0.4 + lane * 0.1,
          txMin: 0.4 + lane * 0.1,
          txMax: 0.4 + lane * 0.1,
        })),
      },
    ]);
    expect(html).not.toContain('Sem amostras nas últimas');
    expect(html).toContain('Lane 0');
    expect(html).toContain('RX · dBm');
  });
});
