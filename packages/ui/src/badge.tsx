import type { ReactNode } from 'react';

export function Badge({ tone = 'neutral', children }: { tone?: string; children: ReactNode }) {
  return <span className={`nv-badge nv-badge--${tone.toLowerCase()}`}>{children}</span>;
}
