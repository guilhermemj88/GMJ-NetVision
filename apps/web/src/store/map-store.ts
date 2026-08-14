'use client';

import type {
  CreateLinkInput,
  Device,
  MapPreferences,
  NetworkLink,
  NetworkMap,
  Position,
} from '@gmj/shared';
import { create } from 'zustand';

export type Selection =
  | { kind: 'device'; id: string }
  | { kind: 'link'; id: string }
  | { kind: 'interface'; id: string; deviceId: string }
  | null;
export type OpenPanel = 'add-device' | 'create-link' | 'discovery' | 'settings' | null;

interface MapState {
  map: NetworkMap | null;
  editMode: boolean;
  selection: Selection;
  panel: OpenPanel;
  pendingLink: { sourceDeviceId?: string; targetDeviceId?: string } | null;
  preferences: MapPreferences;
  dirty: boolean;
  toast: string | null;
  setMap: (map: NetworkMap) => void;
  setEditMode: (enabled: boolean) => void;
  setSelection: (selection: Selection) => void;
  setPanel: (panel: OpenPanel) => void;
  setPendingLink: (value: MapState['pendingLink']) => void;
  setPreference: (key: keyof MapPreferences) => void;
  moveNode: (nodeId: string, position: Position) => void;
  setNodeLocked: (nodeId: string, locked: boolean) => void;
  applyLayout: (positions: Map<string, Position>) => void;
  addLink: (input: CreateLinkInput, serverLink?: NetworkLink) => void;
  replaceLink: (link: NetworkLink) => void;
  removeLink: (linkId: string) => void;
  addDevice: (device: Device, position: Position) => void;
  removeDevice: (deviceId: string) => void;
  markSaved: () => void;
  showToast: (message: string) => void;
}

const preferenceDefaults: MapPreferences = {
  showTraffic: true,
  showUtilization: true,
  showLabels: true,
  showOffline: true,
  showInterfaces: false,
};

function restorePositions(map: NetworkMap): NetworkMap {
  if (typeof window === 'undefined') return map;
  const saved = window.localStorage.getItem(`gmj:positions:${map.id}`);
  if (!saved) return map;
  try {
    const positions = JSON.parse(saved) as Record<string, Position>;
    return {
      ...map,
      nodes: map.nodes.map((node) => {
        const position = positions[node.id];
        return position ? { ...node, position, positionSource: 'MANUAL' } : node;
      }),
    };
  } catch {
    return map;
  }
}

function persistPositions(map: NetworkMap): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    `gmj:positions:${map.id}`,
    JSON.stringify(Object.fromEntries(map.nodes.map((node) => [node.id, node.position]))),
  );
}

export const useMapStore = create<MapState>((set) => ({
  map: null,
  editMode: false,
  selection: null,
  panel: null,
  pendingLink: null,
  preferences: preferenceDefaults,
  dirty: false,
  toast: null,
  setMap: (map) => set({ map: restorePositions(map) }),
  setEditMode: (editMode) => set({ editMode, panel: null }),
  setSelection: (selection) => set({ selection }),
  setPanel: (panel) => set({ panel }),
  setPendingLink: (pendingLink) => set({ pendingLink }),
  setPreference: (key) =>
    set((state) => ({ preferences: { ...state.preferences, [key]: !state.preferences[key] } })),
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
        id: `local-${crypto.randomUUID()}`,
        mapId: state.map.id,
        ...input,
        status: 'UP',
        discoverySource: 'MANUAL',
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
  addDevice: (device, position) =>
    set((state) =>
      state.map
        ? {
            map: {
              ...state.map,
              devices: [...state.map.devices, device],
              nodes: [
                ...state.map.nodes,
                {
                  id: `node-${device.id}`,
                  mapId: state.map.id,
                  deviceId: device.id,
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
  removeDevice: (deviceId) =>
    set((state) =>
      state.map
        ? {
            map: {
              ...state.map,
              devices: state.map.devices.filter((device) => device.id !== deviceId),
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
  markSaved: () => set({ dirty: false, toast: 'Mapa salvo' }),
  showToast: (toast) => {
    set({ toast });
    window.setTimeout(() => set({ toast: null }), 2600);
  },
}));
