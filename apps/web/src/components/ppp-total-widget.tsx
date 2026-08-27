'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import { computePppTotal, formatPppOnline, type HostRecord, type MapWidget } from '@gmj/shared';
import { updateWidget } from '@/lib/api';

/**
 * Draggable PPP TOTAL widget rendered in canvas coordinates. The position is
 * persisted per map via the generic MapWidget architecture (type = PPP_TOTAL).
 */
export function PppTotalWidget({
  widget,
  devices,
  readOnly,
}: {
  widget: MapWidget;
  devices: HostRecord[];
  readOnly: boolean;
}) {
  const flow = useReactFlow();
  const [position, setPosition] = useState({ x: widget.positionX, y: widget.positionY });
  const positionRef = useRef(position);
  const dragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (dragging.current) return;
    setPosition({ x: widget.positionX, y: widget.positionY });
    positionRef.current = { x: widget.positionX, y: widget.positionY };
  }, [widget.positionX, widget.positionY]);

  const persist = useCallback(
    (next: { x: number; y: number }) => {
      if (widget.mapId) {
        void updateWidget(widget.mapId, widget.id, {
          positionX: next.x,
          positionY: next.y,
        }).catch(() => undefined);
      }
    },
    [widget.id, widget.mapId],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (readOnly || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging.current = true;
      lastPointer.current = { x: event.clientX, y: event.clientY };
      const move = (moveEvent: globalThis.PointerEvent) => {
        if (!dragging.current) return;
        const zoom = flow.getZoom() || 1;
        const dx = (moveEvent.clientX - lastPointer.current.x) / zoom;
        const dy = (moveEvent.clientY - lastPointer.current.y) / zoom;
        lastPointer.current = { x: moveEvent.clientX, y: moveEvent.clientY };
        const next = { x: positionRef.current.x + dx, y: positionRef.current.y + dy };
        positionRef.current = next;
        setPosition(next);
      };
      const up = () => {
        if (!dragging.current) return;
        dragging.current = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        persist(positionRef.current);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [flow, persist, readOnly],
  );

  const total = computePppTotal(devices, widget.settings);
  const settings = widget.settings;

  const style = {
    transform: `translate(${position.x}px, ${position.y}px)`,
    ...(settings.backgroundColor ? { backgroundColor: settings.backgroundColor } : {}),
    ...(settings.backgroundColor
      ? { opacity: Math.min(100, Math.max(0, settings.backgroundOpacity)) / 100 }
      : {}),
    cursor: readOnly ? 'default' : 'grab',
  } as CSSProperties;

  const valueStyle = {
    ...(settings.fontColor ? { color: settings.fontColor } : {}),
    fontSize: settings.fontSize,
  } as CSSProperties;

  return (
    <div
      className={`ppp-total-widget ${dragging.current ? 'is-dragging' : ''}`}
      style={style}
      onPointerDown={onPointerDown}
    >
      <span className="ppp-total-widget__title">{settings.title}</span>
      <strong style={valueStyle}>{formatPppOnline(total.total)}</strong>
      {settings.showHostCount && <small>{total.hostCount} hosts</small>}
      {settings.showFreshness && (
        <small>
          {total.freshHostCount}/{total.hostCount} hosts atualizados
        </small>
      )}
    </div>
  );
}
