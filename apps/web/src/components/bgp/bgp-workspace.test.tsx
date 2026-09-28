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
  setBgpPeerAdminState: vi.fn(),
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
  summary: {
    peers: 3,
    established: 2,
    down: 1,
    receivedPrefixes: 1_311_664,
    byFamily: { IPV4: 2, IPV6: 1 },
  },
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
          addressFamily: 'IPV4',
          localAs: '268568',
          remoteAs: '12345',
          role: 'OTHER',
          monitoringEnabled: true,
          stateCode: 6,
          state: 'ESTABLISHED',
          established: true,
          adminState: 'ENABLED',
          adminStateCheckedAt: '2026-09-19T10:00:00.000Z',
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
          peerAddress: '2001:db8::10',
          displayName: 'CLIENTE IPV6',
          addressFamily: 'IPV6',
          localAs: '268568',
          remoteAs: '265424',
          role: 'OTHER',
          monitoringEnabled: true,
          stateCode: 6,
          state: 'ESTABLISHED',
          established: true,
          adminState: 'IGNORED',
          adminStateCheckedAt: '2026-09-20T10:00:00.000Z',
          receivedPrefixes: 211_752,
          establishedSince: '2026-09-12T00:00:00.000Z',
          lastPollingAt: '2026-09-19T11:00:00.000Z',
          lastDiscoveryAt: '2026-09-19T10:00:00.000Z',
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
          addressFamily: 'IPV4',
          localAs: null,
          remoteAs: null,
          role: 'OTHER',
          monitoringEnabled: true,
          stateCode: 3,
          state: 'ACTIVE',
          established: false,
          adminState: 'UNKNOWN',
          adminStateCheckedAt: null,
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
      ipv4Peers: 0,
      ipv6Peers: 0,
      matchedInterfaces: 0,
      unmatchedInterfaces: 0,
      localAs: '268568',
      localAsAmbiguous: false,
      ipv6Supported: true,
      warnings: [],
      peers: [],
    });
    api.setBgpPeerAdminState.mockResolvedValue({
      peerId: 'p1',
      deviceId: 'ne8000-1',
      peerAddress: '200.150.1.193',
      addressFamily: 'IPV4',
      action: 'DISABLE',
      success: true,
      adminState: 'IGNORED',
      verified: true,
      message: 'Sessão BGP desabilitada e confirmada por read-back (ADMIN: IGNORADO).',
      executedAt: '2026-09-21T10:00:00.000Z',
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
          addressFamily: 'IPV4',
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
          peerAddress: '2001:db8::20',
          displayName: 'CLIENTE IPV6',
          addressFamily: 'IPV6',
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

  it('renders IPv4 and IPv6 peers together with a family column', () => {
    expect(container.textContent).toContain('Família');
    const rows = Array.from(container.querySelectorAll('tr.is-up, tr.is-down'));
    const ipv4Row = rows.find((row) => row.textContent?.includes('200.150.1.193'));
    const ipv6Row = rows.find((row) => row.textContent?.includes('2001:db8::10'));
    expect(ipv4Row?.querySelector('.bgp-family')?.textContent).toBe('IPv4');
    expect(ipv6Row?.querySelector('.bgp-family')?.textContent).toBe('IPv6');
  });

  it('shows ADMIN: IGNORADO only for peers confirmed by read-back', () => {
    const rows = Array.from(container.querySelectorAll('tr.is-up, tr.is-down'));
    const ignored = rows.find((row) => row.textContent?.includes('2001:db8::10'));
    const unknown = rows.find((row) => row.textContent?.includes('200.150.1.193'));
    expect(ignored?.querySelector('.bgp-admin--ignored')?.textContent).toContain('IGNORADO');
    expect(unknown?.querySelector('.bgp-admin--ignored')).toBeNull();
  });

  it('shows the family breakdown in the summary without hiding the totals', () => {
    expect(container.textContent).toContain('IPv4: 2 · IPv6: 1');
    expect(container.textContent).toContain('ROTAS RECEBIDAS');
  });

  it('requests the selected address family from the API', async () => {
    const familySelect = Array.from(container.querySelectorAll('select')).find((select) =>
      select.closest('label')?.textContent?.includes('FAMÍLIA'),
    ) as HTMLSelectElement;
    expect(familySelect).toBeTruthy();
    await act(async () => {
      familySelect.value = 'IPV6';
      familySelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(api.getBgpDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'IPV6' }),
    );
  });

  it('requires human confirmation before disabling a peer session', async () => {
    const row = Array.from(container.querySelectorAll('tr')).find((candidate) =>
      candidate.textContent?.includes('200.150.1.193'),
    );
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();
    expect(container.textContent).toContain('AÇÕES OPERACIONAIS');

    const disable = findButton(container, 'Desabilitar sessão BGP');
    await act(async () => {
      disable.click();
    });
    await settle();
    expect(container.textContent).toContain('CONFIRMAÇÃO OBRIGATÓRIA');
    expect(container.textContent).toContain(
      'A sessão BGP será administrativamente ignorada e deixará de trocar rotas até ser reabilitada.',
    );
    expect(container.textContent).toContain('ASN local');
    expect(api.setBgpPeerAdminState).not.toHaveBeenCalled();

    const cancel = findButton(container, 'Cancelar');
    await act(async () => {
      cancel.click();
    });
    await settle();
    expect(api.setBgpPeerAdminState).not.toHaveBeenCalled();
  });

  it('executes the action once and refreshes from the device afterwards', async () => {
    const row = Array.from(container.querySelectorAll('tr')).find((candidate) =>
      candidate.textContent?.includes('200.150.1.193'),
    );
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();
    await act(async () => {
      findButton(container, 'Desabilitar sessão BGP').click();
    });
    await settle();

    const confirm = findButton(container, 'Confirmar desativação');
    await act(async () => {
      confirm.click();
      confirm.click(); // double click must not duplicate the operation
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await settle();

    expect(api.setBgpPeerAdminState).toHaveBeenCalledTimes(1);
    expect(api.setBgpPeerAdminState).toHaveBeenCalledWith('p1', 'DISABLE');
    expect(api.discoverBgp).toHaveBeenCalledWith('ne8000-1');
    expect(api.pollHost).toHaveBeenCalledWith('ne8000-1');
    expect(api.getBgpPeer).toHaveBeenCalledWith('p1');
    expect(container.textContent).toContain('read-back');
  });

  it('blocks the action and explains when the local ASN is unknown', async () => {
    const peerWithoutLocalAs = {
      ...dashboard.devices[0]!.peers[0]!,
      localAs: null,
    };
    api.getBgpDashboard.mockResolvedValue({
      ...dashboard,
      devices: [
        { ...dashboard.devices[0]!, peers: [peerWithoutLocalAs, ...dashboard.devices[0]!.peers.slice(1)] },
        dashboard.devices[1]!,
      ],
    } as BgpDashboardResponse);
    await act(async () => {
      await client.refetchQueries({ queryKey: ['bgp'] });
    });
    await settle();

    const row = Array.from(container.querySelectorAll('tr')).find((candidate) =>
      candidate.textContent?.includes('200.150.1.193'),
    );
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();

    expect(container.textContent).toContain(
      'ASN local do processo BGP ainda não foi identificado',
    );
    const disable = findButton(container, 'Desabilitar sessão BGP');
    expect(disable.disabled).toBe(true);
    await act(async () => {
      disable.click();
    });
    await settle();
    expect(api.setBgpPeerAdminState).not.toHaveBeenCalled();
  });

  it('offers the enable action only for a peer confirmed as IGNORADO', async () => {
    const row = Array.from(container.querySelectorAll('tr')).find((candidate) =>
      candidate.textContent?.includes('2001:db8::10'),
    );
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();
    expect(container.textContent).toContain('Reabilitar sessão BGP');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Desabilitar sessão BGP',
      ),
    ).toBe(false);
  });

  it('substitui a coluna Histórico vazia por quedas reais de 48h', async () => {
    api.getBgpAlerts.mockResolvedValue({
      active: [
        {
          peerId: 'p1',
          deviceId: 'ne8000-1',
          deviceName: 'NE-8K POP CENTRO',
          peerAddress: '200.150.1.193',
          displayName: 'TRANSITO XYZ',
          addressFamily: 'IPV4',
          previousState: 'ESTABLISHED',
          currentState: 'ACTIVE',
          startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      ],
      resolved: [
        {
          peerId: 'p1',
          deviceId: 'ne8000-1',
          deviceName: 'NE-8K POP CENTRO',
          peerAddress: '200.150.1.193',
          displayName: 'TRANSITO XYZ',
          addressFamily: 'IPV4',
          previousState: 'ESTABLISHED',
          currentState: 'ACTIVE',
          startedAt: '2026-09-24T10:00:00.000Z',
          resolvedAt: '2026-09-24T10:03:00.000Z',
          durationSeconds: 180,
        },
      ],
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ['bgp-alerts'] });
    });
    await settle();

    expect(container.textContent).toContain('Quedas · 48h');
    expect(container.textContent).not.toContain('Histórico');
    // Uma queda resolvida + a queda atual = 2 transições observadas.
    expect(container.querySelector('.bgp-flaps em')?.textContent).toBe('2×');
    expect(container.querySelector('.bgp-flaps small')?.textContent).toContain('down há');
  });

  it('acumula falhas de refresh por equipamento em vez de sobrescrever', async () => {
    api.discoverBgp.mockRejectedValue(new Error('ssh indisponível'));
    api.pollHost.mockRejectedValue(new Error('timeout SNMP'));

    const refreshButtons = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.bgp-device__refresh'));

    await act(async () => {
      refreshButtons()[0]!.click();
    });
    await settle();
    await act(async () => {
      refreshButtons()[1]!.click();
    });
    await settle();

    const failures = container.querySelector('.bgp-notice--warning');
    expect(failures).not.toBeNull();
    // As duas falhas convivem: a segunda não apaga a primeira.
    expect(failures?.querySelectorAll('li')).toHaveLength(2);
    expect(failures?.textContent).toContain('discovery SSH falhou');
    expect(failures?.textContent).toContain('timeout SNMP');
  });

  it('oferece navegação para host e mapa sem inferir interface', async () => {
    const row = Array.from(container.querySelectorAll('tr.is-down'))[0];
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();

    const nav = container.querySelector('.bgp-actions__nav');
    expect(nav).not.toBeNull();
    const openHost = Array.from(nav!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Abrir host no inventário',
    );
    const openInterface = Array.from(nav!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Abrir interface no mapa',
    );
    expect(openHost).not.toBeUndefined();
    expect(openInterface?.disabled).toBe(true);
    // O botão nunca é habilitado sem os dois critérios: interface correlacionada
    // (MATCHED) E equipamento presente no mapa ativo. O título diz qual falta.
    expect(openInterface?.getAttribute('title')).toMatch(/MATCHED|mapa ativo/);
  });
});

describe('WorkspaceView store', () => {
  it('supports switching to the BGP workspace', () => {
    useMapStore.getState().setView('BGP');
    expect(useMapStore.getState().view).toBe('BGP');
  });
});
