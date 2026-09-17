'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useQueryClient } from '@tanstack/react-query';
import type { NetworkLink } from '@gmj/shared';
import { cacheLinkPatch, currentStoreLink, linkPatchBase } from '@/lib/link-persistence';
import { updateLink } from '@/lib/api';
import { draggedCurvature, manualLinkGeometry, type LinkGeometry } from '@/lib/link-curvature';
import { useMapStore } from '@/store/map-store';

interface Drag {
  pointerId: number;
  start: { x: number; y: number };
  original: LinkGeometry;
  manual: LinkGeometry;
  current: LinkGeometry | null;
}

export interface LinkCurvatureDragOptions {
  link: NetworkLink;
  pathIndex: number;
  autoOffset: number;
  source: { x: number; y: number };
  target: { x: number; y: number };
}

export interface LinkCurvatureDrag {
  /** Live curvature of the dragged path, or null when no drag is running. */
  offset: number | null;
  dragging: boolean;
  /** Spread on any element that should be able to grab the curve. */
  dragHandlers: {
    onPointerDown: (event: PointerEvent<Element>) => void;
    onPointerMove: (event: PointerEvent<Element>) => void;
    onPointerUp: (event: PointerEvent<Element>) => void;
    onPointerCancel: (event: PointerEvent<Element>) => void;
    onLostPointerCapture: () => void;
  };
}

/**
 * Single implementation of the curvature drag, shared by the mid-curve handle
 * and the whole-curve grab strip. Only the perpendicular component of the
 * pointer movement is used, so grabbing anywhere on the arc behaves exactly like
 * grabbing the handle itself: the bow follows the pointer 1:1 and dragging along
 * the curve never changes the geometry.
 */
export function useLinkCurvatureDrag({
  link,
  pathIndex,
  autoOffset,
  source,
  target,
}: LinkCurvatureDragOptions): LinkCurvatureDrag {
  const flow = useReactFlow();
  const client = useQueryClient();
  const drag = useRef<Drag | null>(null);
  const [offset, setOffset] = useState<number | null>(null);

  const editable = () => {
    const state = useMapStore.getState();
    return state.map?.id === link.mapId && state.editMode && !state.readOnly;
  };

  const releaseDraft = (active: Drag | null) => {
    const state = useMapStore.getState();
    if (
      active?.current &&
      state.map?.id === link.mapId &&
      state.linkGeometryDrafts[link.id] === active.current
    ) {
      state.setLinkGeometryDraft(link.id, active.original);
      state.setLinkGeometryDraft(link.id, null);
    }
  };

  const cancel = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    setOffset(null);
    releaseDraft(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.id, link.mapId]);

  // Leaving the map (or unmounting the edge) must never leave a draft behind.
  useEffect(
    () => () => {
      const active = drag.current;
      drag.current = null;
      releaseDraft(active);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [link.id, link.mapId],
  );

  const save = async (geometry: LinkGeometry, original: LinkGeometry) => {
    try {
      // Cancel an older refresh before the PATCH, then update its cached geometry.
      await client.cancelQueries({ queryKey: ['map', link.mapId] });
      const latest = currentStoreLink(link);
      const updated = await updateLink(link.mapId, link.id, {
        ...linkPatchBase(latest),
        ...geometry,
      });
      // A partial response must never blank the geometry: fall back to the draft.
      const saved: LinkGeometry = {
        visualPaths: updated.visualPaths ?? geometry.visualPaths,
        linkLayoutMode: updated.linkLayoutMode ?? geometry.linkLayoutMode,
      };
      await cacheLinkPatch(client, link, saved);
      const state = useMapStore.getState();
      if (state.map?.id === link.mapId && state.linkGeometryDrafts[link.id] === geometry) {
        state.setLinkGeometryDraft(link.id, saved);
        state.setLinkGeometryDraft(link.id, null);
      }
    } catch {
      const state = useMapStore.getState();
      if (state.map?.id === link.mapId && state.linkGeometryDrafts[link.id] === geometry) {
        state.setLinkGeometryDraft(link.id, original);
        state.setLinkGeometryDraft(link.id, null);
        state.showToast('Não foi possível salvar a curva. Tente novamente.');
      }
    }
  };

  const move = (event: PointerEvent<Element>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!editable()) {
      cancel();
      return;
    }
    const pointer = flow.screenToFlowPosition(
      { x: event.clientX, y: event.clientY },
      { snapToGrid: false },
    );
    const initial = active.manual.visualPaths[pathIndex];
    if (!initial) return;
    const curvature = draggedCurvature(initial.curvature, active.start, pointer, source, target);
    if (!active.current && Math.abs(curvature - initial.curvature) < 0.001) return;
    active.current = {
      ...active.manual,
      visualPaths: active.manual.visualPaths.map((path, index) =>
        index === pathIndex ? { ...path, curvature } : path,
      ),
    };
    useMapStore.getState().setLinkGeometryDraft(link.id, active.current);
    setOffset(curvature);
  };

  const dragHandlers = {
    onPointerDown: (event: PointerEvent<Element>) => {
      const busy = Boolean(useMapStore.getState().linkGeometryDrafts[link.id]);
      if (
        event.button !== 0 ||
        busy ||
        drag.current ||
        !editable() ||
        Math.hypot(target.x - source.x, target.y - source.y) < 1
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        start: flow.screenToFlowPosition(
          { x: event.clientX, y: event.clientY },
          { snapToGrid: false },
        ),
        original: { visualPaths: link.visualPaths, linkLayoutMode: link.linkLayoutMode },
        manual: manualLinkGeometry(link, autoOffset),
        current: null,
      };
    },
    onPointerMove: move,
    onPointerUp: (event: PointerEvent<Element>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      move(event);
      const active = drag.current;
      drag.current = null;
      setOffset(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      if (active?.current) void save(active.current, active.original);
    },
    onPointerCancel: (event: PointerEvent<Element>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      event.stopPropagation();
      cancel();
    },
    onLostPointerCapture: cancel,
  };

  return { offset, dragging: offset !== null, dragHandlers };
}
