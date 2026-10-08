// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';

vi.mock('./top-bar', () => ({ TopBar: () => createElement('header', { className: 'topbar' }) }));
vi.mock('./map-rail', () => ({ MapRail: () => null }));
vi.mock('./network-canvas', () => ({ NetworkCanvas: () => createElement('div', { id: 'canvas' }) }));
vi.mock('./context-drawer', () => ({ ContextDrawer: () => null }));
vi.mock('./action-panels', () => ({ ActionPanels: () => null }));
vi.mock('./noc-controls', () => ({ NocControls: () => null }));
vi.mock('./hosts-workspace', () => ({ HostsWorkspace: () => createElement('div', { id: 'hosts' }) }));
vi.mock('./physical/physical-workspace', () => ({
  PhysicalWorkspace: () => createElement('div', { id: 'physical' }),
}));
vi.mock('./bgp/bgp-workspace', () => ({ BgpWorkspace: () => createElement('div', { id: 'bgp' }) }));
vi.mock('./alerts/alert-center-workspace', () => ({
  AlertCenterWorkspace: () => createElement('div', { id: 'alerts' }),
}));

import { NetworkWorkspace } from './network-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe('NetworkWorkspace — rota de view por query param', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useMapStore.setState({ view: 'MAP', map: null, maps: [], activeMapId: null, panel: null });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
  });

  it('abre a Central de Alertas direto por ?view=alerts', async () => {
    window.history.replaceState(null, '', '/?view=alerts');
    await act(async () => {
      root.render(createElement(NetworkWorkspace));
    });
    await settle();
    expect(useMapStore.getState().view).toBe('ALERTS');
    expect(container.querySelector('#alerts')).not.toBeNull();
    expect(container.querySelector('#canvas')).toBeNull();
  });

  it('aceita o alias em portugues ?view=alertas', async () => {
    window.history.replaceState(null, '', '/?view=alertas');
    await act(async () => {
      root.render(createElement(NetworkWorkspace));
    });
    await settle();
    expect(useMapStore.getState().view).toBe('ALERTS');
  });

  it('preserva as views existentes (hosts, fisico, bgp)', async () => {
    for (const [requested, expected, selector] of [
      ['hosts', 'HOSTS', '#hosts'],
      ['fisico', 'PHYSICAL', '#physical'],
      ['bgp', 'BGP', '#bgp'],
    ] as const) {
      // Cada caso remonta a workspace (o efeito le a URL na montagem).
      await act(async () => root.unmount());
      useMapStore.setState({ view: 'MAP', map: null, panel: null });
      window.history.replaceState(null, '', `/?view=${requested}`);
      root = createRoot(container);
      await act(async () => {
        root.render(createElement(NetworkWorkspace));
      });
      await settle();
      expect(useMapStore.getState().view).toBe(expected);
      expect(container.querySelector(selector)).not.toBeNull();
    }
  });

  it('sem query param continua abrindo o mapa', async () => {
    window.history.replaceState(null, '', '/');
    await act(async () => {
      root.render(createElement(NetworkWorkspace));
    });
    await settle();
    expect(useMapStore.getState().view).toBe('MAP');
    expect(container.querySelector('#canvas')).not.toBeNull();
  });
});
