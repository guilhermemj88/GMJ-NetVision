// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneDemoMaps } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';
import { useMapStore } from '@/store/map-store';
import { updateNetworkMap } from '@/lib/api';
import { MAP_LAYERS_PANEL_COLLAPSED_KEY } from '@/lib/map-layers-panel';
import { AlarmPanel } from './alarm-panel';
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
  const showToast = vi.fn();
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
      showToast,
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
    window.localStorage.clear();
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

  it('apresenta os quatro presets e as camadas com contagem', async () => {
    const { container } = await renderRail();

    expect(container.textContent).toContain('Operacional');
    expect(container.textContent).toContain('Topologia');
    expect(container.textContent).toContain('Engenharia');
    expect(container.textContent).toContain('WeatherMap');

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

  it('o preset WeatherMap traz a escala sugerida junto com a apresentacao', async () => {
    const { container } = await renderRail();

    await act(async () => {
      findButton(container, 'WeatherMap').click();
    });

    const state = useMapStore.getState();
    expect(state.visualPreset).toBe('WEATHERMAP');
    expect(state.map?.settings).toMatchObject({
      nodeDisplayMode: 'ICON_2D',
      linkDisplayStyle: 'WEATHERMAP',
      linkMetricDisplay: 'BOTH',
      trafficLabelMode: 'CARD',
      nodeScale: 75,
      linkScale: 140,
      labelScale: 85,
    });
    expect(updateNetworkMap).toHaveBeenCalledWith(
      map.id,
      expect.objectContaining({
        settings: expect.objectContaining({ linkScale: 140, nodeScale: 75, labelScale: 85 }),
      }),
    );
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('escala 75/140/85'));
  });

  it('nao sobrescreve a escala ajustada a mao ao trocar de preset', async () => {
    const { container } = await renderRail();

    await act(async () => {
      useMapStore.getState().setMapScales({ nodeScale: 120, linkScale: 120, labelScale: 120 });
    });
    await act(async () => {
      findButton(container, 'Topologia').click();
    });

    expect(useMapStore.getState().map?.settings).toMatchObject({
      nodeScale: 120,
      linkScale: 120,
      labelScale: 120,
      linkDisplayStyle: 'MINIMAL',
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('escala mantida'));
  });

  it('mantem Visualizacao & escala visivel e mostra o estado atual', async () => {
    const { container } = await renderRail();

    const details = container.querySelector<HTMLDetailsElement>('details.map-rail__details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(true);
    expect(details!.querySelector('.map-rail__details-state')?.textContent).toContain('100/100/100');
    expect(details!.textContent).toContain('ESCALA');
    expect(details!.textContent).toContain('Equipamentos');
    expect(details!.textContent).toContain('Enlaces');
    expect(details!.textContent).toContain('Labels');
    expect(details!.textContent).toContain('WeatherMap');
    expect(details!.textContent).toContain('GEOMETRIA');
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

  it('começa aberto, recolhe pelo chevron e volta pela rail discreta', async () => {
    const { container } = await renderRail();

    // Aberto por padrão: cabeçalho, seções e chevron de recolher.
    expect(container.querySelector('.map-rail--collapsed')).toBeNull();
    expect(container.querySelector('.map-rail__header')).not.toBeNull();
    expect(container.querySelector('.map-rail__scroll')).not.toBeNull();
    const collapseButton = container.querySelector<HTMLButtonElement>('.map-rail__collapse')!;
    expect(collapseButton.getAttribute('aria-label')).toBe('Recolher camadas do mapa');

    await act(async () => {
      collapseButton.click();
    });

    // Recolhido: nenhuma coluna vazia — só a rail fina com a seta invertida.
    const collapsedRail = container.querySelector('.map-rail--collapsed')!;
    expect(collapsedRail).not.toBeNull();
    expect(collapsedRail.getAttribute('data-collapsed')).toBe('true');
    expect(container.querySelector('.map-rail__scroll')).toBeNull();
    expect(container.querySelector('.map-rail__header')).toBeNull();
    const restoreButton = container.querySelector<HTMLButtonElement>('.map-rail__restore')!;
    expect(restoreButton.getAttribute('aria-label')).toBe('Expandir camadas do mapa');
    expect(restoreButton.getAttribute('aria-expanded')).toBe('false');
    expect(restoreButton.textContent).toContain('Camadas do mapa');

    await act(async () => {
      restoreButton.click();
    });

    // Volta exatamente como estava.
    expect(container.querySelector('.map-rail--collapsed')).toBeNull();
    expect(container.querySelector('.map-rail__header')).not.toBeNull();
    expect(container.querySelectorAll('.map-rail__layers li')).toHaveLength(5);
  });

  it('persiste a preferência de recolhimento e restaura no próximo load', async () => {
    const first = await renderRail();

    await act(async () => {
      first.container.querySelector<HTMLButtonElement>('.map-rail__collapse')!.click();
    });
    expect(window.localStorage.getItem(MAP_LAYERS_PANEL_COLLAPSED_KEY)).toBe('1');

    // Novo "load" (nova raiz) sem limpar o storage: continua recolhido.
    const second = await renderRail();
    expect(second.container.querySelector('.map-rail--collapsed')).not.toBeNull();
    expect(second.container.querySelector('.map-rail__scroll')).toBeNull();

    // Expandir também persiste: o próximo load começa aberto.
    await act(async () => {
      second.container.querySelector<HTMLButtonElement>('.map-rail__restore')!.click();
    });
    expect(window.localStorage.getItem(MAP_LAYERS_PANEL_COLLAPSED_KEY)).toBeNull();

    const third = await renderRail();
    expect(third.container.querySelector('.map-rail--collapsed')).toBeNull();
    expect(third.container.querySelector('.map-rail__header')).not.toBeNull();
  });

  it('não afeta o painel de alarmes', async () => {
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
      layerFilter: 'ALL',
      siteFilter: null,
      deviceTypeFilter: null,
      focusHops: 0,
      selection: null,
      showToast,
    });
    const alarm: Alarm = {
      id: 'alarm-1',
      deviceId: 'device-1',
      deviceName: 'SW-CBF-01',
      interfaceId: 'iface-1',
      interfaceName: '40GE0/0/1',
      interfaceLabel: 'SW-SPA-SJO-5732-MPLS-01',
      ifIndex: 118,
      linkId: 'link-1',
      linkLabel: 'Backbone',
      type: 'INTERFACE_DOWN',
      severity: 'CRITICAL',
      startedAt: new Date(2026, 8, 16, 21, 17, 32).toISOString(),
      endedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      message: 'SW-CBF-01: SW-SPA-SJO-5732-MPLS-01 (40GE0/0/1) DOWN',
    };
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MapRail />
          <AlarmPanel alarms={[alarm]} onFocus={() => undefined} />
        </QueryClientProvider>,
      );
    });

    const alarmPanel = container.querySelector('.alarm-panel');
    expect(alarmPanel).not.toBeNull();
    expect(alarmPanel!.textContent).toContain('Alarmes');
    expect(alarmPanel!.textContent).toContain('SW-CBF-01');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.map-rail__collapse')!.click();
    });

    // A rail recolheu e o painel de alarmes continua no lugar, com o conteúdo.
    expect(container.querySelector('.map-rail--collapsed')).not.toBeNull();
    const alarmPanelAfter = container.querySelector('.alarm-panel');
    expect(alarmPanelAfter).not.toBeNull();
    expect(alarmPanelAfter!.textContent).toContain('Alarmes');
    expect(alarmPanelAfter!.textContent).toContain('SW-CBF-01');
  });
});
