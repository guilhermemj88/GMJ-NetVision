'use client';

import type { BgpDashboardSummary } from '@gmj/shared';
import { formatRouteCount } from '@/lib/bgp-format';

export function BgpSummary({ summary }: { summary: BgpDashboardSummary }) {
  const byFamily = summary.byFamily ?? { IPV4: 0, IPV6: 0 };
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
          {card.tone === 'neutral' && (
            <small className="bgp-summary__families">
              IPv4: {byFamily.IPV4} · IPv6: {byFamily.IPV6}
            </small>
          )}
        </div>
      ))}
    </div>
  );
}
