// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollHost } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { refreshHostQueries, VerifyHostButton } from './verify-host-button';

vi.mock('@/lib/api', () => ({ pollHost: vi.fn() }));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('VerifyHostButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const showToast = vi.fn();

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    useMapStore.setState({ showToast });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it('polls the selected host, disables itself, and refreshes host/interface/map queries', async () => {
    const request = deferred<Awaited<ReturnType<typeof pollHost>>>();
    vi.mocked(pollHost).mockReturnValue(request.promise);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <VerifyHostButton hostId="huawei-s6750" enabled compact />
        </QueryClientProvider>,
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(pollHost).toHaveBeenCalledWith('huawei-s6750');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('VERIFICANDO...');

    await act(async () => {
      request.resolve({
        hostId: 'huawei-s6750',
        polledAt: '2026-08-24T12:00:00.000Z',
        interfacesChecked: 42,
        interfaceSamples: 0,
      });
      await request.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('VERIFICADO AGORA');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['hosts'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['interfaces', 'huawei-s6750'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['map'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['host-mpls', 'huawei-s6750'] });
    expect(showToast).toHaveBeenCalledWith(
      'Equipamento atualizado com sucesso · 42 interfaces verificadas',
    );
  });

  it('shows a non-blocking failure and allows retrying', async () => {
    vi.mocked(pollHost).mockRejectedValue(new Error('SNMP timeout'));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <VerifyHostButton hostId="huawei-s6750" enabled />
        </QueryClientProvider>,
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });

    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('VERIFICAR AGORA');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Falha ao verificar equipamento',
    );
    expect(showToast).toHaveBeenCalledWith('Falha ao verificar equipamento');
  });

  it('refetches an active map so updated interfaces and dependent links become UP immediately', async () => {
    let currentStatus: 'DOWN' | 'UP' = 'DOWN';
    const observer = new QueryObserver(client, {
      queryKey: ['map', 'backbone'],
      queryFn: async () => ({
        devices: [{ id: 'huawei-s6750', interfaces: [{ id: 'if-24', operStatus: currentStatus }] }],
        links: [{ id: 'link-24', sourceInterfaceId: 'if-24', status: currentStatus }],
      }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.links[0]?.status).toBe('DOWN'));

    currentStatus = 'UP';
    await refreshHostQueries(client, 'huawei-s6750');

    expect(observer.getCurrentResult().data?.devices[0]?.interfaces[0]?.operStatus).toBe('UP');
    expect(observer.getCurrentResult().data?.links[0]?.status).toBe('UP');
    unsubscribe();
  });
});
