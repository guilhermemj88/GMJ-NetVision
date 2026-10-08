'use client';

import { useEffect } from 'react';

/**
 * Sinaliza ao renderer de snapshot que a página pode ser fotografada (o flag é
 * conferido por `waitForFunction`). Espera dois frames + um pequeno atraso para
 * o Recharts ter pintado; sem gráficos o atraso pode ser mínimo.
 */
export function SnapshotReadySignal({ delayMs = 350 }: { delayMs?: number }) {
  useEffect(() => {
    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          (window as Window & { __netvisionSnapshotReady?: boolean }).__netvisionSnapshotReady = true;
        });
      });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [delayMs]);
  return null;
}
