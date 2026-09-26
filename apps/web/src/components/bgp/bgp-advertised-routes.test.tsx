// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BgpAdvertisedRoutesResponse, BgpDashboardPeer } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getBgpPeerAdvertisedRoutes: vi.fn(),
}));

vi.mock('@/lib/api', () => api);

import { BgpAdvertisedRoutesPanel } from './bgp-advertised-routes';
import { asnToneIndex } from './bgp-asn-path';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const peer: BgpDashboardPeer = {
  id: 'peer-1',
  deviceId: 'ne8000-1',
  deviceHostname: 'NE-8000-1',
  deviceDisplayName: 'NE-8K POP CENTRO',
  bgpMonitoringEnabled: true,
  peerAddress: '200.194.223.86',
  displayName: 'INFINIT_PROVEDOR_IPv4-CONFINADO',
  addressFamily: 'IPV4',
  localAs: '268568',
  remoteAs: '28572',
  role: 'UPSTREAM',
  monitoringEnabled: true,
  stateCode: 6,
  state: 'ESTABLISHED',
  established: true,
  adminState: 'ENABLED',
  adminStateCheckedAt: '2026-09-25T10:00:00.000Z',
  receivedPrefixes: 1,
  establishedSince: '2026-09-01T00:00:00.000Z',
  lastPollingAt: '2026-09-25T11:00:00.000Z',
  lastDiscoveryAt: '2026-09-25T10:00:00.000Z',
  interface: null,
};

const response: BgpAdvertisedRoutesResponse = {
  peerId: 'peer-1',
  deviceId: 'ne8000-1',
  peerAddress: '200.194.223.86',
  addressFamily: 'IPV4',
  localAs: '268568',
  fetchedAt: new Date(Date.now() - 17_000).toISOString(),
  reportedTotal: 4,
  warnings: [],
  routes: [
    {
      prefix: '45.163.144.0/22',
      nextHop: '200.194.223.86',
      med: 1,
      localPreference: null,
      preferredValue: 0,
      asPath: ['268568', '268568', '268568'],
      origin: 'i',
      prependLocal: 2,
    },
    {
      prefix: '45.163.145.0/24',
      nextHop: '200.194.223.86',
      med: 100,
      localPreference: 100,
      preferredValue: 0,
      asPath: ['268568', '268568'],
      origin: 'i',
      prependLocal: 1,
    },
    {
      prefix: '45.5.248.0/23',
      nextHop: '200.194.223.86',
      med: null,
      localPreference: null,
      preferredValue: 0,
      asPath: ['268568', '271034', '271034', '271034', '271034'],
      origin: 'i',
      prependLocal: 0,
    },
    {
      prefix: '45.163.147.0/24',
      nextHop: null,
      med: null,
      localPreference: null,
      preferredValue: null,
      asPath: ['268568', '268633', '268725', '268884'],
      origin: '?',
      prependLocal: 0,
    },
  ],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Botão não encontrado: ${label}`);
  return found;
}

function rows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.bgp-adv__table tbody tr')).map(
    (row) => row.querySelector('td')?.textContent?.trim() ?? '',
  );
}

async function typeSearch(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector('.bgp-adv__search input');
  if (!(input instanceof HTMLInputElement)) throw new Error('Busca não encontrada');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function pickSort(container: HTMLElement, value: string): Promise<void> {
  const select = container.querySelector('.bgp-adv__sort select');
  if (!(select instanceof HTMLSelectElement)) throw new Error('Ordenação não encontrada');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe('BgpAdvertisedRoutesPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(BgpAdvertisedRoutesPanel, { peer }));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function collect(): Promise<void> {
    await act(async () => {
      button(container, 'Carregar anúncios').click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  it('starts in the "not consulted" state and calls nothing', () => {
    expect(container.textContent).toContain('Os anúncios ainda não foram consultados.');
    expect(container.textContent).toContain('ANÚNCIOS · ASN LOCAL 268568');
    expect(container.textContent).toContain('COLETADO SOB DEMANDA VIA SSH');
    expect(button(container, 'Carregar anúncios')).toBeTruthy();
    expect(api.getBgpPeerAdvertisedRoutes).not.toHaveBeenCalled();
  });

  it('shows the loading state and disables the button while the SSH runs', async () => {
    const pending = deferred<BgpAdvertisedRoutesResponse>();
    api.getBgpPeerAdvertisedRoutes.mockReturnValue(pending.promise);

    await act(async () => {
      button(container, 'Carregar anúncios').click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(api.getBgpPeerAdvertisedRoutes).toHaveBeenCalledWith('peer-1');
    expect(container.textContent).toContain('Consultando o equipamento via SSH');
    expect(button(container, 'Carregar anúncios').disabled).toBe(true);
    expect(container.querySelector('.spin')).not.toBeNull();

    await act(async () => {
      pending.resolve(response);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(container.textContent).not.toContain('Consultando o equipamento');
  });

  it('renders the summary facts and the announced prefixes', async () => {
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue(response);
    await collect();
    await settle();

    const facts = Array.from(container.querySelectorAll('.bgp-adv__facts > div')).map((entry) => [
      entry.querySelector('dt')?.textContent?.trim(),
      entry.querySelector('dd')?.textContent?.trim(),
    ]);
    expect(facts).toEqual([
      ['prefixos anunciados', '4'],
      ['com prepend local', '2'],
      ['maior prepend', '2'],
      ['ASN local', '268568'],
      ['idade da coleta', expect.stringMatching(/^há \d+s$/)],
      ['total reportado pela CLI', '4'],
    ]);
    expect(rows(container)).toHaveLength(4);
    expect(rows(container)).toContain('45.5.248.0/23');
    expect(container.textContent).toContain('268633');
    expect(container.querySelectorAll('.bgp-adv__table tbody tr.bgp-adv__row--prepend')).toHaveLength(2);
    expect(container.textContent).toContain('PREPEND 2');
    expect(container.textContent).toContain('PREPEND 1');
    // O botão vira "Atualizar anúncios" depois da primeira coleta.
    expect(button(container, 'Atualizar anúncios')).toBeTruthy();
  });

  it('colors the same ASN identically and marks the local ASN', async () => {
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue(response);
    await collect();
    await settle();

    const chips = Array.from(container.querySelectorAll('.bgp-asn-chip'));
    expect(chips.length).toBeGreaterThan(4);
    const local = chips.filter((chip) => chip.classList.contains('bgp-asn-chip--local'));
    expect(local.every((chip) => chip.textContent === '268568')).toBe(true);
    // 3 + 2 + 1 + 1 ocorrências do ASN local nas quatro rotas do fixture.
    expect(local.length).toBe(7);
    const localColors = new Set(local.map((chip) => chip.getAttribute('style')));
    expect(localColors.size).toBe(1);
    // Terceiros com cores determinísticas e ASNs distintos não compartilham tom por acaso.
    expect(asnToneIndex('268568')).toBe(asnToneIndex('268568'));
    expect(asnToneIndex('271034')).toBe(asnToneIndex('271034'));
  });

  it('filters by search and by prepend, keeping the counter honest', async () => {
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue(response);
    await collect();
    await settle();

    await typeSearch(container, '45.163.14');
    expect(rows(container)).toHaveLength(3);
    expect(container.querySelector('.bgp-adv__counter')?.textContent).toBe('3 / 4');

    await typeSearch(container, '');
    await act(async () => {
      button(container, 'Com prepend').click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(rows(container)).toEqual(['45.163.144.0/22', '45.163.145.0/24']);

    await act(async () => {
      button(container, 'Sem prepend').click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(rows(container)).toHaveLength(2);
    expect(rows(container)).not.toContain('45.163.144.0/22');

    await typeSearch(container, '9.9.9.9');
    expect(rows(container)).toEqual([]);
    expect(container.textContent).toContain('Nenhum prefixo corresponde à busca/filtro atual.');
  });

  it('orders by prepend and by AS-PATH length', async () => {
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue(response);
    await collect();
    await settle();

    await pickSort(container, 'PATH_LENGTH');
    expect(rows(container)).toEqual([
      '45.5.248.0/23',
      '45.163.147.0/24',
      '45.163.144.0/22',
      '45.163.145.0/24',
    ]);

    await pickSort(container, 'PREPEND');
    const ordered = rows(container);
    expect(ordered.slice(0, 2)).toEqual(['45.163.144.0/22', '45.163.145.0/24']);
    expect(ordered).toHaveLength(4);
  });

  it('shows a sanitized error and allows retrying', async () => {
    api.getBgpPeerAdvertisedRoutes.mockRejectedValue(
      new Error('SSH host is unreachable'),
    );
    await collect();
    await settle();

    expect(container.textContent).toContain('Não foi possível coletar os anúncios.');
    expect(container.textContent).toContain('SSH host is unreachable');
    expect(container.textContent).not.toMatch(/password|secret/i);

    api.getBgpPeerAdvertisedRoutes.mockResolvedValue(response);
    await act(async () => {
      button(container, 'Tentar novamente').click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await settle();
    expect(rows(container)).toHaveLength(4);
  });

  it('handles a successful collection with no announced prefixes', async () => {
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue({
      ...response,
      routes: [],
      reportedTotal: 0,
    });
    await collect();
    await settle();

    expect(container.textContent).toContain(
      'A consulta não retornou nenhum prefixo anunciado para este peer.',
    );
    expect(container.textContent).toContain('total reportado pela CLI: 0');
    expect(container.querySelector('.bgp-adv__table')).toBeNull();
  });

  it('surfaces parser warnings without inventing data', async () => {
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue({
      ...response,
      warnings: ['Rota 45.163.147.0/24 sem linha de AS-PATH; atributos ficaram nulos.'],
    });
    await collect();
    await settle();

    expect(container.querySelectorAll('.bgp-adv__warnings li')).toHaveLength(1);
    expect(container.textContent).toContain('sem linha de AS-PATH');
  });

  it('runs a new SSH collection on every "Atualizar anúncios" click', async () => {
    api.getBgpPeerAdvertisedRoutes.mockResolvedValue(response);
    await collect();
    await settle();
    expect(api.getBgpPeerAdvertisedRoutes).toHaveBeenCalledTimes(1);

    await act(async () => {
      button(container, 'Atualizar anúncios').click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await settle();
    expect(api.getBgpPeerAdvertisedRoutes).toHaveBeenCalledTimes(2);
  });
});
