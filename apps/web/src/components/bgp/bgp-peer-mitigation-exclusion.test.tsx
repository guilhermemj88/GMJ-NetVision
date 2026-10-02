// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BgpDashboardDevice, BgpDashboardPeer } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A tela do peer usa os dois clientes: BGP (historico/admin) e mitigacao
// (exclusao preventiva por peer).
const api = vi.hoisted(() => ({
  getBgpPeerHistory: vi.fn(),
  getHistory: vi.fn(),
  setBgpPeerAdminState: vi.fn(),
}));
vi.mock('@/lib/api', () => api);

const mitigationApi = vi.hoisted(() => ({
  setBgpPeerMitigationExclusion: vi.fn(),
}));
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

import { BgpPeerDetail } from './bgp-peer-detail';
import { BgpPeerTable } from './bgp-peer-table';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function peer(overrides: Partial<BgpDashboardPeer> = {}): BgpDashboardPeer {
  return {
    id: 'p1',
    deviceId: 'ne8000-1',
    deviceHostname: 'NE8000-1',
    deviceDisplayName: 'NE-8K POP CENTRO',
    bgpMonitoringEnabled: true,
    peerAddress: '198.18.1.152',
    displayName: 'IP-SEABORN',
    addressFamily: 'IPV4',
    localAs: '268568',
    remoteAs: '13786',
    role: 'OTHER',
    monitoringEnabled: true,
    stateCode: 6,
    state: 'ESTABLISHED',
    established: true,
    adminState: 'ENABLED',
    adminStateCheckedAt: '2026-09-30T10:00:00.000Z',
    receivedPrefixes: 1_076_334,
    establishedSince: '2026-09-01T00:00:00.000Z',
    lastPollingAt: '2026-09-30T11:00:00.000Z',
    lastDiscoveryAt: '2026-09-30T10:00:00.000Z',
    interface: {
      id: 'if-transit',
      name: 'Eth-Trunk1.2593',
      alias: 'IP-SEABORN',
      description: null,
      rxBps: 4_800_000_000,
      txBps: 2_100_000_000,
    },
    ...overrides,
  };
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const target = container;
  await act(async () => {
    root = createRoot(target);
    root.render(createElement(QueryClientProvider, { client: queryClient }, element));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return target;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  if (container) container.remove();
  container = null;
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // Esta suíte cobre o ambiente do projeto IMPLANTAR: mitigação DDoS exposta.
  vi.stubEnv('NEXT_PUBLIC_DDOS_MITIGATION_UI', 'true');
  vi.clearAllMocks();
  api.getBgpPeerHistory.mockResolvedValue({ peerId: 'p1', samples: [], events: [] });
  api.getHistory.mockResolvedValue([]);
  api.setBgpPeerAdminState.mockResolvedValue({ success: true, message: 'ok' });
  mitigationApi.setBgpPeerMitigationExclusion.mockResolvedValue({
    peerId: 'p1',
    excluded: true,
    reason: 'TRANSIT',
    note: 'Upstream IP-SEABORN',
    deviceId: 'ne8000-1',
    peerAddress: '198.18.1.152',
    addressFamily: 'IPV4',
    updatedAt: '2026-09-30T20:00:00.000Z',
    persisted: true,
  });
});

describe('exclusao preventiva por peer na tela de BGP', () => {
  it('mostra a secao PROTEÇÃO CONTRA MITIGAÇÃO sem motivo quando o peer nao esta excluido', async () => {
    const el = await render(
      createElement(BgpPeerDetail, { peer: peer(), period: '1h', onClose: () => {} }),
    );

    expect(el.textContent).toContain('PROTEÇÃO CONTRA MITIGAÇÃO');
    expect(el.textContent).toContain('Nunca mitigar este peer');
    expect(el.textContent).not.toContain('Motivo da exclusão');
    expect(el.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(el.textContent).not.toContain('Excluído da mitigação');
  });

  it('salva a exclusao do peer (motivo + observacao) e mostra o badge', async () => {
    const el = await render(
      createElement(BgpPeerDetail, { peer: peer(), period: '1h', onClose: () => {} }),
    );

    const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => {
      checkbox!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Motivo da exclusão"]');
    expect(select).not.toBeNull();
    await act(async () => {
      setNativeValue(select!, 'TRANSIT');
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const note = el.querySelector<HTMLInputElement>('input[aria-label="Observação da exclusão"]');
    expect(note).not.toBeNull();
    await act(async () => {
      setNativeValue(note!, 'Upstream IP-SEABORN');
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const save = Array.from(el.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'SALVAR',
    );
    expect(save).toBeDefined();
    await act(async () => {
      save!.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(mitigationApi.setBgpPeerMitigationExclusion).toHaveBeenCalledWith('p1', {
      excluded: true,
      reason: 'TRANSIT',
      note: 'Upstream IP-SEABORN',
    });
    expect(el.textContent).toContain('Excluído da mitigação');
    expect(el.textContent).toContain('Salvo: este peer não será mais mitigado.');
  });

  it('peer ja excluido abre marcado, com motivo e observacao do servidor', async () => {
    const el = await render(
      createElement(BgpPeerDetail, {
        peer: peer({
          mitigationExcluded: true,
          mitigationExclusionReason: 'TRANSIT',
          mitigationExclusionNote: 'Upstream IP-SEABORN',
        }),
        period: '1h',
        onClose: () => {},
      }),
    );

    expect(el.textContent).toContain('Excluído da mitigação');
    const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Motivo da exclusão"]');
    expect(select?.value).toBe('TRANSIT');
  });

  it('a lista de peers mostra o badge de exclusao', async () => {
    const device: BgpDashboardDevice = {
      id: 'ne8000-1',
      hostname: 'NE8000-1',
      displayName: 'NE-8K POP CENTRO',
      bgpMonitoringEnabled: true,
      peers: [
        peer({
          mitigationExcluded: true,
          mitigationExclusionReason: 'TRANSIT',
          mitigationExclusionNote: 'Upstream IP-SEABORN',
        }),
      ],
    };

    const el = await render(
      createElement(BgpPeerTable, { devices: [device], onSelectPeer: () => {} }),
    );

    expect(el.textContent).toContain('🛡 Excluído da mitigação');
  });
});

/**
 * No NetVision geral (`NEXT_PUBLIC_DDOS_MITIGATION_UI` ausente/false) a
 * mitigação não é exposta: nem o editor operacional no detalhe do peer, nem o
 * badge da lista. O BGP normal (peer detail e tabela) continua funcionando.
 */
describe('mitigação oculta no NetVision geral', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    api.getBgpPeerHistory.mockResolvedValue({ peerId: 'p1', samples: [], events: [] });
    api.getHistory.mockResolvedValue([]);
    api.setBgpPeerAdminState.mockResolvedValue({ success: true, message: 'ok' });
  });

  it('detalhe do peer não mostra o bloco operacional de mitigação', async () => {
    const el = await render(
      createElement(BgpPeerDetail, { peer: peer(), period: '1h', onClose: () => {} }),
    );
    expect(el.textContent).not.toContain('PROTEÇÃO CONTRA MITIGAÇÃO');
    expect(el.textContent).not.toContain('Nunca mitigar este peer');
    // o restante do detalhe do peer continua presente
    expect(el.textContent).toContain('IP-SEABORN');
  });

  it('lista de peers não mostra o badge de exclusão da mitigação', async () => {
    const device: BgpDashboardDevice = {
      id: 'ne8000-1',
      hostname: 'NE8000-1',
      displayName: 'NE-8K POP CENTRO',
      bgpMonitoringEnabled: true,
      peers: [
        peer({
          mitigationExcluded: true,
          mitigationExclusionReason: 'TRANSIT',
          mitigationExclusionNote: 'Upstream IP-SEABORN',
        }),
      ],
    };
    const el = await render(
      createElement(BgpPeerTable, { devices: [device], onSelectPeer: () => {} }),
    );
    expect(el.textContent).not.toContain('Excluído da mitigação');
    // a tabela de peers continua renderizando normalmente
    expect(el.textContent).toContain('IP-SEABORN');
  });
});
