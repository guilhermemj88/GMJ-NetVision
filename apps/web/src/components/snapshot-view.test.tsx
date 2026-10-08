// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricPoint, OpticalHistoryPoint } from '@gmj/shared';
import { SnapshotView, snapshotNetworkInterface } from './snapshot-view';
import { metricChartData, nearestChartLabel } from './metric-charts';
import { AlarmTestSimulator, type AlarmTestDraft } from './media/network-alarms-media-section';
import type { SnapshotChartPayload } from '@/lib/snapshot-api';

vi.mock('@/lib/api', () => ({ getHistory: vi.fn(async () => []), getOpticalHistory: vi.fn(async () => []) }));

const METRIC_POINTS: MetricPoint[] = [
  {
    timestamp: '2026-10-08T17:45:00.000Z',
    rxBps: 1_000_000,
    txBps: 2_000_000,
    rxErrors: 4,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
  },
  {
    timestamp: '2026-10-08T17:50:00.000Z',
    rxBps: 1_000_000,
    txBps: 2_000_000,
    rxErrors: 18,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
  },
];

const OPTICAL_POINTS: OpticalHistoryPoint[] = [
  {
    timestamp: '2026-10-08T17:50:00.000Z',
    sampleCount: 1,
    rxAvg: -18.7,
    rxMin: -18.7,
    rxMax: -18.7,
    txAvg: -2.1,
    txMin: -2.1,
    txMax: -2.1,
    lanes: [
      {
        lane: 2,
        sampleCount: 1,
        rxAvg: -18.7,
        rxMin: -18.7,
        rxMax: -18.7,
        txAvg: -2.1,
        txMin: -2.1,
        txMax: -2.1,
      },
    ],
  },
];

function metricPayload(): SnapshotChartPayload {
  return {
    spec: {
      kind: 'METRIC',
      period: '15m',
      header: {
        device: 'CEM-CEN-6730-MPLS-01',
        interfaceName: '100GE0/0/1',
        alias: 'TESTE-WEBHOOK',
        type: 'INTERFACE_CRC',
        severity: 'CRITICAL',
        message: 'Teste de CRC/FCS do GMJ NetVision',
        eventAt: '2026-10-08T17:52:00.000Z',
        resolvedAt: null,
      },
      metric: {
        series: [{ key: 'rxErrors', label: 'CRC RX', tone: 'crc' }],
        unit: 'errors/min',
        thresholdValue: 10,
        thresholdLabel: 'THRESHOLD CRC',
      },
      optical: null,
    },
    points: METRIC_POINTS,
  };
}

describe('dados do snapshot', () => {
  it('usa a MESMA serie do dashboard (mapa + gap temporal)', () => {
    const data = metricChartData(METRIC_POINTS, '15m');
    expect(data[1]).toMatchObject({ rxErrors: 18, label: expect.stringMatching(/17:50/) });
    expect(data.every((point) => typeof point.label === 'string')).toBe(true);
  });

  it('a linha vertical cai no bucket mais proximo do evento', () => {
    const data = metricChartData(METRIC_POINTS, '15m');
    expect(nearestChartLabel(data, '2026-10-08T17:51:00.000Z')).toBe(
      nearestChartLabel(data, '2026-10-08T17:50:30.000Z'),
    );
    expect(nearestChartLabel([], '2026-10-08T17:51:00.000Z')).toBeNull();
    expect(nearestChartLabel(data, 'data-invalida')).toBeNull();
  });

  it('interface sintetica leva WARN e ALARM do evento (sem tocar o cadastro)', () => {
    const payload = metricPayload();
    const iface = snapshotNetworkInterface(payload.spec, {
      lane: 2,
      lowAlarmDbm: -21.48,
      highAlarmDbm: -2.5,
      lowWarningDbm: -19.5,
      highWarningDbm: -3.5,
    });
    expect(iface.opticalThresholds?.scalar.rx).toMatchObject({
      lowAlarmDbm: -21.48,
      highAlarmDbm: -2.5,
      lowWarningDbm: -19.5,
      highWarningDbm: -3.5,
    });
    expect(iface.name).toBe('100GE0/0/1');
    expect(iface.alias).toBe('TESTE-WEBHOOK');
  });
});

describe('pagina de snapshot renderizada', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function mount(element: ReactElement): Promise<string> {
    await act(async () => {
      root.render(element);
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    return container.textContent ?? '';
  }

  it('mostra cabeçalho completo e o gráfico do evento', async () => {
    const text = await mount(<SnapshotView data={metricPayload()} />);
    expect(text).toContain('GMJ NetVision');
    expect(text).toContain('CEM-CEN-6730-MPLS-01');
    expect(text).toContain('100GE0/0/1 · TESTE-WEBHOOK');
    expect(text).toContain('CRC/FCS');
    expect(text).toContain('CRITICAL');
    expect(text).toContain('últimos 15 min');
    expect(text).toContain('CRC RX');
    expect(container.querySelector('.snapshot-canvas')).not.toBeNull();
  });

  it('RESOLVED anexa a recuperação ao cabeçalho', async () => {
    const payload = metricPayload();
    payload.spec.header.resolvedAt = '2026-10-08T17:58:00.000Z';
    const text = await mount(<SnapshotView data={payload} />);
    expect(text).toContain('Recuperação');
  });

  it('tipo óptico reusa o histórico óptico com as linhas de WARN e ALARM', async () => {
    const payload: SnapshotChartPayload = {
      spec: {
        ...metricPayload().spec,
        kind: 'OPTICAL',
        period: '24h',
        header: { ...metricPayload().spec.header, type: 'OPTICAL_RX_DEGRADATION', severity: 'MAJOR' },
        metric: null,
        optical: {
          lane: 2,
          lowAlarmDbm: -21.48,
          highAlarmDbm: -2.5,
          lowWarningDbm: -19.5,
          highWarningDbm: -3.5,
        },
      },
      points: OPTICAL_POINTS,
    };
    const text = await mount(<SnapshotView data={payload} />);
    expect(text).toContain('Degradação óptica');
    expect(text).toContain('últimas 24 h');
    expect(text).toContain('LOW ALARM');
    expect(text).toContain('LOW WARN');
  });

  it('o dashboard e o snapshot compartilham a MESMA serie (contrato de extração)', () => {
    const data = metricChartData(METRIC_POINTS, '15m');
    const [first] = data;
    expect(Object.keys(first ?? {})).toEqual(
      expect.arrayContaining([
        'timestamp',
        'label',
        'sampleCount',
        'rxBps',
        'txBps',
        'rxErrors',
        'txErrors',
        'rxDiscards',
        'txDiscards',
        'rxGbps',
        'txGbps',
      ]),
    );
    expect(first).toMatchObject({ rxErrors: 4, txErrors: 0, sampleCount: 1 });
  });
});

describe('INCLUIR GRÁFICO no TESTAR ALARME', () => {
  const draft: AlarmTestDraft = {
    type: 'INTERFACE_CRC',
    event: 'OPENED',
    severity: 'WARNING',
    includeChart: false,
  };

  it('default OFF e rótulo explícito', () => {
    const html = renderToStaticMarkup(
      <AlarmTestSimulator draft={draft} onChange={() => undefined} onTest={() => undefined} disabled={false} />,
    );
    expect(html).toContain('INCLUIR GRÁFICO [OFF]');
    expect(html).toContain('Simulação: não cria alarme no NetVision.');
  });

  it('ligar o gráfico envia includeChart=true no mesmo draft', async () => {
    const onChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AlarmTestSimulator draft={draft} onChange={onChange} onTest={() => undefined} disabled={false} />,
      );
    });
    const checkbox = container.querySelector(
      'input[aria-label="Incluir gráfico no alarme de teste"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await act(async () => {
      checkbox.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ ...draft, includeChart: true });
    await act(async () => root.unmount());
    container.remove();
  });
});
