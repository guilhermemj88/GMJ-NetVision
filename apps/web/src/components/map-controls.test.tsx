// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { cloneDemoMaps } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';
import { updateNetworkMap } from '@/lib/api';
import { MapControls } from './map-controls';

vi.mock('@/lib/api', () => ({
  updateNetworkMap: vi.fn().mockResolvedValue(undefined),
}));

const COLLAPSED_KEY = 'netvision.mapVisualPanelCollapsed';

type MediaListener = (event: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<MediaListener>();
  let matches = initialMatches;
  const media = {
    get matches() {
      return matches;
    },
    media: '(max-width: 720px)',
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
    dispatch: (value: boolean) => {
      matches = value;
      for (const listener of listeners) listener({ matches: value });
    },
  };
  vi.stubGlobal('matchMedia', () => media);
  return media;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    (item.getAttribute('aria-label') ?? item.textContent ?? '').includes(label),
  );
  if (!button) throw new Error(`Button ${label} not found`);
  return button;
}

describe('MapControls visual panel', () => {
  const map = cloneDemoMaps()[0]!;
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  async function renderControls(mobile = false) {
    installMatchMedia(mobile);
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
    window.localStorage.clear();
    installMatchMedia(false);
  });

  afterEach(async () => {
    for (const { root, container } of roots.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.localStorage.clear();
    useMapStore.setState({ map: null });
  });

  it('renders the visual panel expanded on desktop by default', async () => {
    const { container } = await renderControls();

    expect(container.querySelector('.visual-controls')).not.toBeNull();
    expect(container.querySelector('.visual-controls-rail')).toBeNull();
    expect(container.textContent).toContain('Visual do mapa');
    expect(container.textContent).toContain('Equipamentos');
    expect(container.textContent).toContain('Enlaces');
  });

  it('collapses into a compact rail and persists the preference locally', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButton(container, 'Recolher Visual do mapa').click();
    });

    expect(container.querySelector('.visual-controls')).toBeNull();
    expect(container.querySelector('.visual-controls-rail')).not.toBeNull();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('1');
  });

  it('reopens the panel from the collapsed rail', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButton(container, 'Recolher Visual do mapa').click();
    });
    expect(container.querySelector('.visual-controls-rail')).not.toBeNull();

    await act(async () => {
      findButton(container, 'Expandir Visual do mapa').click();
    });

    expect(container.querySelector('.visual-controls')).not.toBeNull();
    expect(container.querySelector('.visual-controls-rail')).toBeNull();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe('0');
  });

  it('restores a previously collapsed preference after mount', async () => {
    window.localStorage.setItem(COLLAPSED_KEY, '1');
    const { container } = await renderControls();

    expect(container.querySelector('.visual-controls-rail')).not.toBeNull();
    expect(container.querySelector('.visual-controls')).toBeNull();
  });

  it('shows a floating button instead of the inline panel on mobile', async () => {
    const { container } = await renderControls(true);

    expect(container.querySelector('.visual-sheet-fab')).not.toBeNull();
    expect(container.querySelector('.visual-controls')).toBeNull();
    expect(container.querySelector('.visual-controls-rail')).toBeNull();
  });

  it('opens and closes the visual panel bottom sheet on mobile', async () => {
    const { container } = await renderControls(true);

    await act(async () => {
      findButton(container, 'Abrir Visual do mapa').click();
    });

    expect(container.querySelector('.visual-sheet')).not.toBeNull();
    expect(container.textContent).toContain('Visual do mapa');
    expect(container.textContent).toContain('Equipamentos');
    expect(container.textContent).toContain('Escala');

    await act(async () => {
      findButton(container, 'Fechar Visual do mapa').click();
    });

    expect(container.querySelector('.visual-sheet')).toBeNull();
    expect(container.querySelector('.visual-sheet-fab')).not.toBeNull();
  });

  it('keeps the desktop zoom and toggle controls regardless of state', async () => {
    const { container } = await renderControls();

    expect(container.querySelector('.map-controls')).not.toBeNull();
    expect(container.textContent).toContain('Tráfego');
  });
});

describe('MapControls traffic label mode', () => {
  const map = cloneDemoMaps()[0]!;
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  async function renderControls() {
    installMatchMedia(false);
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
    window.localStorage.clear();
    installMatchMedia(false);
  });

  afterEach(async () => {
    for (const { root, container } of roots.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.localStorage.clear();
    useMapStore.setState({ map: null });
  });

  it('offers Cards, Na linha and Ocultar options', async () => {
    const { container } = await renderControls();

    expect(container.textContent).toContain('Exibição de tráfego');
    expect(container.textContent).toContain('Cards');
    expect(container.textContent).toContain('Na linha');
    expect(container.textContent).toContain('Ocultar');
  });

  it('persists the INLINE mode into the map settings', async () => {
    const { container } = await renderControls();

    await act(async () => {
      findButton(container, 'Na linha').click();
    });

    expect(useMapStore.getState().map?.settings.trafficLabelMode).toBe('INLINE');
    expect(updateNetworkMap).toHaveBeenCalledWith(map.id, {
      settings: { trafficLabelMode: 'INLINE' },
    });
  });
});
