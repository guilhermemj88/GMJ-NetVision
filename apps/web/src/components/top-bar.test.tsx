// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AlertCenterSummary } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';

const api = vi.hoisted(() => ({ getAlertCenterSummary: vi.fn() }));
const auth = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('@/lib/api', () => api);
vi.mock('@/app/providers', () => auth);
vi.mock('./global-interface-search', () => ({ GlobalInterfaceSearch: () => null }));
vi.mock('./freshness-tag', () => ({ FreshnessTag: () => null }));

import { TopBar } from './top-bar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function summary(patch: Partial<AlertCenterSummary> = {}): AlertCenterSummary {
  return {
    alarmsActive: 0,
    alarmsActiveCritical: 0,
    alarmsActiveMajor: 0,
    alarmsActiveWarning: 0,
    alarmsActiveInfo: 0,
    alarmsActiveUnacknowledged: 0,
    alarmsActiveAcknowledged: 0,
    occurrencesUnacknowledged: 0,
    occurrencesAcknowledged: 0,
    occurrencesQuiet24h: 0,
    ...patch,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function navButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('.primary-nav button')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Nav não encontrada: ${label}`);
  return button;
}

describe('TopBar — acesso a Central de Alertas (F9.3)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    auth.useAuth.mockReturnValue({
      user: { id: 'u1', name: 'QA', email: 'qa@preview.local', username: 'qa-preview', role: 'ADMIN' },
      logout: vi.fn(),
    });
    api.getAlertCenterSummary.mockResolvedValue({ summary: summary() });
    // View fora do MAPA: a TopBar completa (com a navegacao) fica visivel.
    useMapStore.setState({ view: 'HOSTS', map: null, maps: [], activeMapId: null, panel: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(TopBar)));
    });
    await settle();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it('mostra o botao ALERTAS na navegacao principal', () => {
    const labels = Array.from(container.querySelectorAll('.primary-nav button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels.some((label) => label?.includes('Alertas'))).toBe(true);
    // Navegacao existente preservada.
    expect(labels.some((label) => label?.includes('Físico'))).toBe(true);
    expect(labels.some((label) => label?.includes('Mapa'))).toBe(true);
    expect(labels.some((label) => label?.includes('Hosts'))).toBe(true);
    expect(labels.some((label) => label?.includes('BGP'))).toBe(true);
  });

  it('clicar em ALERTAS muda a workspace para ALERTS', async () => {
    await act(async () => {
      navButton(container, 'Alertas').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(useMapStore.getState().view).toBe('ALERTS');
  });

  it('mostra o badge com o que exige atencao (alarme nao reconhecido + ocorrencia vigente)', async () => {
    api.getAlertCenterSummary.mockResolvedValue({
      summary: summary({ alarmsActiveUnacknowledged: 3, occurrencesUnacknowledged: 2, alarmsActive: 9 }),
    });
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    const badge = container.querySelector('.primary-nav__badge');
    expect(badge?.textContent).toBe('5');
  });

  it('sem pendencias nao mostra badge', () => {
    expect(container.querySelector('.primary-nav__badge')).toBeNull();
  });
});
