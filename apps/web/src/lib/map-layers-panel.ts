/**
 * Preferência global de layout do mapa: a coluna **Camadas do mapa** pode ser
 * recolhida para devolver largura ao canvas.
 *
 * É uma preferência de leitura do operador (não é dado do mapa), então vive em
 * `localStorage` no mesmo padrão das preferências do painel de alarmes: um
 * módulo pequeno com `get`/`set`/`subscribe` consumido por
 * `useSyncExternalStore`.
 */
export const MAP_LAYERS_PANEL_COLLAPSED_KEY = 'netvision.mapLayersPanelCollapsed';

const MAP_LAYERS_PANEL_CHANGE_EVENT = 'netvision:map-layers-panel-change';

/** Largura da rail discreta que resta quando a coluna está recolhida (px). */
export const MAP_LAYERS_RAIL_WIDTH = 30;

export function getMapLayersPanelCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MAP_LAYERS_PANEL_COLLAPSED_KEY) === '1';
  } catch {
    // Storage pode estar indisponível em contexto restrito: segue aberto.
    return false;
  }
}

export function setMapLayersPanelCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (collapsed) {
      window.localStorage.setItem(MAP_LAYERS_PANEL_COLLAPSED_KEY, '1');
    } else {
      window.localStorage.removeItem(MAP_LAYERS_PANEL_COLLAPSED_KEY);
    }
  } catch {
    // Storage indisponível: a preferência vale só para esta sessão.
  }
  window.dispatchEvent(new CustomEvent(MAP_LAYERS_PANEL_CHANGE_EVENT));
}

export function subscribeMapLayersPanelCollapsed(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onStorage = (event: StorageEvent) => {
    if (event.key === MAP_LAYERS_PANEL_COLLAPSED_KEY) onStoreChange();
  };

  window.addEventListener(MAP_LAYERS_PANEL_CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(MAP_LAYERS_PANEL_CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStorage);
  };
}
