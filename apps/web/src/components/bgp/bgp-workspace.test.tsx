// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BgpDashboardResponse } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';

const api = vi.hoisted(() => ({
  getBgpDashboard: vi.fn(),
  getBgpPeerHistory: vi.fn(),
  getBgpPeer: vi.fn(),
  getBgpAlerts: vi.fn(),
  getHosts: vi.fn(),
  updateHost: vi.fn(),
  getHistory: vi.fn(),
  discoverBgp: vi.fn(),
  pollHost: vi.fn(),
}));

vi.mock('@/lib/api', () => api);
vi.mock('recharts', () => {
  const stub = () => null;
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
    LineChart: stub,
    Line: stub,
    XAxis: stub,
    YAxis: stub,
    CartesianGrid: stub,
    Tooltip: stub,
    ReferenceLine: stub,
  };
});

import { BgpWorkspace } from './bgp-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const dashboard: BgpDashboardResponse = {
  summary: { peers: 3, established: 2, down: 1, receivedPrefixes: 1_311_664 },
  devices: [
    {
      id: 'ne8000-1',
      hostname: 'NE8000-1',
      displayName: 'NE-8K POP CENTRO',
      bgpMonitoringEnabled: true,
      peers: [
        {
          id: 'p1',
          deviceId: 'ne8000-1',
          deviceHostname: 'NE8000-1',
          deviceDisplayName: 'NE-8K POP CENTRO',
          bgpMonitoringEnabled: true,
          peerAddress: '200.150.1.193',
          displayName: 'TRANSITO XYZ',
          remoteAs: '12345',
          role: 'OTHER',
          monitoringEnabled: true,
          stateCode: 6,
          state: 'ESTABLISHED',
          established: true,
          receivedPrefixes: 1_099_912,
          establishedSince: '2026-09-01T00:00:00.000Z',
          lastPollingAt: '2026-09-19T11:00:00.000Z',
          lastDiscoveryAt: '2026-09-19T10:00:00.000Z',
          interface: {
            id: 'if-1',
            name: '100GE1/0/3',
            alias: 'TRANSITO XYZ',
            description: null,
            rxBps: 4_800_000_000,
            txBps: 2_100_000_000,
          },
        },
        {
          id: 'p2',
          deviceId: 'ne8000-1',
          deviceHostname: 'NE8000-1',
          deviceDisplayName: 'NE-8K POP CENTRO',
          bgpMonitoringEnabled: true,
          peerAddress: '187.16.216.253',
          displayName: '187.16.216.253',
          remoteAs: null,
          role: 'OTHER',
          monitoringEnabled: true,
          stateCode: 6,
          state: 'ESTABLISHED',
          established: true,
          receivedPrefixes: 211_752,
          establishedSince: '2026-09-12T00:00:00.000Z',
          lastPollingAt: '2026-09-19T11:00:00.000Z',
          lastDiscoveryAt: null,
          interface: null,
        },
      ],
    },
    {
      id: 's6730-1',
      hostname: 'S6730-MPLS-01',
      displayName: 'S6730 MPLS',
      bgpMonitoringEnabled: false,
      peers: [
        {
          id: 'p3',
          deviceId: 's6730-1',
          deviceHostname: 'S6730-MPLS-01',
          deviceDisplayName: 'S6730 MPLS',
          bgpMonitoringEnabled: false,
          peerAddress: '10.0.0.1',
          displayName: '10.0.0.1',
          remoteAs: null,
          role: 'OTHER',
          monitoringEnabled: true,
          stateCode: 3,
          state: 'ACTIVE',
          established: false,
          receivedPrefixes: null,
          establishedSince: null,
          lastPollingAt: '2026-09-19T11:00:00.000Z',
          lastDiscoveryAt: null,
          interface: {
            id: 'if-2',
            name: 'XGE0/0/1',
            alias: null,
            description: null,
            rxBps: null,
            txBps: null,
          },
        },
      ],
    },
  ],
};

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

describe('BgpWorkspace', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    api.getBgpDashboard.mockResolvedValue(dashboard);
    api.getBgpPeerHistory.mockResolvedValue({ peerId: 'p1', samples: [], events: [] });
    api.getBgpPeer.mockResolvedValue(null);
    api.getBgpAlerts.mockResolvedValue({ active: [], resolved: [] });
    api.getHistory.mockResolvedValue([]);
    api.getHosts.mockResolvedValue([]);
    api.updateHost.mockResolvedValue({});
    api.discoverBgp.mockResolvedValue({
      hostId: 'ne8000-1',
      peersDiscovered: 0,
      matchedInterfaces: 0,
      unmatchedInterfaces: 0,
      peers: [],
    });
    api.pollHost.mockResolvedValue({ hostId: 'ne8000-1', polledAt: 'x', interfacesChecked: 0, interfaceSamples: 0 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(BgpWorkspace),
        ),
      );
    });
    await settle();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it('groups peers by device and renders UP and DOWN states', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('NE-8K POP CENTRO');
    expect(text).toContain('S6730 MPLS');
    expect(text).toContain('TRANSITO XYZ');
    expect(text).toContain('10.0.0.1');
    expect(container.querySelectorAll('.bgp-state--up').length).toBe(2);
    expect(container.querySelectorAll('.bgp-state--down').length).toBe(1);
  });

  it('renders a dash for peers without ASN or interface traffic', () => {
    const rows = Array.from(container.querySelectorAll('tr.is-up, tr.is-down'));
    const downRow = rows.find((row) => row.textContent?.includes('10.0.0.1'));
    expect(downRow?.textContent).toContain('-');
  });

  it('does not render null receivedPrefixes as zero', () => {
    const downRow = Array.from(container.querySelectorAll('tr')).find((row) =>
      row.textContent?.includes('10.0.0.1'),
    );
    expect(downRow?.querySelector('.bgp-routes')?.textContent).toBe('-');
  });

  it('labels the traffic column as interface traffic', () => {
    expect(container.textContent).toContain('Tráfego da interface');
  });

  it('requests monitored scope by default and all scope when toggled', async () => {
    expect(api.getBgpDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'monitored' }),
    );
    const allButton = findButton(container, 'Todos com BGP');
    await act(async () => {
      allButton.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(api.getBgpDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'all' }),
    );
  });

  it('loads peer history only when a peer is opened', async () => {
    expect(api.getBgpPeerHistory).not.toHaveBeenCalled();
    const row = Array.from(container.querySelectorAll('tr')).find((candidate) =>
      candidate.textContent?.includes('200.150.1.193'),
    );
    await act(async () => {
      (row as HTMLElement).click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(api.getBgpPeerHistory).toHaveBeenCalledWith('p1', '1h');
  });

  it('toggles bgpMonitoringEnabled locally and saves only changed hosts', async () => {
    api.getHosts.mockResolvedValue([
      { id: 'ne8000-1', hostname: 'NE8000-1', displayName: 'NE-8K POP CENTRO', bgpMonitoringEnabled: true },
      { id: 's6730-1', hostname: 'S6730-MPLS-01', displayName: 'S6730 MPLS', bgpMonitoringEnabled: false },
    ]);
    const manage = findButton(container, 'Gerenciar equipamentos');
    await act(async () => {
      manage.click();
    });
    await settle();
    const row = Array.from(container.querySelectorAll('.bgp-manage__list li')).find((candidate) =>
      candidate.textContent?.includes('S6730-MPLS-01'),
    );
    const checkbox = row?.querySelector('input');
    expect(checkbox).toBeTruthy();
    await act(async () => {
      (checkbox as HTMLInputElement).click();
    });
    // Immediate local visual change, no PATCH yet.
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(api.updateHost).not.toHaveBeenCalled();

    const save = findButton(container, 'Salvar alterações');
    await act(async () => {
      save.click();
    });
    await settle();
    expect(api.updateHost).toHaveBeenCalledTimes(1);
    expect(api.updateHost).toHaveBeenCalledWith('s6730-1', { bgpMonitoringEnabled: true });
  });

  it('does not PATCH when the manager is cancelled', async () => {
    api.getHosts.mockResolvedValue([
      { id: 's6730-1', hostname: 'S6730-MPLS-01', displayName: 'S6730 MPLS', bgpMonitoringEnabled: false },
    ]);
    const manage = findButton(container, 'Gerenciar equipamentos');
    await act(async () => {
      manage.click();
    });
    await settle();
    const checkbox = container.querySelector('.bgp-manage__list input');
    await act(async () => {
      (checkbox as HTMLInputElement).click();
    });
    const cancel = findButton(container, 'Cancelar');
    await act(async () => {
      cancel.click();
    });
    await settle();
    expect(api.updateHost).not.toHaveBeenCalled();
  });

  it('shows an error when a PATCH fails during save', async () => {
    api.getHosts.mockResolvedValue([
      { id: 's6730-1', hostname: 'S6730-MPLS-01', displayName: 'S6730 MPLS', bgpMonitoringEnabled: false },
    ]);
    api.updateHost.mockRejectedValue(new Error('Falha de rede'));
    const manage = findButton(container, 'Gerenciar equipamentos');
    await act(async () => {
      manage.click();
    });
    await settle();
    const checkbox = container.querySelector('.bgp-manage__list input');
    await act(async () => {
      (checkbox as HTMLInputElement).click();
    });
    const save = findButton(container, 'Salvar alterações');
    await act(async () => {
      save.click();
    });
    await settle();
    expect(container.textContent).toContain('Falha de rede');
  });

  it('renders the alerts panel with active and resolved entries', async () => {
    api.getBgpAlerts.mockResolvedValue({
      active: [
        {
          peerId: 'p3',
          deviceId: 's6730-1',
          deviceName: 'S6730 MPLS',
          peerAddress: '10.0.0.1',
          displayName: '10.0.0.1',
          previousState: 'ESTABLISHED',
          currentState: 'ACTIVE',
          startedAt: '2026-09-20T09:42:00.000Z',
        },
      ],
      resolved: [
        {
          peerId: 'p2',
          deviceId: 'ne8000-1',
          deviceName: 'NE-8K POP CENTRO',
          peerAddress: '187.16.216.253',
          displayName: '187.16.216.253',
          previousState: 'ACTIVE',
          currentState: 'ESTABLISHED',
          startedAt: '2026-09-20T10:13:00.000Z',
          resolvedAt: '2026-09-20T10:17:12.000Z',
          durationSeconds: 252,
        },
      ],
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ['bgp-alerts'] });
    });
    await settle();
    expect(container.textContent).toContain('Ativos');
    expect(container.textContent).toContain('Resolvidos · 48h');
    expect(container.textContent).toContain('Down desde');
    expect(container.querySelectorAll('.bgp-alerts__item--active').length).toBe(1);
    expect(container.querySelectorAll('.bgp-alerts__item--resolved').length).toBe(1);
  });

  it('refreshes a single device with discovery before SNMP', async () => {
    const refresh = container.querySelector('.bgp-device__refresh');
    await act(async () => {
      (refresh as HTMLButtonElement).click();
    });
    await settle();
    expect(api.discoverBgp).toHaveBeenCalledWith('ne8000-1');
    expect(api.pollHost).toHaveBeenCalledWith('ne8000-1');
    expect(api.discoverBgp.mock.invocationCallOrder[0]!).toBeLessThan(
      api.pollHost.mock.invocationCallOrder[0]!,
    );
  });
});

describe('WorkspaceView store', () => {
  it('supports switching to the BGP workspace', () => {
    useMapStore.getState().setView('BGP');
    expect(useMapStore.getState().view).toBe('BGP');
  });
});
