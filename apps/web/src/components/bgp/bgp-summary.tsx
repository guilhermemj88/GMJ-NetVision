'use client';

import type { BgpDashboardSummary } from '@gmj/shared';
import { formatRouteCount } from '@/lib/bgp-format';

export function BgpSummary({ summary }: { summary: BgpDashboardSummary }) {
  const cards = [
    { label: 'BGP PEERS', value: String(summary.peers), tone: 'neutral' },
    { label: 'ESTABLISHED', value: String(summary.established), tone: 'up' },
    { label: 'DOWN', value: String(summary.down), tone: 'down' },
    { label: 'ROTAS RECEBIDAS', value: formatRouteCount(summary.receivedPrefixes), tone: 'routes' },
  ] as const;

  return (
    <div className="bgp-summary">
      {cards.map((card) => (
        <div key={card.label} className={`bgp-summary__card bgp-summary__card--${card.tone}`}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </div>
      ))}
    </div>
  );
}
