/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneDemoMaps, type HostRecord } from '@gmj/shared';
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

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe('HostsWorkspace host deletion', () => {
  let container: HTMLDivElement;
  let root: Root;
  let host: HostRecord;

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    host = structuredClone(cloneDemoMaps()[0]!.devices.find((device) => device.id === 'internet')!);
    api.getHosts.mockResolvedValue([host]);
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
    await settle();
    await act(async () => {
      container.querySelector<HTMLTableRowElement>('tbody tr')?.click();
    });
    expect(container.querySelector('.host-detail')).not.toBeNull();
    await act(async () => findButton(container, 'Excluir').click());
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('does not call DELETE when the user cancels confirmation', async () => {
    await act(async () => findButton(container, 'Cancelar').click());

    expect(api.deleteHost).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('.host-detail')).not.toBeNull();
  });

  it('keeps the host and drawer visible when the API rejects deletion', async () => {
    api.deleteHost.mockRejectedValueOnce(new Error('API 500'));
    await act(async () => findButton(container, 'Excluir host').click());
    await settle();

    expect(api.deleteHost).toHaveBeenCalledWith(host.id);
    expect(container.querySelector('.host-detail')).not.toBeNull();
    expect(container.querySelector('tbody')?.textContent).toContain(host.hostname);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Nenhum dado foi removido',
    );
  });

  it('closes the drawer and refreshes inventory only after HTTP success', async () => {
    api.deleteHost.mockResolvedValueOnce(undefined);
    api.getHosts.mockResolvedValueOnce([]);
    await act(async () => findButton(container, 'Excluir host').click());
    await settle();

    expect(api.deleteHost).toHaveBeenCalledWith(host.id);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('.host-detail')).toBeNull();
    expect(container.querySelector('tbody')?.textContent).not.toContain(host.hostname);
  });
});
