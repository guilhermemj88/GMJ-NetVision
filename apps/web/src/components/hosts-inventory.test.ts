/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HostRecord } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  addHostToMap: vi.fn(),
  createHost: vi.fn(),
  deleteHost: vi.fn(),
  getHosts: vi.fn(),
  getMaps: vi.fn(),
  importZabbixHosts: vi.fn(),
  previewZabbixImport: vi.fn(),
  testHostSource: vi.fn(),
  updateHost: vi.fn(),
}));

vi.mock('@/lib/api', () => api);
vi.mock('./assisted-discovery-review', () => ({ AssistedDiscoveryReview: () => null }));

import { HostsWorkspace } from './hosts-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function host(id: string, status: HostRecord['status'], bgp = false): HostRecord {
  return {
    id,
    name: id,
    displayName: id,
    hostname: id,
    managementIp: '10.0.0.1',
    status,
    vendor: 'Huawei',
    model: 'NE8000',
    site: 'DC Savassi',
    deviceType: 'router',
    origin: 'MANUAL',
    useZabbix: true,
    sshEnabled: true,
    snmpEnabled: true,
    bgpMonitoringEnabled: bgp,
    bgpLocalAs: bgp ? '65000' : null,
    sourceHealth: {
      ZABBIX: { state: 'UP', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SSH: { state: 'UP', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SNMP: { state: 'UP', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
    },
    lastPollingAt: '2026-09-25T10:00:00.000Z',
    lastDiscoveryAt: null,
    mapIds: ['m1'],
    mapCount: 1,
    updatedAt: '2026-09-25T10:00:00.000Z',
    interfaces: [],
    pppSupported: false,
    pppOnline: 0,
    pppUpdatedAt: null,
    pppSource: null,
    uptimeSeconds: 10,
    origin_site: undefined,
  } as unknown as HostRecord;
}

describe('HostsWorkspace — control plane do inventário', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    api.getHosts.mockResolvedValue([
      host('host-up-a', 'UP'),
      host('host-down', 'DOWN', true),
      host('host-warning', 'WARNING'),
      host('host-up-b', 'UP'),
    ]);
    api.getMaps.mockResolvedValue([]);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(HostsWorkspace)),
      );
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function rowHostnames(): string[] {
    return [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')].map(
      (row) => row.querySelector('td:nth-child(2) strong')?.textContent ?? '',
    );
  }

  function statusFilter(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll<HTMLButtonElement>('.hosts-status-filter button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Filtro ${label} não encontrado`);
    return button;
  }

  it('abre com problema primeiro (DOWN, WARNING, depois UP)', () => {
    expect(rowHostnames()).toEqual([
      'host-down',
      'host-warning',
      'host-up-a',
      'host-up-b',
    ]);
  });

  it('filtra por estado sem esconder a contagem do total', () => {
    act(() => statusFilter('Com problema').click());
    expect(rowHostnames()).toEqual(['host-down', 'host-warning']);

    act(() => statusFilter('DOWN').click());
    expect(rowHostnames()).toEqual(['host-down']);

    act(() => statusFilter('Todos').click());
    expect(rowHostnames()).toHaveLength(4);
  });

  it('mostra o monitoramento BGP do inventário', () => {
    const rows = [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')];
    const downRow = rows.find((row) => row.textContent?.includes('host-down'))!;
    expect(downRow.querySelector('td:nth-child(6)')?.textContent).toContain('BGP');

    const upRow = rows.find((row) => row.textContent?.includes('host-up-a'))!;
    expect(upRow.querySelector('td:nth-child(6)')?.textContent).toContain('—');
  });

  it('oferece abrir o host direto no mapa a partir da contagem', () => {
    const cell = container.querySelector('.hosts-maps-cell button');
    expect(cell).not.toBeNull();
    // A primeira linha é a de maior severidade (host-down) por causa da ordenação padrão.
    expect(cell?.getAttribute('aria-label')).toBe('Abrir host-down em um mapa');
    expect(cell?.textContent).toContain('mapa');
  });
});
