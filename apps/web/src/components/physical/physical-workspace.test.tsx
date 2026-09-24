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
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ...api,
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
