// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { cloneDemoMaps } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';
import { updateNetworkMap } from '@/lib/api';
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

/**
 * Os controles visuais deixaram de ser um painel permanente sobre o canvas e
 * passaram a viver na rail lateral (`MapVisualControls`). O `MapControls`
 * flutuante agora é só zoom/enquadrar/tela cheia.
 */
describe('MapVisualControls (rail)', () => {
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
          <MapVisualControls />
        </ReactFlowProvider>,
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
    useMapStore.setState({ map: null });
  });

  it('oferece equipamentos, enlaces, métrica, tráfego e escalas', async () => {
    const { container } = await renderControls();

    expect(container.textContent).toContain('Equipamentos');
    expect(container.textContent).toContain('Enlaces');
    expect(container.textContent).toContain('Métrica');
    expect(container.textContent).toContain('Exibição de tráfego');
    expect(container.textContent).toContain('Escala');
    expect(container.textContent).toContain('Legibilidade');
  });

  it('persiste o modo de exibição dos equipamentos', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButton(container, 'Cards').click();
    });

    expect(useMapStore.getState().map?.settings.nodeDisplayMode).toBe('CARD');
    expect(updateNetworkMap).toHaveBeenCalledWith(map.id, {
      settings: { nodeDisplayMode: 'CARD' },
    });
  });

  it('oferece Cards, Na linha e Ocultar e persiste o modo INLINE', async () => {
    const { container } = await renderControls();

    expect(container.textContent).toContain('Cards');
    expect(container.textContent).toContain('Na linha');
    expect(container.textContent).toContain('Ocultar');

    await act(async () => {
      findButton(container, 'Na linha').click();
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
    expect(labels).toEqual(['Diminuir zoom', 'Aumentar zoom', 'Enquadrar mapa', 'Tela cheia']);
    // O painel permanente antigo não existe mais dentro do canvas.
    expect(container.querySelector('.visual-controls')).toBeNull();
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
