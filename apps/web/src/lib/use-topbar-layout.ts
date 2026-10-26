'use client';

import { useLayoutEffect, useRef, useState } from 'react';

/** The measured header is the single source of truth, including zoom and font changes. */
export function useTopbarLayout(view: string) {
  const ref = useRef<HTMLElement>(null);
  const [singleRow, setSingleRow] = useState(false);
  useLayoutEffect(() => {
    const header = ref.current;
    const app = header?.closest<HTMLElement>('.netvision-app');
    if (!header || !app) return;
    const update = () => {
      app.style.setProperty('--topbar-height', `${header.getBoundingClientRect().height}px`);
      const brand = header.querySelector('.brand');
      const nav = header.querySelector('.primary-nav');
      const controls = header.querySelector('.topbar__controls .horizontal-scroll__content');
      const required =
        (brand?.getBoundingClientRect().width ?? 0) +
        (nav?.scrollWidth ?? 0) +
        (controls?.scrollWidth ?? 0) +
        76;
      setSingleRow(header.clientWidth >= required);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(header);
    header.querySelectorAll('.brand, .primary-nav, .horizontal-scroll__content').forEach((node) => {
      observer?.observe(node);
    });
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      app.style.removeProperty('--topbar-height');
    };
  }, [view]);
  return { ref, singleRow };
}
