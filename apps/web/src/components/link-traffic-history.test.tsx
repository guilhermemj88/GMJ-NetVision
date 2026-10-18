// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LinkInterfaceResolver,
  MetricPoint,
  NetworkInterface,
  NetworkLink,
} from '@gmj/shared';

vi.mock('@/lib/api', () => ({ getHistory: vi.fn() }));

import { getHistory } from '@/lib/api';
import { LinkTrafficHistory } from './link-traffic-history';

const IF_A = {
  id: 'if-a',
  deviceId: 'dev-a',
  name: '100GE0/0/3',
  alias: '',
  description: '',
  ifIndex: 57,
  mac: '',
  mtu: 9000,
  speedBps: 10_000_000_000,
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
  opticalLanes: [],
  telemetryUpdatedAt: '2026-10-15T12:00:00.000Z',
} as unknown as NetworkInterface;

const IF_B = { ...IF_A, id: 'if-b', name: '100GE0/0/1' } as unknown as NetworkInterface;

const resolver: LinkInterfaceResolver = (_deviceId, interfaceId) =>
  [IF_A, IF_B].find((item) => item.id === interfaceId);

function link(overrides: Partial<NetworkLink> = {}): NetworkLink {
  return {
    id: 'link-1',
    sourceDeviceId: 'dev-a',
    targetDeviceId: 'dev-b',
    sourceNodeId: null,
    targetNodeId: null,
    sourceInterfaceId: 'if-a',
    targetInterfaceId: 'if-b',
    trafficMode: 'BIDIRECTIONAL',
    aggregationMode: 'NONE',
    metricSources: [],
    capacityBps: 10_000_000_000,
    metricSource: 'DEMO',
    ...overrides,
  } as unknown as NetworkLink;
}

function point(timestamp: string, rxBps: number, txBps: number): MetricPoint {
  return {
    timestamp,
    rxBps,
    txBps,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
  };
}

let container: HTMLDivElement;
let root: Root;

async function mount(target: NetworkLink): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LinkTrafficHistory link={target} findInterface={resolver} />
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
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('LinkTrafficHistory — painel do enlace', () => {
  it('mostra a secao, os periodos e as fontes canonicas de cada direcao', async () => {
    vi.mocked(getHistory).mockResolvedValue([
      point('2026-10-15T12:00:00.000Z', 6_500_000_000, 2_000_000_000),
      point('2026-10-15T12:05:00.000Z', 6_900_000_000, 2_100_000_000),
    ]);

    await mount(link());

    const text = container.textContent ?? '';
    expect(text).toContain('TRAFEGO HISTÓRICO');
    expect(text).toContain('A → B · TX ponta A');
    expect(text).toContain('B → A · TX ponta B');
    expect(text).toContain('média');
    expect(text).toContain('pico');
    expect(text).toContain('% da capacidade');
    for (const period of ['1h', '6h', '24h', '7d']) {
      expect(text).toContain(period);
    }
    expect(vi.mocked(getHistory)).toHaveBeenCalledWith('if-a', '1h');
    expect(vi.mocked(getHistory)).toHaveBeenCalledWith('if-b', '1h');
  });

  it('troca o periodo e refaz a consulta com o MESMO cache do painel da interface', async () => {
    vi.mocked(getHistory).mockResolvedValue([]);
    await mount(link());

    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === '24h',
    );
    await act(async () => {
      button?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(vi.mocked(getHistory)).toHaveBeenCalledWith('if-a', '24h');
    expect(vi.mocked(getHistory)).toHaveBeenCalledWith('if-b', '24h');
  });

  it('periodo vazio explica a janela e a idade da ultima coleta', async () => {
    vi.mocked(getHistory).mockResolvedValue([]);
    await mount(link());

    const text = container.textContent ?? '';
    expect(text).toContain('Sem amostras nas últimas 1 h');
    expect(text).toContain('Última coleta:');
  });

  it('fallback do RX observado fica EXPLICITO, com a ponta sem TX no periodo', async () => {
    vi.mocked(getHistory).mockImplementation(async (interfaceId: string) =>
      interfaceId === 'if-a'
        ? []
        : [
            point('2026-10-15T12:00:00.000Z', 6_600_000_000, 200_000_000),
            point('2026-10-15T12:05:00.000Z', 6_900_000_000, 210_000_000),
          ],
    );

    await mount(link());

    const text = container.textContent ?? '';
    expect(text).toContain('A → B exibido por RX ponta B');
    expect(text).toContain('TX da origem sem amostras no período');
    expect(text).toContain('B → A · TX ponta B');
  });

  it('sem interfaces reais o estado e explicito e nao inventa grafico', async () => {
    await mount(
      link({ sourceInterfaceId: null, targetInterfaceId: null, metricSource: 'DEMO' }),
    );

    const text = container.textContent ?? '';
    expect(text).toContain('não há histórico de tráfego para exibir');
    expect(text).toContain('DEMO');
    expect(vi.mocked(getHistory)).not.toHaveBeenCalled();
  });

  it('falha de carregamento mostra erro e permite tentar novamente', async () => {
    vi.mocked(getHistory).mockRejectedValue(new Error('offline'));

    await mount(link());

    const text = container.textContent ?? '';
    expect(text).toContain('Falha ao carregar o histórico de tráfego');
    expect(text).toContain('TENTAR NOVAMENTE');
  });
});
