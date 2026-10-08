// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NetworkInterface } from '@gmj/shared';

vi.mock('@/lib/api', () => ({ getHistory: vi.fn() }));

import { getHistory } from '@/lib/api';
import {
  TRAFFIC_CURVE_TYPE,
  TRAFFIC_PEAK_HAS_LINE,
  TRAFFIC_PEAK_RENDERING,
  MetricCharts,
  TrafficHistoryTooltip,
  trafficPeakValue,
} from './metric-charts';

describe('traffic history rendering', () => {
  it('uses step-after averages and isolated peak markers without a peak line', () => {
    expect(TRAFFIC_CURVE_TYPE).toBe('stepAfter');
    expect(TRAFFIC_PEAK_RENDERING).toBe('SCATTER');
    expect(TRAFFIC_PEAK_HAS_LINE).toBe(false);
    expect(trafficPeakValue(10, 25)).toBe(25);
    expect(trafficPeakValue(10, 10)).toBeNull();
  });

  it('shows average, maximum and sample count in the tooltip', () => {
    const html = renderToStaticMarkup(
      <TrafficHistoryTooltip
        active
        payload={[{ payload: {
          timestamp: '2026-08-23T12:00:00.000Z',
          sampleCount: 3,
          rxBps: 10,
          txBps: 20,
          rxBpsMax: 30,
          txBpsMax: 40,
        } }]}
      />,
    );
    expect(html).toContain('RX média');
    expect(html).toContain('RX máximo');
    expect(html).toContain('TX média');
    expect(html).toContain('TX máximo');
    expect(html).toContain('3 amostras no bucket');
  });
});

/**
 * F9.6: período vazio precisa informar a idade da última coleta (um preview sem
 * polling não pode parecer bug de gráfico).
 */
describe('estado vazio da telemetria (F9.6)', () => {
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
    telemetryUpdatedAt: '2026-10-08T00:39:58.000Z',
  } as unknown as NetworkInterface;

  let container: HTMLDivElement;
  let root: Root;

  async function mount(): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MetricCharts networkInterface={NETWORK_INTERFACE} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('sem amostras no período mostra a janela e a idade da última coleta', async () => {
    vi.mocked(getHistory).mockResolvedValue([]);
    await mount();

    const text = container.textContent ?? '';
    expect(text).toContain('Sem amostras nas últimas 1 h');
    expect(text).toContain('Última coleta: há');
    expect(text).not.toContain('Sem coleta anterior');
  });

  it('com dados no período não mostra aviso de vazio', async () => {
    vi.mocked(getHistory).mockResolvedValue([
      {
        timestamp: '2026-10-08T11:00:00.000Z',
        rxBps: 1_000_000,
        txBps: 2_000_000,
        rxErrors: 0,
        txErrors: 0,
        rxDiscards: 0,
        txDiscards: 0,
      },
    ]);
    await mount();

    const text = container.textContent ?? '';
    expect(text).not.toContain('Sem amostras nas últimas');
    expect(text).toContain('HISTÓRICO · última amostra');
  });

  it('interface sem coleta anterior é explícita', async () => {
    vi.mocked(getHistory).mockResolvedValue([]);
    NETWORK_INTERFACE.telemetryUpdatedAt = null;
    await mount();

    expect(container.textContent).toContain('Sem coleta anterior');
    NETWORK_INTERFACE.telemetryUpdatedAt = '2026-10-08T00:39:58.000Z';
  });
});
