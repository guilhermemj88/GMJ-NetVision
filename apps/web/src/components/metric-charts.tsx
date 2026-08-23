'use client';

import { useState } from 'react';
import type { HistoryPeriod, NetworkInterface } from '@gmj/shared';
import { formatBitsPerSecond } from '@gmj/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getHistory } from '@/lib/api';

const periods: HistoryPeriod[] = ['15m', '1h', '6h', '24h', '7d'];

function timeLabel(value: string, period: HistoryPeriod): string {
  const date = new Date(value);
  if (period === '7d')
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function MetricCharts({ networkInterface }: { networkInterface: NetworkInterface }) {
  const [period, setPeriod] = useState<HistoryPeriod>('1h');
  const history = useQuery({
    queryKey: ['history', networkInterface.id, period],
    queryFn: () => getHistory(networkInterface.id, period),
  });
  const data = (history.data ?? []).map((point) => ({
    ...point,
    label: timeLabel(point.timestamp, period),
    rxGbps: point.rxBps / 1_000_000_000,
    txGbps: point.txBps / 1_000_000_000,
    rxMaxGbps: point.rxBpsMax === undefined ? null : point.rxBpsMax / 1_000_000_000,
    txMaxGbps: point.txBpsMax === undefined ? null : point.txBpsMax / 1_000_000_000,
  }));
  const lastHistorical = history.data?.at(-1);

  return (
    <section className="charts-section">
      <div className="chart-heading">
        <div>
          <span>HISTÓRICO</span>
          <strong>Telemetria da interface</strong>
        </div>
        <div className="period-picker">
          {periods.map((item) => (
            <button
              key={item}
              type="button"
              className={period === item ? 'is-active' : ''}
              onClick={() => setPeriod(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="chart-block">
        <div className="chart-block__legend">
          <strong>ATUAL</strong>
          <span className="rx">RX {formatBitsPerSecond(networkInterface.rxBps)}</span>
          <span className="tx">TX {formatBitsPerSecond(networkInterface.txBps)}</span>
        </div>
        <div className="chart-block__legend chart-block__legend--history">
          <strong>HISTÓRICO · última amostra</strong>
          {lastHistorical ? (
            <>
              <span className="rx">RX {formatBitsPerSecond(lastHistorical.rxBps)}</span>
              <span className="tx">TX {formatBitsPerSecond(lastHistorical.txBps)}</span>
            </>
          ) : (
            <span>Sem amostras no período</span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={185}>
          <AreaChart data={data} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
            <defs>
              <linearGradient id="rxFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#43d6b5" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#43d6b5" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="txFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#44a8e8" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#44a8e8" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#23303a" vertical={false} strokeDasharray="2 4" />
            <XAxis
              dataKey="label"
              tick={{ fill: '#6f8392', fontSize: 9 }}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: '#6f8392', fontSize: 9 }}
              tickLine={false}
              axisLine={false}
              unit="G"
            />
            <Tooltip
              contentStyle={{
                background: '#101820',
                border: '1px solid #2a3d49',
                borderRadius: 6,
                fontSize: 11,
              }}
            />
            <Area
              type="linear"
              dataKey="rxGbps"
              name="RX Gbps"
              stroke="#43d6b5"
              fill="url(#rxFill)"
              strokeWidth={1.7}
              dot={false}
            />
            <Area
              type="linear"
              dataKey="txGbps"
              name="TX Gbps"
              stroke="#44a8e8"
              fill="url(#txFill)"
              strokeWidth={1.7}
              dot={false}
            />
            <Area
              type="linear"
              dataKey="rxMaxGbps"
              name="Pico RX Gbps"
              stroke="#73e6c9"
              fill="none"
              strokeWidth={1}
              strokeDasharray="3 4"
              dot={false}
            />
            <Area
              type="linear"
              dataKey="txMaxGbps"
              name="Pico TX Gbps"
              stroke="#75c7f3"
              fill="none"
              strokeWidth={1}
              strokeDasharray="3 4"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-pair">
        <SmallMetricChart data={data} title="Erros" rxKey="rxErrors" txKey="txErrors" />
        <SmallMetricChart data={data} title="Discards" rxKey="rxDiscards" txKey="txDiscards" />
      </div>
    </section>
  );
}

function SmallMetricChart({
  data,
  title,
  rxKey,
  txKey,
}: {
  data: Array<Record<string, string | number | null | undefined>>;
  title: string;
  rxKey: 'rxErrors' | 'rxDiscards';
  txKey: 'txErrors' | 'txDiscards';
}) {
  return (
    <div className="chart-block chart-block--small">
      <div className="chart-block__legend">
        <strong>{title}</strong>
      </div>
      <ResponsiveContainer width="100%" height={112}>
        <LineChart data={data} margin={{ top: 8, right: 4, left: -34, bottom: 0 }}>
          <CartesianGrid stroke="#23303a" vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="label" hide />
          <YAxis
            tick={{ fill: '#6f8392', fontSize: 8 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              background: '#101820',
              border: '1px solid #2a3d49',
              borderRadius: 6,
              fontSize: 10,
            }}
          />
          <Line type="stepAfter" dataKey={rxKey} stroke="#e3a64b" strokeWidth={1.5} dot={false} />
          <Line type="stepAfter" dataKey={txKey} stroke="#d16565" strokeWidth={1.4} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
