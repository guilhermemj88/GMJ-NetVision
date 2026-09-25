'use client';

import {
  aggregateLinkMetrics,
  createLocalId,
  type AddDeviceResult,
  type CreateLinkInput,
  type HostRecord,
  type InterfaceSearchResult,
  type LinkDisplayStyle,
  type LinkMetricDisplay,
  type MapNode,
  type MapPreferences,
  type MapSettings,
  type MapSummary,
  type MapWidget,
  type NetworkLink,
  type NetworkMap,
  type NodeDisplayMode,
  type Position,
  type TrafficLabelMode,
  type UpdateMapNodePppInput,
} from '@gmj/shared';
import { create } from 'zustand';
import type { LinkGeometry } from '@/lib/link-curvature';
import type { FocusHops, MapLayerFilter, VisualPreset } from '@/lib/map-focus';

export type Selection =
  | { kind: 'device'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'link'; id: string }
  | { kind: 'interface'; id: string; deviceId: string }
  | null;
export type OpenPanel =
  | 'add-device'
  | 'add-generic-node'
  | 'create-link'
  | 'discovery'
  | 'settings'
  | 'maps'
  | 'rotation'
  | 'public-links'
  | 'users'
  | null;
export type WorkspaceView = 'MAP' | 'HOSTS' | 'PHYSICAL' | 'BGP';

export interface PresetApplication {
  nodeDisplayMode: NodeDisplayMode;
  linkDisplayStyle: LinkDisplayStyle;
  linkMetricDisplay: LinkMetricDisplay;
  trafficLabelMode: TrafficLabelMode;
  preferences: MapPreferences;
  layer: MapLayerFilter;
  /**
   * Escala sugerida do preset. So e aplicada quando a escala atual ainda e a
   * do preset em uso (ou seja, o operador nao ajustou nada a mao).
   */
  scales: MapScalePreset;
}

/** Escala persistida por mapa (`MapSettings`) que um preset sugere. */
export interface MapScalePreset {
  nodeScale: number;
  linkScale: number;
  labelScale: number;
}

/**
 * Os três presets VISUAIS do mapa. Eles não criam mapas, não mudam topologia
 * nem métricas: apenas agrupam escolhas que já existem em `MapSettings` e
 * `MapPreferences`, mais a camada sugerida de foco.
 */
export const VISUAL_PRESETS: Record<VisualPreset, PresetApplication> = {
  OPERACIONAL: {
    nodeDisplayMode: 'ICON_2D',
    linkDisplayStyle: 'HYBRID',
    linkMetricDisplay: 'UTILIZATION',
    trafficLabelMode: 'CARD',
    scales: { nodeScale: 100, linkScale: 100, labelScale: 100 },
    preferences: {
      showTraffic: true,
      showUtilization: true,
      showLabels: false,
      showOffline: true,
      showInterfaces: false,
      showTrafficAnimation: true,
    },
    layer: 'PROBLEM',
  },
  TOPOLOGIA: {
    nodeDisplayMode: 'ICON_2D',
    linkDisplayStyle: 'MINIMAL',
    linkMetricDisplay: 'NONE',
    trafficLabelMode: 'HIDDEN',
    scales: { nodeScale: 100, linkScale: 100, labelScale: 100 },
    preferences: {
      showTraffic: false,
      showUtilization: false,
      showLabels: true,
      showOffline: true,
      showInterfaces: false,
      showTrafficAnimation: false,
    },
    layer: 'ALL',
  },
  ENGENHARIA: {
    nodeDisplayMode: 'CARD',
    linkDisplayStyle: 'HYBRID',
    linkMetricDisplay: 'BOTH',
    trafficLabelMode: 'INLINE',
    scales: { nodeScale: 100, linkScale: 100, labelScale: 100 },
    preferences: {
      showTraffic: true,
      showUtilization: true,
      showLabels: true,
      showOffline: true,
      showInterfaces: true,
      showTrafficAnimation: true,
    },
    layer: 'ALL',
  },
  /**
   * WeatherMap: mesmo grafo, leitura de backbone/NOC.
   *
   * Os enlaces passam a ser os protagonistas (mais grossos, estilo WEATHERMAP,
   * com os dois sentidos) e os equipamentos ficam menores e sem ruido textual.
   * A contagem de portas so aparece no preset ENGENHARIA, em CARD.
   */
  WEATHERMAP: {
    nodeDisplayMode: 'ICON_2D',
    linkDisplayStyle: 'WEATHERMAP',
    linkMetricDisplay: 'BOTH',
    trafficLabelMode: 'CARD',
    scales: { nodeScale: 75, linkScale: 140, labelScale: 85 },
    preferences: {
      showTraffic: true,
      showUtilization: true,
      showLabels: false,
      showOffline: true,
      showInterfaces: false,
      showTrafficAnimation: true,
    },
    layer: 'ALL',
  },
};

/**
 * A escala atual ainda e a sugerida pelo preset informado?
 *
 * Serve para nao sobrescrever um ajuste manual sem confirmacao: se o operador
 * mexeu nos sliders, trocar de preset mantem os valores dele.
 */
export function scalesMatchPreset(
  settings: Pick<MapSettings, 'nodeScale' | 'linkScale' | 'labelScale'> | null | undefined,
  preset: VisualPreset,
): boolean {
  if (!settings) return true;
  const suggested = VISUAL_PRESETS[preset].scales;
  return (
    settings.nodeScale === suggested.nodeScale &&
    settings.linkScale === suggested.linkScale &&
    settings.labelScale === suggested.labelScale
  );
}

/**
 * Escala a aplicar ao trocar de preset: as do novo preset quando o operador
 * nunca ajustou nada a mao, ou vazio quando a escala atual e dele.
 */
export function presetScalePatch(
  settings: Pick<MapSettings, 'nodeScale' | 'linkScale' | 'labelScale'> | null | undefined,
  currentPreset: VisualPreset,
  nextPreset: VisualPreset,
): Partial<MapScalePreset> {
  return scalesMatchPreset(settings, currentPreset) ? VISUAL_PRESETS[nextPreset].scales : {};
}

/**
 * Descobre qual preset corresponde ao que esta persistido no mapa.
 *
 * Usado ao abrir/reabrir um mapa para a rail nao mentir sobre o preset ativo
 * depois de um reload (as configuracoes persistem, o estado da UI nao).
 */
export function inferVisualPreset(
  settings: Pick<
    MapSettings,
    'nodeDisplayMode' | 'linkDisplayStyle' | 'linkMetricDisplay' | 'trafficLabelMode'
  >,
): VisualPreset {
  const order: VisualPreset[] = ['WEATHERMAP', 'ENGENHARIA', 'TOPOLOGIA', 'OPERACIONAL'];
  return (
    order.find((preset) => {
      const application = VISUAL_PRESETS[preset];
      return (
        application.nodeDisplayMode === settings.nodeDisplayMode &&
        application.linkDisplayStyle === settings.linkDisplayStyle &&
        application.linkMetricDisplay === settings.linkMetricDisplay &&
        application.trafficLabelMode === settings.trafficLabelMode
      );
    }) ?? 'OPERACIONAL'
  );
}

export interface MapFocusRequest {
  deviceId: string;
  requestId: number;
}

export interface NocRotationState {
  active: boolean;
  mapIds: string[];
  currentIndex: number;
  intervalSeconds: number;
  paused: boolean;
  nextSwitchAt: number;
  hideTopBar: boolean;
  hideControls: boolean;
  pauseOnInteraction: boolean;
}

interface MapState {
  linkGeometryDrafts: Record<string, LinkGeometry>;
  setLinkGeometryDraft: (linkId: string, geometry: LinkGeometry | null) => void;
  maps: MapSummary[];
  activeMapId: string | null;
  map: NetworkMap | null;
  readOnly: boolean;
  publicMaps: NetworkMap[];
  view: WorkspaceView;
  editMode: boolean;
  selection: Selection;
  panel: OpenPanel;
  pendingLink: { sourceId?: string; targetId?: string } | null;
  preferences: MapPreferences;
  rotation: NocRotationState;
  dirty: boolean;
  toast: string | null;
  focusRequest: MapFocusRequest | null;
  pendingInterfaceNavigation: { mapId: string; deviceId: string; interfaceId: string } | null;
  pendingDeviceNavigation: { mapId: string; deviceId: string } | null;
  hostDetailRequest: string | null;
  focusSequence: number;
  /** Host para o qual a visão BGP deve abrir filtrada. */
  bgpDeviceFilter: string | null;
  setBgpDeviceFilter: (deviceId: string | null) => void;
  openBgpForDevice: (deviceId: string) => void;
  /** Pedido de foco no módulo Físico (site/rack/porta exatos). */
  physicalFocusRequest: { siteId: string; rackId: string; portId: string; requestId: number } | null;
  openPhysicalPort: (siteId: string, rackId: string, portId: string) => void;
  clearPhysicalFocusRequest: (requestId: number) => void;
  visualPreset: VisualPreset;
  layerFilter: MapLayerFilter;
  siteFilter: string | null;
  deviceTypeFilter: string | null;
  focusHops: FocusHops;
  setVisualPreset: (preset: VisualPreset) => void;
  setLayerFilter: (layer: MapLayerFilter) => void;
  setSiteFilter: (site: string | null) => void;
  setDeviceTypeFilter: (deviceType: string | null) => void;
  setFocusHops: (hops: FocusHops) => void;
  setCatalog: (maps: MapSummary[]) => void;
  upsertMapSummary: (map: NetworkMap) => void;
  removeMapSummary: (mapId: string) => void;
  setActiveMap: (mapId: string) => void;
  setMap: (map: NetworkMap) => void;
  /**
   * Hidrata o mapa a partir do refresh automático (polling), em vez de uma
   * troca de mapa de verdade.
   *
   * Com edição pendente (`editMode && dirty`) a estrutura local manda: nós,
   * links (geometria, pontas, cores, estilo, label, agregação), settings,
   * widgets e drafts ficam como estão, e só a telemetria é mesclada — os
   * `devices` (status, interfaces, tráfego, alarmes) e as métricas dos enlaces.
   * Em qualquer outro caso equivale ao `setMap`.
   */
  applyMapRefresh: (map: NetworkMap) => void;
  setPublicMap: (map: NetworkMap) => void;
  setReadOnly: (value: boolean) => void;
  loadPublicMaps: (maps: NetworkMap[]) => void;
  setView: (view: WorkspaceView) => void;
  setEditMode: (enabled: boolean) => void;
  setSelection: (selection: Selection) => void;
  openInterfaceOnMap: (result: InterfaceSearchResult, mapId: string) => void;
  clearFocusRequest: (requestId: number) => void;
  openHostDetails: (hostId: string) => void;
  clearHostDetailRequest: () => void;
  openHostOnMap: (deviceId: string, mapId: string) => void;
  /**
   * Abre a interface no mapa que já está ativo, quando o equipamento faz parte
   * dele. Devolve `false` sem mudar nada quando o equipamento não está no mapa
   * — nunca inferimos um mapa para "abrir em algum lugar".
   */
  openInterfaceInActiveMap: (deviceId: string, interfaceId: string) => boolean;
  setPanel: (panel: OpenPanel) => void;
  setPendingLink: (value: MapState['pendingLink']) => void;
  setPreference: (key: keyof MapPreferences) => void;
  setNodeDisplayMode: (mode: NodeDisplayMode) => void;
  setLinkDisplayStyle: (style: LinkDisplayStyle) => void;
  setLinkMetricDisplay: (display: LinkMetricDisplay) => void;
  setTrafficLabelMode: (mode: TrafficLabelMode) => void;
  setViewport: (viewport: MapSettings['viewport']) => void;
  setMapScales: (
    scales: Partial<Pick<MapSettings, 'nodeScale' | 'linkScale' | 'labelScale'>>,
  ) => void;
  moveNode: (nodeId: string, position: Position) => void;
  setNodeLocked: (nodeId: string, locked: boolean) => void;
  updateNodePpp: (nodeId: string, input: UpdateMapNodePppInput) => void;
  replaceNode: (node: MapNode) => void;
  setWidget: (widget: MapWidget) => void;
  removeWidget: (widgetId: string) => void;
  applyLayout: (positions: Map<string, Position>) => void;
  addLink: (input: CreateLinkInput, serverLink?: NetworkLink) => void;
  replaceLink: (link: NetworkLink) => void;
  removeLink: (linkId: string) => void;
  addDevice: (device: HostRecord, position: Position, node?: AddDeviceResult['node']) => void;
  addGenericNode: (node: MapNode) => void;
  removeNode: (nodeId: string) => void;
  removeDevice: (deviceId: string) => void;
  startRotation: (
    options: Omit<NocRotationState, 'active' | 'currentIndex' | 'paused' | 'nextSwitchAt'>,
  ) => void;
  stopRotation: () => void;
  setRotationPaused: (paused: boolean) => void;
  rotateBy: (offset: number) => void;
  markSaved: () => void;
  showToast: (message: string) => void;
}

const preferenceDefaults: MapPreferences = {
  showTraffic: true,
  showUtilization: true,
  showLabels: true,
  showOffline: true,
  showInterfaces: false,
  showTrafficAnimation: true,
};

const rotationDefaults: NocRotationState = {
  active: false,
  mapIds: [],
  currentIndex: 0,
  intervalSeconds: 60,
  paused: false,
  nextSwitchAt: 0,
  hideTopBar: false,
  hideControls: false,
  pauseOnInteraction: true,
};

function clearLegacyLocalState(mapId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(`gmj:positions:${mapId}`);
    window.localStorage.removeItem(`gmj:settings:${mapId}`);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function summaryFromMap(map: NetworkMap): MapSummary {
  return {
    id: map.id,
    name: map.name,
    description: map.description,
    mode: map.mode,
    isDefault: map.isDefault,
    nodeCount: map.nodes.length,
    linkCount: map.links.length,
    createdAt: map.createdAt,
    updatedAt: map.updatedAt,
  };
}

/**
 * A geometry draft only ever carries `visualPaths`/`linkLayoutMode`. Merging it
 * with an explicit `undefined` (for example from a partial PATCH response) would
 * silently erase those link fields, so undefined values are ignored here.
 */
export function applyLinkGeometry(link: NetworkLink, geometry: LinkGeometry): NetworkLink {
  return {
    ...link,
    ...(geometry.visualPaths === undefined ? {} : { visualPaths: geometry.visualPaths }),
    ...(geometry.linkLayoutMode === undefined ? {} : { linkLayoutMode: geometry.linkLayoutMode }),
  };
}

/**
 * Telemetria de um enlace: tudo que o backend recalcula a cada coleta.
 *
 * O restante do `NetworkLink` (geometria, pontas, cores, estilo, label,
 * agregação, capacidade manual) é autoridade do operador enquanto houver
 * edição pendente. A capacidade acompanha o servidor apenas quando é AUTO —
 * capacidade MANUAL foi escolhida à mão e não pode ser sobrescrita.
 */
export function mergeLinkTelemetry(local: NetworkLink, server: NetworkLink): NetworkLink {
  return {
    ...local,
    status: server.status,
    directions: server.directions,
    rxBps: server.rxBps,
    txBps: server.txBps,
    rxUtilization: server.rxUtilization,
    txUtilization: server.txUtilization,
    rxErrors: server.rxErrors,
    txErrors: server.txErrors,
    rxDiscards: server.rxDiscards,
    txDiscards: server.txDiscards,
    updatedAt: server.updatedAt,
    ...(local.capacitySource === 'MANUAL'
      ? {}
      : {
          capacityBps: server.capacityBps,
          autoCapacityBps: server.autoCapacityBps,
          capacitySource: server.capacitySource,
        }),
  };
}

export const useMapStore = create<MapState>((set, get) => ({
  linkGeometryDrafts: {},
  setLinkGeometryDraft: (linkId, geometry) => set((state) => {
    const linkGeometryDrafts = { ...state.linkGeometryDrafts };
    if (geometry) linkGeometryDrafts[linkId] = geometry;
    else delete linkGeometryDrafts[linkId];
    return {
      linkGeometryDrafts,
      map: state.map && geometry
        ? { ...state.map, links: state.map.links.map((link) => link.id === linkId ? applyLinkGeometry(link, geometry) : link) }
        : state.map,
    };
  }),
  maps: [],
  activeMapId: null,
  map: null,
  readOnly: false,
  publicMaps: [],
  view: 'MAP',
  editMode: false,
  selection: null,
  panel: null,
  pendingLink: null,
  preferences: preferenceDefaults,
  rotation: rotationDefaults,
  dirty: false,
  toast: null,
  focusRequest: null,
  pendingInterfaceNavigation: null,
  pendingDeviceNavigation: null,
  hostDetailRequest: null,
  focusSequence: 0,
  bgpDeviceFilter: null,
  setBgpDeviceFilter: (bgpDeviceFilter) => set({ bgpDeviceFilter }),
  openBgpForDevice: (deviceId) =>
    set({ view: 'BGP', bgpDeviceFilter: deviceId, editMode: false, selection: null, panel: null }),
  physicalFocusRequest: null,
  openPhysicalPort: (siteId, rackId, portId) =>
    set((state) => ({
      view: 'PHYSICAL',
      editMode: false,
      selection: null,
      panel: null,
      physicalFocusRequest: {
        siteId,
        rackId,
        portId,
        requestId: (state.physicalFocusRequest?.requestId ?? 0) + 1,
      },
    })),
  clearPhysicalFocusRequest: (requestId) =>
    set((state) =>
      state.physicalFocusRequest?.requestId === requestId ? { physicalFocusRequest: null } : state,
    ),
  visualPreset: 'OPERACIONAL',
  layerFilter: 'PROBLEM',
  siteFilter: null,
  deviceTypeFilter: null,
  focusHops: 0,
  setVisualPreset: (visualPreset) =>
    set((state) => {
      const application = VISUAL_PRESETS[visualPreset];
      // Escala ajustada à mão nunca é sobrescrita por troca de preset.
      const scalePatch = presetScalePatch(state.map?.settings, state.visualPreset, visualPreset);
      const map = state.map
        ? {
            ...state.map,
            settings: {
              ...state.map.settings,
              ...scalePatch,
              nodeDisplayMode: application.nodeDisplayMode,
              linkDisplayStyle: application.linkDisplayStyle,
              linkMetricDisplay: application.linkMetricDisplay,
              trafficLabelMode: application.trafficLabelMode,
              filters: application.preferences,
            },
          }
        : state.map;
      return {
        visualPreset,
        preferences: application.preferences,
        layerFilter: application.layer,
        map,
        dirty: map ? true : state.dirty,
      };
    }),
  setLayerFilter: (layerFilter) => set({ layerFilter }),
  setSiteFilter: (siteFilter) => set({ siteFilter }),
  setDeviceTypeFilter: (deviceTypeFilter) => set({ deviceTypeFilter }),
  setFocusHops: (focusHops) => set({ focusHops }),
  setCatalog: (maps) =>
    set((state) => ({
      maps,
      activeMapId:
        state.activeMapId && maps.some((map) => map.id === state.activeMapId)
          ? state.activeMapId
          : (maps.find((map) => map.isDefault)?.id ?? maps[0]?.id ?? null),
    })),
  upsertMapSummary: (map) =>
    set((state) => {
      const summary = summaryFromMap(map);
      return {
        maps: state.maps.some((item) => item.id === map.id)
          ? state.maps.map((item) =>
              item.id === map.id ? summary : map.isDefault ? { ...item, isDefault: false } : item,
            )
          : [...state.maps, summary],
      };
    }),
  removeMapSummary: (mapId) =>
    set((state) => ({
      maps: state.maps.filter((map) => map.id !== mapId),
      activeMapId:
        state.activeMapId === mapId
          ? (state.maps.find((map) => map.id !== mapId)?.id ?? null)
          : state.activeMapId,
      map: state.activeMapId === mapId ? null : state.map,
    })),
  setActiveMap: (activeMapId) =>
    set((state) => ({
      linkGeometryDrafts: {},
      activeMapId,
      map: null,
      selection: null,
      panel: null,
      pendingInterfaceNavigation: null,
      pendingDeviceNavigation: null,
      focusRequest: null,
      // Recortes de foco são específicos do mapa aberto.
      layerFilter: VISUAL_PRESETS[state.visualPreset].layer,
      siteFilter: null,
      deviceTypeFilter: null,
      focusHops: 0,
      dirty: false,
    })),
  setMap: (map) => {
    clearLegacyLocalState(map.id);
    set((state) => {
      const pending =
        state.pendingInterfaceNavigation?.mapId === map.id
          ? state.pendingInterfaceNavigation
          : null;
      const pendingDevice =
        state.pendingDeviceNavigation?.mapId === map.id ? state.pendingDeviceNavigation : null;
      const canFocusDevice = Boolean(
        pendingDevice && map.devices.some((device) => device.id === pendingDevice.deviceId),
      );
      const canOpen = Boolean(
        pending &&
        map.devices.some(
          (device) =>
            device.id === pending.deviceId &&
            device.interfaces.some(
              (networkInterface) => networkInterface.id === pending.interfaceId,
            ),
        ),
      );
      const focusSequence =
        canOpen || canFocusDevice ? state.focusSequence + 1 : state.focusSequence;
      /**
       * Mapa aberto agora e diferente do que estava na tela: a rail volta a
       * refletir o preset que esta de fato persistido, sem mexer no recorte que
       * o operador escolheu durante a sessao.
       */
      const mapChanged = state.map?.id !== map.id;
      const inferredPreset = mapChanged ? inferVisualPreset(map.settings) : state.visualPreset;
      const inferredLayer =
        mapChanged && state.layerFilter === VISUAL_PRESETS[state.visualPreset].layer
          ? VISUAL_PRESETS[inferredPreset].layer
          : state.layerFilter;
      return {
        map: state.map?.id === map.id ? {
          ...map,
          links: map.links.map((link) => {
            const draft = state.linkGeometryDrafts[link.id];
            return draft ? applyLinkGeometry(link, draft) : link;
          }),
        } : map,
        linkGeometryDrafts: state.map?.id === map.id ? state.linkGeometryDrafts : {},
        activeMapId: map.id,
        visualPreset: inferredPreset,
        layerFilter: inferredLayer,
        preferences: map.settings.filters,
        readOnly: false,
        selection:
          canOpen && pending
            ? { kind: 'interface' as const, id: pending.interfaceId, deviceId: pending.deviceId }
            : canFocusDevice && pendingDevice
              ? { kind: 'device' as const, id: pendingDevice.deviceId }
            : state.selection,
        focusRequest:
          canOpen && pending
            ? { deviceId: pending.deviceId, requestId: focusSequence }
            : canFocusDevice && pendingDevice
              ? { deviceId: pendingDevice.deviceId, requestId: focusSequence }
            : state.focusRequest,
        pendingInterfaceNavigation: pending ? null : state.pendingInterfaceNavigation,
        pendingDeviceNavigation: pendingDevice ? null : state.pendingDeviceNavigation,
        focusSequence,
        dirty: false,
      };
    });
  },
  /**
   * Refresh automático do mapa. Não é troca de mapa: com edição pendente ele
   * preserva a estrutura local e mescla apenas telemetria, mantendo `dirty`.
   */
  applyMapRefresh: (serverMap) => {
    const state = get();
    // Primeiro carregamento ou troca real de mapa: hidratação completa.
    if (!state.map || state.map.id !== serverMap.id) {
      state.setMap(serverMap);
      return;
    }
    // Mapa público não hidrata por este caminho (o polling já fica desligado).
    if (state.readOnly) return;
    // Sem edição pendente não há nada a proteger: comportamento atual.
    if (!(state.editMode && state.dirty)) {
      state.setMap(serverMap);
      return;
    }
    set((current) => {
      const localMap = current.map;
      if (!localMap || localMap.id !== serverMap.id) return {};
      const serverLinks = new Map(serverMap.links.map((link) => [link.id, link]));
      return {
        map: {
          ...localMap,
          // Dados vivos continuam vindo do backend.
          devices: serverMap.devices,
          links: localMap.links.map((link) => {
            const draft = current.linkGeometryDrafts[link.id];
            const withDraft = draft ? applyLinkGeometry(link, draft) : link;
            const serverLink = serverLinks.get(link.id);
            return serverLink ? mergeLinkTelemetry(withDraft, serverLink) : withDraft;
          }),
        },
        // `dirty`, seleção, foco, settings, widgets, nós e drafts permanecem.
      };
    });
  },
  setPublicMap: (map) =>
    set({
      linkGeometryDrafts: {},
      map,
      activeMapId: map.id,
      preferences: map.settings.filters,
      readOnly: true,
      view: 'MAP',
      editMode: false,
      selection: null,
      panel: null,
      dirty: false,
    }),
  setReadOnly: (readOnly) => set({ readOnly }),
  loadPublicMaps: (publicMaps) => set({ publicMaps }),
  setView: (view) => set({ view, editMode: false, selection: null, panel: null }),
  setEditMode: (editMode) => set({ editMode, panel: null }),
  setSelection: (selection) => set({ selection }),
  openInterfaceOnMap: (result, mapId) =>
    set((state) => {
      if (state.map?.id === mapId) {
        const focusSequence = state.focusSequence + 1;
        return {
          view: 'MAP' as const,
          selection: {
            kind: 'interface' as const,
            id: result.interfaceId,
            deviceId: result.deviceId,
          },
          focusRequest: { deviceId: result.deviceId, requestId: focusSequence },
          pendingInterfaceNavigation: null,
          focusSequence,
          panel: null,
        };
      }
      return {
        view: 'MAP' as const,
        editMode: false,
        activeMapId: mapId,
        map: null,
        selection: null,
        panel: null,
        focusRequest: null,
        pendingInterfaceNavigation: {
          mapId,
          deviceId: result.deviceId,
          interfaceId: result.interfaceId,
        },
        dirty: false,
      };
    }),
  clearFocusRequest: (requestId) =>
    set((state) => (state.focusRequest?.requestId === requestId ? { focusRequest: null } : state)),
  openHostDetails: (hostDetailRequest) =>
    set({ view: 'HOSTS', editMode: false, selection: null, panel: null, hostDetailRequest }),
  clearHostDetailRequest: () => set({ hostDetailRequest: null }),
  openHostOnMap: (deviceId, mapId) =>
    set((state) => {
      if (state.map?.id === mapId) {
        const focusSequence = state.focusSequence + 1;
        return {
          view: 'MAP' as const,
          selection: { kind: 'device' as const, id: deviceId },
          focusRequest: { deviceId, requestId: focusSequence },
          focusSequence,
          panel: null,
          pendingDeviceNavigation: null,
        };
      }
      return {
        view: 'MAP' as const,
        editMode: false,
        activeMapId: mapId,
        map: null,
        selection: null,
        panel: null,
        focusRequest: null,
        pendingDeviceNavigation: { mapId, deviceId },
        dirty: false,
      };
    }),
  openInterfaceInActiveMap: (deviceId, interfaceId) => {
    const state = useMapStore.getState();
    const device = state.map?.devices.find((item) => item.id === deviceId);
    const networkInterface = device?.interfaces.find((item) => item.id === interfaceId);
    if (!state.map || !device || !networkInterface) return false;
    const focusSequence = state.focusSequence + 1;
    useMapStore.setState({
      view: 'MAP',
      selection: { kind: 'interface', id: interfaceId, deviceId },
      focusRequest: { deviceId, requestId: focusSequence },
      focusSequence,
      panel: null,
    });
    return true;
  },
  setPanel: (panel) => set({ panel }),
  setPendingLink: (pendingLink) => set({ pendingLink }),
  setPreference: (key) =>
    set((state) => {
      if (!state.map) return state;
      const preferences = { ...state.preferences, [key]: !state.preferences[key] };
      const map = {
        ...state.map,
        settings: { ...state.map.settings, filters: preferences },
      };
      return { map, preferences, dirty: true };
    }),
  setNodeDisplayMode: (nodeDisplayMode) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        settings: { ...state.map.settings, nodeDisplayMode },
      };
      return { map, dirty: true };
    }),
  setLinkDisplayStyle: (linkDisplayStyle) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        settings: { ...state.map.settings, linkDisplayStyle },
      };
      return { map, dirty: true };
    }),
  setLinkMetricDisplay: (linkMetricDisplay) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        settings: { ...state.map.settings, linkMetricDisplay },
      };
      return { map, dirty: true };
    }),
  setTrafficLabelMode: (trafficLabelMode) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        settings: { ...state.map.settings, trafficLabelMode },
      };
      return { map, dirty: true };
    }),
  setViewport: (viewport) =>
    set((state) => {
      if (!state.map) return state;
      const map = { ...state.map, settings: { ...state.map.settings, viewport } };
      return { map };
    }),
  setMapScales: (scales) =>
    set((state) => {
      if (!state.map) return state;
      const clamp = (value: number) => Math.min(200, Math.max(50, value));
      const map = {
        ...state.map,
        settings: {
          ...state.map.settings,
          ...(scales.nodeScale === undefined ? {} : { nodeScale: clamp(scales.nodeScale) }),
          ...(scales.linkScale === undefined ? {} : { linkScale: clamp(scales.linkScale) }),
          ...(scales.labelScale === undefined ? {} : { labelScale: clamp(scales.labelScale) }),
        },
      };
      return { map, dirty: true };
    }),
  moveNode: (nodeId, position) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        nodes: state.map.nodes.map((node) =>
          node.id === nodeId ? { ...node, position, positionSource: 'MANUAL' as const } : node,
        ),
      };
      return { map, dirty: true };
    }),
  setNodeLocked: (nodeId, locked) =>
    set((state) => {
      if (!state.map) return state;
      return {
        map: {
          ...state.map,
          nodes: state.map.nodes.map((node) => (node.id === nodeId ? { ...node, locked } : node)),
        },
        dirty: true,
      };
    }),
  updateNodePpp: (nodeId, input) =>
    set((state) => {
      if (!state.map) return state;
      return {
        map: {
          ...state.map,
          nodes: state.map.nodes.map((node) => (node.id === nodeId ? { ...node, ...input } : node)),
        },
        dirty: true,
      };
    }),
  replaceNode: (node) =>
    set((state) =>
      state.map
        ? {
            map: {
              ...state.map,
              nodes: state.map.nodes.map((item) => (item.id === node.id ? node : item)),
            },
          }
        : state,
    ),
  setWidget: (widget) =>
    set((state) => {
      if (!state.map) return state;
      return {
        map: {
          ...state.map,
          widgets: [
            ...state.map.widgets.filter((item) => item.id !== widget.id),
            widget,
          ],
        },
        dirty: true,
      };
    }),
  removeWidget: (widgetId) =>
    set((state) => {
      if (!state.map) return state;
      return {
        map: {
          ...state.map,
          widgets: state.map.widgets.filter((item) => item.id !== widgetId),
        },
        dirty: true,
      };
    }),
  applyLayout: (positions) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        nodes: state.map.nodes.map((node) => {
          const position = positions.get(node.id) ?? node.position;
          const changed = position.x !== node.position.x || position.y !== node.position.y;
          return {
            ...node,
            position,
            positionSource: changed ? ('AUTO' as const) : node.positionSource,
          };
        }),
      };
      return { map, dirty: true };
    }),
  addLink: (input, serverLink) =>
    set((state) => {
      if (!state.map) return state;
      const timestamp = new Date().toISOString();
      const link: NetworkLink = serverLink ?? {
        id: createLocalId('link'),
        mapId: state.map.id,
        sourceDeviceId: input.sourceDeviceId ?? null,
        sourceInterfaceId: input.sourceInterfaceId ?? null,
        targetDeviceId: input.targetDeviceId ?? null,
        targetInterfaceId: input.targetInterfaceId ?? null,
        sourceNodeId: input.sourceNodeId ?? null,
        targetNodeId: input.targetNodeId ?? null,
        capacityBps: input.capacityBps,
        autoCapacityBps: input.autoCapacityBps,
        capacitySource: input.capacitySource,
        trafficMode: input.trafficMode,
        customColor: input.customColor,
        trafficColorAToB: input.trafficColorAToB ?? null,
        trafficColorBToA: input.trafficColorBToA ?? null,
        inlineLabelPositionAToB: input.inlineLabelPositionAToB ?? null,
        inlineLabelPositionBToA: input.inlineLabelPositionBToA ?? null,
        animationEnabled: input.animationEnabled,
        label: input.label,
        metricSource: input.metricSource,
        visualStyle: input.visualStyle,
        metricDisplay: input.metricDisplay,
        aggregationMode: input.aggregationMode ?? 'NONE',
        metricSources: input.metricSources ?? [],
        visualPaths: input.visualPaths ?? [
          { order: 0, label: null, customColor: null, curvature: 0, enabled: true },
        ],
        linkLayoutMode: input.linkLayoutMode ?? 'AUTO',
        sourceHandleSide: input.sourceHandleSide ?? 'AUTO',
        targetHandleSide: input.targetHandleSide ?? 'AUTO',
        status: 'UP',
        discoverySource: 'MANUAL',
        directions: {
          A_TO_B: {
            bps: 0,
            utilization: 0,
            txBps: null,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
          B_TO_A: {
            bps: 0,
            utilization: 0,
            txBps: null,
            observedRxBps: null,
            deltaPercent: null,
            consistency: 'UNKNOWN',
          },
        },
        rxBps: 0,
        txBps: 0,
        rxUtilization: 0,
        txUtilization: 0,
        rxErrors: 0,
        txErrors: 0,
        rxDiscards: 0,
        txDiscards: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!serverLink && link.trafficMode === 'SINGLE_ENDED') {
        Object.assign(link, aggregateLinkMetrics(link, (deviceId, interfaceId) =>
          state.map?.devices.find((device) => device.id === deviceId)?.interfaces.find((item) => item.id === interfaceId),
        ));
      }
      return { map: { ...state.map, links: [...state.map.links, link] }, dirty: true };
    }),
  replaceLink: (link) =>
    set((state) =>
      state.map
        ? {
            map: {
              ...state.map,
              links: state.map.links.map((item) => (item.id === link.id ? link : item)),
            },
          }
        : state,
    ),
  removeLink: (linkId) =>
    set((state) =>
      state.map
        ? {
            map: { ...state.map, links: state.map.links.filter((link) => link.id !== linkId) },
            selection: null,
            dirty: true,
          }
        : state,
    ),
  addDevice: (device, position, serverNode) =>
    set((state) =>
      state.map
        ? {
            map: {
              ...state.map,
              devices: state.map.devices.some((item) => item.id === device.id)
                ? state.map.devices
                : [...state.map.devices, device],
              nodes: [
                ...state.map.nodes,
                serverNode ?? {
                  id: createLocalId('node'),
                  mapId: state.map.id,
                  deviceId: device.id,
                  nodeKind: 'DEVICE',
                  genericType: null,
                  label: null,
                  position,
                  locked: false,
                  positionSource: 'MANUAL',
                  pppDisplayMode: 'AUTO',
                  pppPosition: 'BOTTOM',
                  pppColor: null,
                  pppFontSize: 14,
                },
              ],
            },
            dirty: true,
          }
        : state,
    ),
  addGenericNode: (node) =>
    set((state) =>
      state.map
        ? {
            map: { ...state.map, nodes: [...state.map.nodes, node] },
            dirty: true,
          }
        : state,
    ),
  removeNode: (nodeId) =>
    set((state) =>
      state.map
        ? {
            map: {
              ...state.map,
              nodes: state.map.nodes.filter((node) => node.id !== nodeId),
              links: state.map.links.filter(
                (link) => link.sourceNodeId !== nodeId && link.targetNodeId !== nodeId,
              ),
            },
            selection: null,
            dirty: true,
          }
        : state,
    ),
  removeDevice: (deviceId) =>
    set((state) =>
      state.map
        ? {
            map: {
              ...state.map,
              // Device remains in the global inventory; only its MapNode is removed.
              nodes: state.map.nodes.filter((node) => node.deviceId !== deviceId),
              links: state.map.links.filter(
                (link) => link.sourceDeviceId !== deviceId && link.targetDeviceId !== deviceId,
              ),
            },
            selection: null,
            dirty: true,
          }
        : state,
    ),
  startRotation: (options) =>
    set((state) => ({
      rotation: {
        ...options,
        active: true,
        currentIndex: 0,
        paused: false,
        nextSwitchAt: Date.now() + options.intervalSeconds * 1000,
      },
      activeMapId: options.mapIds[0] ?? null,
      map: state.readOnly
        ? (state.publicMaps.find((item) => item.id === options.mapIds[0]) ?? null)
        : null,
      editMode: false,
      selection: null,
      panel: null,
    })),
  stopRotation: () => set({ rotation: rotationDefaults }),
  setRotationPaused: (paused) =>
    set((state) => ({
      rotation: {
        ...state.rotation,
        paused,
        nextSwitchAt: paused
          ? state.rotation.nextSwitchAt
          : Date.now() + state.rotation.intervalSeconds * 1000,
      },
    })),
  rotateBy: (offset) =>
    set((state) => {
      if (!state.rotation.active || state.rotation.mapIds.length === 0) return state;
      const length = state.rotation.mapIds.length;
      const currentIndex = (state.rotation.currentIndex + offset + length) % length;
      const nextMapId = state.rotation.mapIds[currentIndex] ?? state.activeMapId;
      return {
        rotation: {
          ...state.rotation,
          currentIndex,
          nextSwitchAt: Date.now() + state.rotation.intervalSeconds * 1000,
        },
        activeMapId: nextMapId,
        map: state.readOnly
          ? (state.publicMaps.find((item) => item.id === nextMapId) ?? null)
          : null,
        selection: null,
      };
    }),
  markSaved: () => set({ dirty: false, toast: 'Mapa salvo' }),
  showToast: (toast) => {
    set({ toast });
    window.setTimeout(() => set({ toast: null }), 2600);
  },
}));
