'use client';

import { useEffect, useId, useRef, useState, type ReactNode, type CSSProperties } from 'react';

const INTERACTIVE =
  'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="combobox"], [role="slider"], [role="textbox"], [contenteditable]:not([contenteditable="false"]), [tabindex]';

/** Native touch/trackpad scrolling, with mouse dragging only on unused space. */
export function HorizontalScroll({
  children,
  label,
  className = '',
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; left: number; active: boolean } | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [metrics, setMetrics] = useState({ position: 0, max: 0, thumb: 24 });

  useEffect(() => {
    const scroller = scrollRef.current;
    const inner = innerRef.current;
    if (!scroller || !inner) return;
    const measure = () => {
      const left = scroller.scrollLeft > 1;
      const right = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
      const next = {
        position: scroller.scrollLeft,
        max: Math.max(0, scroller.scrollWidth - scroller.clientWidth),
        thumb: Math.max(24, scroller.clientWidth ** 2 / Math.max(1, scroller.scrollWidth)),
      };
      setMetrics((previous) =>
        previous.position === next.position &&
        previous.max === next.max &&
        previous.thumb === next.thumb
          ? previous
          : next,
      );
      setEdges((previous) =>
        previous.left === left && previous.right === right ? previous : { left, right },
      );
    };
    measure();
    scroller.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    observer?.observe(inner);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      scroller.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);

  const finish = (element: HTMLDivElement) => {
    const pointer = drag.current;
    drag.current = null;
    element.classList.remove('is-dragging');
    if (pointer && element.hasPointerCapture?.(pointer.id))
      element.releasePointerCapture(pointer.id);
  };

  return (
    <div
      className={`horizontal-scroll ${className}`}
      data-left={edges.left}
      data-right={edges.right}
    >
      <div
        ref={scrollRef}
        id={id}
        className="horizontal-scroll__viewport"
        role="region"
        aria-label={label}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.pointerType !== 'mouse' || event.button !== 0) return;
          const target = event.target as HTMLElement;
          // Preserve controls, text selection and native touch. No capture before the threshold.
          const interactive = target.closest(INTERACTIVE);
          if (interactive && interactive !== event.currentTarget) return;
          if (target !== event.currentTarget && target !== innerRef.current) return;
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            left: event.currentTarget.scrollLeft,
            active: false,
          };
        }}
        onPointerMove={(event) => {
          const pointer = drag.current;
          if (!pointer || pointer.id !== event.pointerId) return;
          if (!event.buttons) return finish(event.currentTarget);
          const distance = event.clientX - pointer.x;
          if (!pointer.active && Math.abs(distance) < 6) return;
          pointer.active = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          event.currentTarget.classList.add('is-dragging');
          event.preventDefault();
          event.currentTarget.scrollLeft = pointer.left - distance;
        }}
        onPointerUp={(event) => finish(event.currentTarget)}
        onPointerCancel={(event) => finish(event.currentTarget)}
        onLostPointerCapture={(event) => finish(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const element = event.currentTarget;
          const positions: Record<string, number> = {
            ArrowLeft: element.scrollLeft - 100,
            ArrowRight: element.scrollLeft + 100,
            Home: 0,
            End: element.scrollWidth,
          };
          if (!(event.key in positions)) return;
          event.preventDefault();
          element.scrollLeft = positions[event.key]!;
        }}
      >
        <div ref={innerRef} className="horizontal-scroll__content">
          {children}
        </div>
      </div>
      {metrics.max > 1 && (
        <input
          className="horizontal-scroll__bar"
          type="range"
          min={0}
          max={metrics.max}
          step={1}
          value={metrics.position}
          aria-label={`Posição horizontal: ${label}`}
          aria-controls={id}
          style={{ '--scroll-thumb-width': `${metrics.thumb}px` } as CSSProperties}
          onChange={(event) => {
            const position = Number(event.target.value);
            setMetrics((previous) => ({ ...previous, position }));
            if (scrollRef.current) scrollRef.current.scrollLeft = position;
          }}
        />
      )}
    </div>
  );
}
