// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneDemoMaps } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';
import { updateNetworkMap } from '@/lib/api';
import { MapRail } from './map-rail';

vi.mock('@/lib/api', () => ({
  updateNetworkMap: vi.fn().mockResolvedValue(undefined),
  getAlarms: vi.fn().mockResolvedValue([]),
  getRecentResolvedAlarms: vi.fn().mockResolvedValue([]),
}));

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    (item.getAttribute('aria-label') ?? item.textContent ?? '').trim().includes(label),
  );
  if (!button) throw new Error(`Botão ${label} não encontrado`);
  return button;
}

describe('MapRail', () => {
  const map = cloneDemoMaps()[0]!;
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];
  let client: QueryClient;

  async function renderRail() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useMapStore.setState({
      map,
      activeMapId: map.id,
      readOnly: false,
      visualPreset: 'OPERACIONAL',
      layerFilter: 'PROBLEM',
      siteFilter: null,
      deviceTypeFilter: null,
      focusHops: 0,
      selection: null,
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MapRail />
        </QueryClientProvider>,
      );
    });
    return { container };
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    for (const { root, container } of roots.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
    client?.clear();
    vi.clearAllMocks();
    useMapStore.setState({ map: null });
  });

  it('apresenta os três presets e as camadas com contagem', async () => {
    const { container } = await renderRail();

    expect(container.textContent).toContain('Operacional');
    expect(container.textContent).toContain('Topologia');
    expect(container.textContent).toContain('Engenharia');

    for (const layer of ['Todos', 'Com problema', 'DOWN', 'Alarmes', 'Utilização alta']) {
      expect(container.textContent).toContain(layer);
    }
    expect(container.querySelectorAll('.map-rail__layers li')).toHaveLength(5);
  });

  it('o preset Topologia esconde métricas e mantém nomes visíveis', async () => {
    const { container } = await renderRail();

    await act(async () => {
      findButton(container, 'Topologia').click();
    });

    const state = useMapStore.getState();
    expect(state.visualPreset).toBe('TOPOLOGIA');
    expect(state.layerFilter).toBe('ALL');
    expect(state.map?.settings.linkDisplayStyle).toBe('MINIMAL');
    expect(state.map?.settings.linkMetricDisplay).toBe('NONE');
    expect(state.map?.settings.trafficLabelMode).toBe('HIDDEN');
    expect(state.preferences.showLabels).toBe(true);
    expect(state.preferences.showTraffic).toBe(false);
    expect(updateNetworkMap).toHaveBeenCalledWith(
      map.id,
      expect.objectContaining({ settings: expect.objectContaining({ linkDisplayStyle: 'MINIMAL' }) }),
    );
  });

  it('o preset Engenharia liga cards, interfaces e labels na linha', async () => {
    const { container } = await renderRail();

    await act(async () => {
      findButton(container, 'Engenharia').click();
    });

    const state = useMapStore.getState();
    expect(state.map?.settings.nodeDisplayMode).toBe('CARD');
    expect(state.map?.settings.trafficLabelMode).toBe('INLINE');
    expect(state.preferences.showInterfaces).toBe(true);
    expect(state.layerFilter).toBe('ALL');
  });

  it('troca a camada ativa sem alterar o grafo', async () => {
    const { container } = await renderRail();
    const linksBefore = useMapStore.getState().map?.links.length;

    await act(async () => {
      findButton(container, 'DOWN').click();
    });

    expect(useMapStore.getState().layerFilter).toBe('DOWN');
    expect(useMapStore.getState().map?.links.length).toBe(linksBefore);
  });

  it('a vizinhança fica desabilitada sem seleção e libera com um node selecionado', async () => {
    const { container } = await renderRail();
    const hops = [...container.querySelectorAll<HTMLButtonElement>('.map-rail__hops button')];
    expect(hops.map((button) => button.disabled)).toEqual([false, true, true, true]);

    const firstDevice = map.devices[0]!;
    await act(async () => {
      useMapStore.setState({ selection: { kind: 'device', id: firstDevice.id } });
    });
    const enabled = [...container.querySelectorAll<HTMLButtonElement>('.map-rail__hops button')];
    expect(enabled.map((button) => button.disabled)).toEqual([false, false, false, false]);

    await act(async () => {
      enabled[1]!.click();
    });
    expect(useMapStore.getState().focusHops).toBe(1);
  });

  it('mostra o recorte ativo e permite voltar a mostrar tudo', async () => {
    const { container } = await renderRail();

    expect(container.querySelector('.map-rail__cut-summary')).not.toBeNull();

    await act(async () => {
      findButton(container, 'Mostrar tudo').click();
    });

    expect(useMapStore.getState().layerFilter).toBe('ALL');
    expect(useMapStore.getState().siteFilter).toBeNull();
    expect(useMapStore.getState().deviceTypeFilter).toBeNull();
    expect(useMapStore.getState().focusHops).toBe(0);
  });

  it('a legenda usa as pills de estado do design system', async () => {
    const { container } = await renderRail();

    const legend = container.querySelector('.map-rail__legend')!;
    expect(legend.querySelectorAll('.nv-status')).toHaveLength(4);
    expect(legend.textContent).toContain('UP');
    expect(legend.textContent).toContain('WARNING');
    expect(legend.textContent).toContain('DOWN');
    expect(legend.textContent).toContain('UNKNOWN');
  });
});
