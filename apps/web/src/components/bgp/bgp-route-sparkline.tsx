'use client';

import { useMemo } from 'react';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';

export function BgpRouteSparkline({
  samples,
  height = 24,
}: {
  samples: Array<number | null>;
  height?: number;
}) {
  const data = useMemo(() => samples.map((value) => ({ value })), [samples]);
  const hasValue = data.some((point) => point.value !== null);

  if (!hasValue || data.length < 2) {
    return <span className="bgp-sparkline bgp-sparkline--empty">—</span>;
  }

  return (
    <span className="bgp-sparkline" aria-label="Rotas recebidas">
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#65cce7"
            strokeWidth={1.2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </span>
  );
}
