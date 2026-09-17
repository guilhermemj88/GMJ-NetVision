'use client';

import type { QueryClient } from '@tanstack/react-query';
import type {
  LinkHandleSide,
  LinkLayoutMode,
  LinkVisualPath,
  NetworkLink,
  NetworkMap,
} from '@gmj/shared';
import { updateLink } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

/**
 * Fields the map canvas owns. Keeping them in a named type makes it explicit
 * that the visual controls can never touch endpoints, telemetry or interfaces.
 */
export interface LinkCanvasPatch {
  visualPaths?: LinkVisualPath[];
  linkLayoutMode?: LinkLayoutMode;
  sourceHandleSide?: LinkHandleSide;
  targetHandleSide?: LinkHandleSide;
}

/**
 * `PATCH /links/:linkId` requires the link option fields on every call, so the
 * canvas controls always send the currently persisted values back untouched.
 */
export function linkPatchBase(link: NetworkLink) {
  return {
    capacityBps: link.capacityBps,
    autoCapacityBps: link.autoCapacityBps,
    capacitySource: link.capacitySource,
    label: link.label,
    metricSource: link.metricSource,
    visualStyle: link.visualStyle,
    metricDisplay: link.metricDisplay,
  };
}

/** The freshest copy of the link in the store (a drag may have a draft applied). */
export function currentStoreLink(link: NetworkLink): NetworkLink {
  // Read lazily (no subscription) so the canvas controls never re-render on map changes.
  return useMapStore.getState().map?.links.find((item) => item.id === link.id) ?? link;
}

/**
 * Cancels an in-flight map refetch and writes the patch into the cached map, so
 * a stale response can never revert a value the user just persisted.
 */
export async function cacheLinkPatch(
  client: QueryClient,
  link: Pick<NetworkLink, 'id' | 'mapId'>,
  patch: LinkCanvasPatch,
): Promise<void> {
  await client.cancelQueries({ queryKey: ['map', link.mapId] });
  client.setQueryData<NetworkMap>(['map', link.mapId], (map) =>
    map
      ? {
          ...map,
          links: map.links.map((item) => (item.id === link.id ? { ...item, ...patch } : item)),
        }
      : map,
  );
}

/**
 * Writes the authoritative server link into the cached map. Without this, a
 * later canvas edit would merge into a stale cached link (whose data would then
 * be pushed back into the store by the `mapQuery` observer) and silently undo
 * the previous save.
 */
export async function cacheLinkReplace(client: QueryClient, link: NetworkLink): Promise<void> {
  await client.cancelQueries({ queryKey: ['map', link.mapId] });
  client.setQueryData<NetworkMap>(['map', link.mapId], (map) =>
    map
      ? { ...map, links: map.links.map((item) => (item.id === link.id ? link : item)) }
      : map,
  );
}

/** Persists a canvas-owned patch and returns the full link the API persisted. */
export async function persistLinkPatch(
  client: QueryClient,
  link: NetworkLink,
  patch: LinkCanvasPatch,
): Promise<NetworkLink> {
  const updated = await updateLink(link.mapId, link.id, {
    ...linkPatchBase(currentStoreLink(link)),
    ...patch,
  });
  await cacheLinkReplace(client, updated);
  return updated;
}
