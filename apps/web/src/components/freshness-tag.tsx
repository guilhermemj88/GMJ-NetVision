'use client';

import { useEffect, useState } from 'react';
import { formatRelative } from '@/lib/bgp-format';

/** Acima disso o dado deixa de ser "fresco" e o rótulo assume isso. */
const STALE_AFTER_MS = 5 * 60_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Frescor HONESTO de um dado.
 *
 * Mostra o tempo relativo real desde o timestamp informado. Quando não existe
 * timestamp confiável, diz isso em vez de afirmar que está atualizado — nada de
 * "Atualizado agora" fixo.
 */
export function FreshnessTag({
  at,
  label = 'Dados',
  unavailable = 'sem carimbo de coleta',
  className = '',
}: {
  at?: string | null | undefined;
  label?: string;
  unavailable?: string;
  className?: string;
}) {
  const now = useNow(10_000);
  const timestamp = at ? Date.parse(at) : Number.NaN;

  if (!Number.isFinite(timestamp)) {
    return (
      <span
        className={`freshness freshness--unknown ${className}`.trim()}
        title="A API não expôs um carimbo de coleta para este dado"
      >
        {label}: {unavailable}
      </span>
    );
  }

  const age = Math.max(0, now - timestamp);
  const stale = age > STALE_AFTER_MS;

  return (
    <span
      className={`freshness ${stale ? 'is-stale' : ''} ${className}`.trim()}
      title={`Último carimbo conhecido: ${new Date(timestamp).toLocaleString('pt-BR')}`}
    >
      {label} {formatRelative(age)}
      {stale ? <em> · pode estar desatualizado</em> : null}
    </span>
  );
}
