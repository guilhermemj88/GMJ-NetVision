'use client';

import {
  createLocalId,
  type AddDeviceResult,
  type CreateLinkInput,
  type HostRecord,
  type LinkDisplayStyle,
  type LinkMetricDisplay,
  type MapNode,
  type MapPreferences,
  type MapSettings,
  type MapSummary,
  type NetworkLink,
  type NetworkMap,
  type NodeDisplayMode,
  type Position,
} from '@gmj/shared';
import { create } from 'zustand';

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
export type WorkspaceView = 'MAP' | 'HOSTS';

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
  setCatalog: (maps: MapSummary[]) => void;
  upsertMapSummary: (map: NetworkMap) => void;
  removeMapSummary: (mapId: string) => void;
  setActiveMap: (mapId: string) => void;
  setMap: (map: NetworkMap) => void;
  setPublicMap: (map: NetworkMap) => void;
  setReadOnly: (value: boolean) => void;
  loadPublicMaps: (maps: NetworkMap[]) => void;
  setView: (view: WorkspaceView) => void;
  setEditMode: (enabled: boolean) => void;
  setSelection: (selection: Selection) => void;
  setPanel: (panel: OpenPanel) => void;
  setPendingLink: (value: MapState['pendingLink']) => void;
  setPreference: (key: keyof MapPreferences) => void;
  setNodeDisplayMode: (mode: NodeDisplayMode) => void;
  setLinkDisplayStyle: (style: LinkDisplayStyle) => void;
  setLinkMetricDisplay: (display: LinkMetricDisplay) => void;
  setViewport: (viewport: MapSettings['viewport']) => void;
  setMapScales: (
    scales: Partial<Pick<MapSettings, 'nodeScale' | 'linkScale' | 'labelScale'>>,
  ) => void;
  moveNode: (nodeId: string, position: Position) => void;
  setNodeLocked: (nodeId: string, locked: boolean) => void;
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

function restoreLocalState(map: NetworkMap): NetworkMap {
  if (typeof window === 'undefined') return map;
  const savedPositions = window.localStorage.getItem(`gmj:positions:${map.id}`);
  const savedSettings = window.localStorage.getItem(`gmj:settings:${map.id}`);
  let restored = map;
  try {
    if (savedPositions) {
      const positions = JSON.parse(savedPositions) as Record<string, Position>;
      restored = {
        ...restored,
        nodes: restored.nodes.map((node) => {
          const position = positions[node.id];
          return position ? { ...node, position, positionSource: 'MANUAL' } : node;
        }),
      };
    }
    if (savedSettings) {
      const settings = JSON.parse(savedSettings) as MapSettings;
      restored = {
        ...restored,
        settings: {
          ...restored.settings,
          ...settings,
          filters: { ...restored.settings.filters, ...settings.filters },
          viewport: { ...restored.settings.viewport, ...settings.viewport },
        },
      };
    }
  } catch {
    return map;
  }
  return restored;
}

function persistPositions(map: NetworkMap): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    `gmj:positions:${map.id}`,
    JSON.stringify(Object.fromEntries(map.nodes.map((node) => [node.id, node.position]))),
  );
}

function persistSettings(map: NetworkMap): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(`gmj:settings:${map.id}`, JSON.stringify(map.settings));
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

export const useMapStore = create<MapState>((set) => ({
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
    set({ activeMapId, map: null, selection: null, panel: null, dirty: false }),
  setMap: (map) => {
    const restored = restoreLocalState(map);
    set({
      map: restored,
      activeMapId: restored.id,
      preferences: restored.settings.filters,
      dirty: false,
    });
  },
  setPublicMap: (map) =>
    set({
      map,
      activeMapId: map.id,
      preferences: map.settings.filters,
      readOnly: true,
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
      persistSettings(map);
      return { map, preferences, dirty: true };
    }),
  setNodeDisplayMode: (nodeDisplayMode) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        settings: { ...state.map.settings, nodeDisplayMode },
      };
      persistSettings(map);
      return { map, dirty: true };
    }),
  setLinkDisplayStyle: (linkDisplayStyle) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        settings: { ...state.map.settings, linkDisplayStyle },
      };
      persistSettings(map);
      return { map, dirty: true };
    }),
  setLinkMetricDisplay: (linkMetricDisplay) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        settings: { ...state.map.settings, linkMetricDisplay },
      };
      persistSettings(map);
      return { map, dirty: true };
    }),
  setViewport: (viewport) =>
    set((state) => {
      if (!state.map) return state;
      const map = { ...state.map, settings: { ...state.map.settings, viewport } };
      persistSettings(map);
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
      persistSettings(map);
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
      persistPositions(map);
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
  applyLayout: (positions) =>
    set((state) => {
      if (!state.map) return state;
      const map = {
        ...state.map,
        nodes: state.map.nodes.map((node) => ({
          ...node,
          position: positions.get(node.id) ?? node.position,
        })),
      };
      persistPositions(map);
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
        label: input.label,
        metricSource: input.metricSource,
        visualStyle: input.visualStyle,
        metricDisplay: input.metricDisplay,
        status: 'UP',
        discoverySource: 'MANUAL',
        directions: {
          A_TO_B: { bps: 0, utilization: 0 },
          B_TO_A: { bps: 0, utilization: 0 },
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
