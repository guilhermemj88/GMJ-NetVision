'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { EdgeLabelRenderer, useReactFlow, useViewport } from '@xyflow/react';
import { useQueryClient } from '@tanstack/react-query';
import type { NetworkLink, NetworkMap } from '@gmj/shared';
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

export function LinkCurvatureHandle({
  link,
  pathIndex,
  autoOffset,
  point,
  source,
  target,
}: {
  link: NetworkLink;
  pathIndex: number;
  autoOffset: number;
  point: { x: number; y: number };
  source: { x: number; y: number };
  target: { x: number; y: number };
}) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const client = useQueryClient();
  const drag = useRef<Drag | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const busy = useMapStore((state) => Boolean(state.linkGeometryDrafts[link.id]));
  const editable = () => {
    const state = useMapStore.getState();
    return state.map?.id === link.mapId && state.editMode && !state.readOnly;
  };

  useEffect(
    () => () => {
      const active = drag.current;
      drag.current = null;
      const state = useMapStore.getState();
      if (
        active?.current &&
        state.map?.id === link.mapId &&
        state.linkGeometryDrafts[link.id] === active.current
      ) {
        state.setLinkGeometryDraft(link.id, active.original);
        state.setLinkGeometryDraft(link.id, null);
      }
    },
    [link.id, link.mapId],
  );

  const cancel = () => {
    const active = drag.current;
    drag.current = null;
    setOffset(null);
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

  const move = (event: PointerEvent<HTMLButtonElement>) => {
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

  const save = async (geometry: LinkGeometry, original: LinkGeometry) => {
    try {
      // Cancel an older refresh before the PATCH, then update its cached geometry.
      await client.cancelQueries({ queryKey: ['map', link.mapId] });
      const latest = useMapStore.getState().map?.links.find((item) => item.id === link.id) ?? link;
      const updated = await updateLink(link.mapId, link.id, {
        capacityBps: latest.capacityBps,
        autoCapacityBps: latest.autoCapacityBps,
        capacitySource: latest.capacitySource,
        label: latest.label,
        metricSource: latest.metricSource,
        visualStyle: latest.visualStyle,
        metricDisplay: latest.metricDisplay,
        ...geometry,
      });
      // A partial response must never blank the geometry: fall back to the
      // draft that was just persisted.
      const saved: LinkGeometry = {
        visualPaths: updated.visualPaths ?? geometry.visualPaths,
        linkLayoutMode: updated.linkLayoutMode ?? geometry.linkLayoutMode,
      };
      await client.cancelQueries({ queryKey: ['map', link.mapId] });
      client.setQueryData<NetworkMap>(['map', link.mapId], (map) =>
        map
          ? {
              ...map,
              links: map.links.map((item) => (item.id === link.id ? { ...item, ...saved } : item)),
            }
          : map,
      );
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

  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        className="link-curvature-handle nodrag nopan"
        aria-label={`Arrastar curva do caminho ${pathIndex + 1}${link.visualPaths[pathIndex]?.label ? `: ${link.visualPaths[pathIndex]?.label}` : ''}`}
        title={`Arrastar curva do caminho ${pathIndex + 1}`}
        aria-disabled={busy && !drag.current}
        style={{
          transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px) scale(${1 / Math.max(zoom, 0.01)})`,
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
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
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
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
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          event.stopPropagation();
          cancel();
        }}
        onLostPointerCapture={cancel}
      >
        <span className="link-curvature-handle__dot" />
        {offset !== null && (
          <span className="link-curvature-handle__value">
            Curvatura: {offset >= 0 ? '+' : ''}
            {Math.round(offset)} px
          </span>
        )}
      </button>
    </EdgeLabelRenderer>
  );
}
