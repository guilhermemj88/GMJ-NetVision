/* @vitest-environment jsdom */

import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalWorkspace } from './physical-workspace';
import {
  physicalAsset,
  physicalInventory,
  physicalPort,
  physicalRack,
  physicalTemplate,
} from './physical-fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const api = vi.hoisted(() => ({
  getPhysicalInventory: vi.fn(),
  getPhysicalCatalog: vi.fn(),
  getHosts: vi.fn(),
  getPhysicalPath: vi.fn(),
  confirmPhysicalLldp: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ...api,
}));

/** O fluxo LLDP só aparece para quem pode editar (ADMIN/OPERATOR). */
vi.mock('@/app/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/providers')>()),
  useAuth: () => ({
    user: { id: 'user-1', username: 'admin', displayName: 'Admin', role: 'ADMIN' },
    loading: false,
    signIn: async () => undefined,
    logout: async () => undefined,
  }),
}));

/** Modelo com renderer técnico declarado no catálogo (o desenho muda de verdade). */
const asset = physicalAsset({
  id: 'asset-ws-1',
  name: 'SW-01',
  startU: 12,
  heightU: 1,
  templateId: 'template-ws-1',
  template: physicalTemplate({
    id: 'template-ws-1',
    catalogKey: 'huawei-s6730-h48x6c',
    name: 'Huawei S6730-H48X6C',
    model: 'S6730-H48X6C',
    manufacturer: 'Huawei',
    category: 'SWITCH',
    kind: 'NETWORK',
  }),
  ports: [
    physicalPort({
      id: 'asset-ws-1-port-1',
      assetId: 'asset-ws-1',
      name: 'GE1',
      label: 'GE1',
      order: 1,
    }),
  ],
});

const inventory = physicalInventory({
  sites: [
    {
      id: 'site-1',
      name: 'POP Centro',
      code: 'CTO',
      description: '',
      racks: [physicalRack({ id: 'rack-1', units: 12, assets: [asset] })],
      createdAt: '2026-09-21T12:00:00.000Z',
      updatedAt: '2026-09-21T12:00:00.000Z',
    },
  ],
});

describe('PhysicalWorkspace — visão padrão', () => {
  let container: HTMLDivElement;
  let root: Root;

  /** Deixa a consulta do inventário resolver (react-query é assíncrono). */
  async function flush(times = 3) {
    for (let index = 0; index < times; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  beforeEach(async () => {
    api.getPhysicalInventory.mockResolvedValue(inventory);
    api.getPhysicalCatalog.mockResolvedValue([]);
    api.getHosts.mockResolvedValue([]);
    api.getPhysicalPath.mockResolvedValue(null);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PhysicalWorkspace />
        </QueryClientProvider>,
      );
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function toggleButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('.physical-visual__options button')];
  }

  it('abre no modo técnico e mostra Técnica antes de Real', () => {
    expect(toggleButtons().map((button) => button.textContent?.trim())).toEqual([
      'Técnica',
      'Real',
    ]);
    expect(toggleButtons()[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(toggleButtons()[1]!.getAttribute('aria-pressed')).toBe('false');
    // a escolha chega explicitamente ao canvas (a regra vem da workspace)
    expect(container.querySelector('.physical-canvas.is-technical')).not.toBeNull();
    expect(container.querySelector('[data-visual="TECHNICAL"]')).not.toBeNull();
    expect(container.querySelector('[data-visual="REAL"]')).toBeNull();
  });

  it('o modo real continua disponível como alternativa', async () => {
    await act(async () => {
      toggleButtons()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggleButtons()[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-visual="REAL"]')).not.toBeNull();
    expect(container.querySelector('.physical-canvas.is-technical')).toBeNull();

    await act(async () => {
      toggleButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-visual="TECHNICAL"]')).not.toBeNull();
    expect(container.querySelector('.physical-canvas.is-technical')).not.toBeNull();
  });
});

describe('PhysicalWorkspace · fluxo LLDP', () => {
  let container: HTMLDivElement;
  let root: Root;

  const swA = physicalAsset({
    id: 'asset-a',
    name: 'SW-A',
    startU: 10,
    heightU: 1,
    ports: [
      physicalPort({ id: 'port-a', assetId: 'asset-a', name: 'GE1', state: 'LLDP_DETECTED' }),
    ],
  });
  const swB = physicalAsset({
    id: 'asset-b',
    name: 'SW-B',
    startU: 8,
    heightU: 1,
    ports: [physicalPort({ id: 'port-b', assetId: 'asset-b', name: 'GE2' })],
  });
  const suggestion = {
    adjacencyId: 'lldp-ws-1',
    confidence: 'CONFIRMED',
    state: 'READY' as const,
    local: {
      assetId: 'asset-a',
      assetName: 'SW-A',
      portId: 'port-a',
      portName: 'GE1',
      rackName: 'Rack 01',
      siteName: 'POP Centro',
    },
    remote: {
      assetId: 'asset-b',
      assetName: 'SW-B',
      portId: 'port-b',
      portName: 'GE2',
      rackName: 'Rack 01',
      siteName: 'POP Centro',
    },
    localPortName: 'GE1',
    remoteHostname: 'SW-B',
    remotePortName: 'GE2',
    observedAt: '2026-09-21T11:00:00.000Z',
    reason: 'Ambos os lados estão no inventário físico.',
  };
  const withSuggestion = physicalInventory({
    sites: [
      {
        id: 'site-1',
        name: 'POP Centro',
        code: 'CTO',
        description: '',
        racks: [physicalRack({ id: 'rack-1', units: 12, assets: [swA, swB] })],
        createdAt: '2026-09-21T12:00:00.000Z',
        updatedAt: '2026-09-21T12:00:00.000Z',
      },
    ],
    lldpSuggestions: [suggestion],
    lldpObservedAt: '2026-09-21T11:00:00.000Z',
  });
  const withoutSuggestion = physicalInventory({
    sites: withSuggestion.sites,
    connections: withSuggestion.connections,
    lldpSuggestions: [],
    lldpObservedAt: '2026-09-21T11:00:00.000Z',
  });

  async function flush(times = 4) {
    for (let index = 0; index < times; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  beforeEach(async () => {
    api.getPhysicalInventory
      .mockResolvedValueOnce(withSuggestion)
      .mockResolvedValue(withoutSuggestion);
    api.getPhysicalCatalog.mockResolvedValue([]);
    api.getHosts.mockResolvedValue([]);
    api.getPhysicalPath.mockResolvedValue(null);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PhysicalWorkspace />
        </QueryClientProvider>,
      );
    });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function click(selector: string) {
    const element = container.querySelector(selector);
    if (!element) throw new Error(`elemento ausente: ${selector}`);
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('seleciona o ghost, confirma com o medium escolhido e o cabo substitui a sugestão', async () => {
    api.confirmPhysicalLldp.mockResolvedValue({ id: 'connection-new' });

    expect(container.querySelector('.physical-lldp-ghost')).not.toBeNull();
    click('.physical-lldp-hit');
    await flush(2);

    expect(container.textContent).toContain('SUGESTÃO LLDP');
    const select = container.querySelector<HTMLSelectElement>('.physical-lldp-confirm select');
    expect(select).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )?.set;
      setter?.call(select, 'AOC');
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const confirm = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Confirmar conexão física'),
    );
    expect(confirm).toBeDefined();
    act(() => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush(4);

    expect(api.confirmPhysicalLldp).toHaveBeenCalledWith('lldp-ws-1', 'AOC');
    // Depois do refresh o ghost some: a sugestão virou cabo persistido.
    expect(container.querySelector('.physical-lldp-ghost')).toBeNull();
  });

  it('409 mantém a sugestão visível e mostra o erro', async () => {
    api.confirmPhysicalLldp.mockRejectedValue(new Error('Uma das portas já está ocupada'));
    api.getPhysicalInventory.mockResolvedValue(withSuggestion);

    click('.physical-lldp-hit');
    await flush(2);
    const confirm = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Confirmar conexão física'),
    );
    act(() => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush(4);

    expect(container.textContent).toContain('Uma das portas já está ocupada');
    expect(container.querySelector('.physical-lldp-ghost')).not.toBeNull();
  });
});
