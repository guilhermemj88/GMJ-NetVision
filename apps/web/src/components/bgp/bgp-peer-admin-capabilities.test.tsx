// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BgpDashboardPeer, BgpDashboardResponse, BgpDeviceCapabilities } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getBgpPeerAdvertisedRoutes: vi.fn(),
}));

const mitigationApi = vi.hoisted(() => ({ setBgpPeerMitigationExclusion: vi.fn() }));

vi.mock('@/lib/api', () => api);
vi.mock('@/lib/mitigation-api', () => mitigationApi);
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
import { BgpPeerDetail } from './bgp-peer-detail';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HUAWEI: BgpDeviceCapabilities = {
  platform: 'HUAWEI_VRP',
  adminActions: true,
  advertisedRoutes: true,
  mitigation: true,
};

const JUNIPER: BgpDeviceCapabilities = {
  platform: 'JUNIPER_JUNOS',
  adminActions: false,
  advertisedRoutes: true,
  mitigation: false,
};

const UNSUPPORTED: BgpDeviceCapabilities = {
  platform: 'UNSUPPORTED',
  adminActions: false,
  advertisedRoutes: false,
  mitigation: false,
};

function peer(overrides: Partial<BgpDashboardPeer> = {}): BgpDashboardPeer {
  return {
    id: 'peer-huawei',
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
    ...overrides,
  };
}

const HUAWEI_PEER = peer();
const JUNIPER_PEER = peer({
  id: 'peer-juniper',
  deviceId: 'mx480-1',
  deviceHostname: 'MX480-1',
  deviceDisplayName: 'MX480 BORDA',
  peerAddress: '200.150.9.9',
  displayName: 'TRANSITO JUNOS',
});

const dashboard: BgpDashboardResponse = {
  summary: {
    peers: 2,
    established: 2,
    down: 0,
    receivedPrefixes: 2_199_824,
    byFamily: { IPV4: 2, IPV6: 0 },
  },
  devices: [
    {
      id: 'ne8000-1',
      hostname: 'NE8000-1',
      displayName: 'NE-8K POP CENTRO',
      bgpMonitoringEnabled: true,
      capabilities: HUAWEI,
      peers: [HUAWEI_PEER],
    },
    {
      id: 'mx480-1',
      hostname: 'MX480-1',
      displayName: 'MX480 BORDA',
      bgpMonitoringEnabled: true,
      capabilities: JUNIPER,
      peers: [JUNIPER_PEER],
    },
  ],
};

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

/** Clique dentro de ct para não vazar update de estado entre commits. */
async function tap(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement | null {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  return button instanceof HTMLButtonElement ? button : null;
}

/** Linha da tabela (desktop) do peer indicado pelo endereço. */
function desktopRow(container: HTMLElement, address: string): HTMLElement {
  const row = Array.from(container.querySelectorAll('.bgp-table--rows tr')).find((candidate) =>
    candidate.textContent?.includes(address),
  );
  if (!(row instanceof HTMLElement)) throw new Error(`Linha não encontrada: ${address}`);
  return row;
}

/** Card (celular) do peer indicado pelo endereço. */
function mobileCard(container: HTMLElement, address: string): HTMLButtonElement {
  const card = Array.from(container.querySelectorAll('.bgp-cards .bgp-card')).find((candidate) =>
    candidate.textContent?.includes(address),
  );
  if (!(card instanceof HTMLButtonElement)) throw new Error(`Card não encontrado: ${address}`);
  return card;
}

describe('ações administrativas de sessão BGP respeitam capabilities', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    api.getBgpDashboard.mockResolvedValue(dashboard);
    api.getBgpPeerHistory.mockResolvedValue({ peerId: 'peer-huawei', samples: [], events: [] });
    api.getBgpPeer.mockResolvedValue(null);
    api.getBgpAlerts.mockResolvedValue({ active: [], resolved: [] });
    api.getHistory.mockResolvedValue([]);
    api.getHosts.mockResolvedValue([]);
    api.updateHost.mockResolvedValue({});
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue({
      peerId: 'peer-huawei',
      addressFamily: 'IPV4',
      collectedAt: '2026-10-01T10:00:00.000Z',
      routes: [],
      truncated: false,
      total: 0,
      warnings: [],
    });
    api.pollHost.mockResolvedValue({
      hostId: 'ne8000-1',
      polledAt: 'x',
      interfacesChecked: 0,
      interfaceSamples: 0,
    });
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
      peerId: 'peer-huawei',
      deviceId: 'ne8000-1',
      peerAddress: '200.150.1.193',
      addressFamily: 'IPV4',
      action: 'DISABLE',
      success: true,
      adminState: 'IGNORED',
      verified: true,
      message: 'ok',
      executedAt: '2026-10-01T10:00:00.000Z',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(BgpWorkspace)));
    });
    await settle();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it('Huawei com adminActions=true (desktop): ação administrativa aparece', async () => {
    await tap(desktopRow(container, '200.150.1.193'));

    expect(buttonByText(container, 'Desabilitar sessão BGP')).not.toBeNull();
    expect(container.textContent).not.toContain('modo somente leitura');
  });

  it('Juniper com adminActions=false (desktop): ação administrativa NÃO aparece', async () => {
    await tap(desktopRow(container, '200.150.9.9'));

    expect(buttonByText(container, 'Desabilitar sessão BGP')).toBeNull();
    expect(buttonByText(container, 'Reabilitar sessão BGP')).toBeNull();
    expect(container.textContent).toContain('modo somente leitura');
    expect(api.setBgpPeerAdminState).not.toHaveBeenCalled();
  });

  it('Huawei com adminActions=true (celular): card abre o mesmo detalhe com a ação', async () => {
    await tap(mobileCard(container, '200.150.1.193'));

    expect(buttonByText(container, 'Desabilitar sessão BGP')).not.toBeNull();
  });

  it('Juniper com adminActions=false (celular): card abre o detalhe sem a ação', async () => {
    await tap(mobileCard(container, '200.150.9.9'));

    expect(buttonByText(container, 'Desabilitar sessão BGP')).toBeNull();
    expect(buttonByText(container, 'Reabilitar sessão BGP')).toBeNull();
    expect(container.textContent).toContain('modo somente leitura');
    expect(api.setBgpPeerAdminState).not.toHaveBeenCalled();
  });

  it('ações read-only continuam disponíveis no equipamento sem adminActions', async () => {
    await tap(desktopRow(container, '200.150.9.9'));

    expect(buttonByText(container, 'Atualizar agora')).not.toBeNull();
    expect(buttonByText(container, 'Abrir host no inventário')).not.toBeNull();
    expect(buttonByText(container, 'Histórico e tráfego')).not.toBeNull();
    // Juniper tem advertisedRoutes=true: a aba de leitura permanece.
    expect(buttonByText(container, 'Anúncios')).not.toBeNull();
  });
});

describe('aba Anúncios depende de advertisedRoutes', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderDetail(capabilities?: BgpDeviceCapabilities): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(BgpPeerDetail, {
            peer: JUNIPER_PEER,
            period: '1h',
            ...(capabilities ? { capabilities } : {}),
            onClose: () => {},
          }),
        ),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    api.getBgpPeerHistory.mockResolvedValue({ peerId: 'peer-juniper', samples: [], events: [] });
    api.getHistory.mockResolvedValue([]);
  });

  it('mostra a aba Anúncios quando advertisedRoutes=true', async () => {
    await renderDetail(JUNIPER);
    expect(buttonByText(container, 'Anúncios')).not.toBeNull();
  });

  it('esconde a aba Anúncios quando advertisedRoutes=false', async () => {
    await renderDetail(UNSUPPORTED);
    expect(buttonByText(container, 'Anúncios')).toBeNull();
    expect(buttonByText(container, 'Resumo')).not.toBeNull();
  });

  it('sem capabilities mantém o comportamento anterior (aba visível)', async () => {
    await renderDetail();
    expect(buttonByText(container, 'Anúncios')).not.toBeNull();
  });
});
