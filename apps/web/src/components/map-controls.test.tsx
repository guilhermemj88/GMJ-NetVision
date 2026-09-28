// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { cloneDemoMaps } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';
import { updateNetworkMap } from '@/lib/api';
import {
  countTrafficLabelOffsets,
  getTrafficLabelOffsets,
  setTrafficLabelOffset,
} from '@/lib/traffic-label-offsets';
import { MapControls, MapVisualControls } from './map-controls';

vi.mock('@/lib/api', () => ({
  updateNetworkMap: vi.fn().mockResolvedValue(undefined),
}));

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    (item.getAttribute('aria-label') ?? item.textContent ?? '').includes(label),
  );
  if (!button) throw new Error(`Button ${label} not found`);
  return button;
}

function findButtonOptional(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      (item.getAttribute('aria-label') ?? item.textContent ?? '').includes(label),
    ) ?? null
  );
}

/**
 * Botões repetidos entre grupos ("Cards" existe em Tráfego e em Equipamentos):
 * busca sempre dentro do grupo pelo título.
 */
function findButtonInGroup(container: HTMLElement, groupTitle: string, label: string): HTMLButtonElement {
  const group = [...container.querySelectorAll<HTMLElement>('.map-visual__group')].find((item) =>
    item.querySelector('.map-visual__group-title')?.textContent?.includes(groupTitle),
  );
  if (!group) throw new Error(`Grupo ${groupTitle} não encontrado`);
  return findButton(group, label);
}

/**
 * Os controles visuais deixaram de ser um painel permanente sobre o canvas e
 * passaram a viver na rail lateral (`MapVisualControls`). O `MapControls`
 * flutuante agora é só zoom/enquadrar/tela cheia.
 */
describe('MapVisualControls (rail)', () => {
  const map = cloneDemoMaps()[0]!;
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];
  let client: QueryClient;

  async function renderControls() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    useMapStore.setState({ map, activeMapId: map.id, readOnly: false });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ReactFlowProvider>
            <MapVisualControls />
          </ReactFlowProvider>
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
    vi.clearAllMocks();
    window.localStorage.clear();
    client?.clear();
    useMapStore.setState({ map: null });
  });

  it('oferece equipamentos, enlaces, métrica, tráfego e escalas', async () => {
    const { container } = await renderControls();

    expect(container.textContent).toContain('Equipamentos');
    expect(container.textContent).toContain('Enlaces');
    expect(container.textContent).toContain('Métrica');
    expect(container.textContent).toContain('Modo de tráfego');
    expect(container.textContent).toContain('ESCALA');
    expect(container.textContent).toContain('Legibilidade');
    expect(container.textContent).toContain('GEOMETRIA DO ENLACE');
  });

  it('persiste o modo de exibição dos equipamentos', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButtonInGroup(container, 'EQUIPAMENTOS', 'Cards').click();
    });

    expect(useMapStore.getState().map?.settings.nodeDisplayMode).toBe('CARD');
    expect(updateNetworkMap).toHaveBeenCalledWith(map.id, {
      settings: { nodeDisplayMode: 'CARD' },
    });
  });

  it('oferece Cards, Inline e Oculto e persiste o modo INLINE', async () => {
    const { container } = await renderControls();

    expect(container.textContent).toContain('Cards');
    expect(container.textContent).toContain('Inline');
    expect(container.textContent).toContain('Oculto');

    await act(async () => {
      findButtonInGroup(container, 'TRÁFEGO', 'Inline').click();
    });

    expect(useMapStore.getState().map?.settings.trafficLabelMode).toBe('INLINE');
    expect(updateNetworkMap).toHaveBeenCalledWith(map.id, {
      settings: { trafficLabelMode: 'INLINE' },
    });
  });

  it('aplica o preset de Legibilidade às labels e ao painel de alarmes', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButton(container, 'Extra').click();
    });

    expect(useMapStore.getState().map?.settings.labelScale).toBe(150);
    expect(window.localStorage.getItem('gmj:alarms:panel-scale')).toBe('150');
  });

  it('aplica o preset de escala WeatherMap e persiste as tres escalas', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButton(container, 'WeatherMap').click();
    });

    expect(useMapStore.getState().map?.settings).toMatchObject({
      nodeScale: 75,
      linkScale: 140,
      labelScale: 85,
    });
    expect(updateNetworkMap).toHaveBeenCalledWith(map.id, {
      settings: { nodeScale: 75, linkScale: 140, labelScale: 85 },
    });
  });

  it('avisa quando a escala foi ajustada a mao e oferece voltar ao preset', async () => {
    const { container } = await renderControls();

    await act(async () => {
      useMapStore.getState().setMapScales({ nodeScale: 120 });
    });
    expect(container.textContent).toContain('Escala ajustada');

    await act(async () => {
      findButton(container, 'Aplicar escala do preset').click();
    });
    expect(useMapStore.getState().map?.settings.nodeScale).toBe(100);
  });
});

describe('MapControls (canvas)', () => {
  const map = cloneDemoMaps()[0]!;
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  async function renderControls() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    useMapStore.setState({ map, activeMapId: map.id, readOnly: false });
    await act(async () => {
      root.render(
        <ReactFlowProvider>
          <MapControls />
        </ReactFlowProvider>,
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
    useMapStore.setState({ map: null });
  });

  it('mantém apenas zoom, enquadrar e tela cheia sobre o canvas', async () => {
    const { container } = await renderControls();

    const labels = [...container.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Ajustar labels de tráfego',
      'Diminuir zoom',
      'Aumentar zoom',
      'Enquadrar mapa',
      'Tela cheia',
    ]);
    // O painel permanente antigo não existe mais dentro do canvas.
    expect(container.querySelector('.visual-controls')).toBeNull();
  });

  it('habilita o ajuste de labels só no modo Inline e desliga ao sair', async () => {
    const { container } = await renderControls();
    const toggle = findButton(container, 'Ajustar labels de tráfego');

    // O mapa demo usa CARD: o arrasto por lane não existe nesse modo.
    expect((toggle as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      useMapStore.setState({
        map: { ...map, settings: { ...map.settings, trafficLabelMode: 'INLINE' } },
      });
    });
    expect(findButton(container, 'Ajustar labels de tráfego').disabled).toBe(false);

    await act(async () => {
      findButton(container, 'Ajustar labels de tráfego').click();
    });
    expect(useMapStore.getState().labelAdjustMode).toBe(true);
    expect(container.querySelector('.map-label-bar .is-active')).not.toBeNull();

    await act(async () => {
      findButton(container, 'Ajustar labels de tráfego').click();
    });
    expect(useMapStore.getState().labelAdjustMode).toBe(false);
  });

  it('oferece reset global quando existem labels deslocadas', async () => {
    const { container } = await renderControls();
    await act(async () => {
      useMapStore.setState({
        map: { ...map, settings: { ...map.settings, trafficLabelMode: 'INLINE' } },
      });
      useMapStore.getState().setLabelAdjustMode(true);
    });
    expect(container.querySelector('.map-label-bar')).not.toBeNull();
    expect(findButtonOptional(container, 'Resetar labels de tráfego')).toBeNull();

    await act(async () => {
      setTrafficLabelOffset(map.id, 'link-1', 'a', { dx: 12, dy: -6 });
    });
    const reset = findButton(container, 'Resetar labels de tráfego');
    expect(reset.textContent).toContain('1');

    await act(async () => {
      reset.click();
    });
    expect(countTrafficLabelOffsets(getTrafficLabelOffsets(map.id))).toBe(0);
  });

  it('não quebra ao acionar os controles', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButton(container, 'Enquadrar mapa').click();
      findButton(container, 'Aumentar zoom').click();
      findButton(container, 'Diminuir zoom').click();
    });

    expect(container.querySelector('.map-zoombar')).not.toBeNull();
  });
});
