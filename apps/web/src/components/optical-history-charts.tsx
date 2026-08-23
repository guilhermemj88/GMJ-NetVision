'use client';

import { useState } from 'react';
import type { HistoryPeriod, NetworkInterface, OpticalHistoryPoint } from '@gmj/shared';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getOpticalHistory } from '@/lib/api';
import { withTemporalGapMarkers } from '@/lib/chart-history';

const periods: HistoryPeriod[] = ['15m', '1h', '6h', '24h', '7d'];
const laneColors = ['#43d6b5', '#44a8e8', '#e3a64b', '#d165b8', '#a8d565', '#d17a65'];

export type OpticalChartDatum = {
  timestamp: string;
  label: string;
  sampleCount: number;
  source: OpticalHistoryPoint | null;
  [key: string]: string | number | OpticalHistoryPoint | null;
};

function timeLabel(value: string, period: HistoryPeriod): string {
  const date = new Date(value);
  if (period === '7d') {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDbm(value: number | null): string {
  return value == null ? 'N/D' : `${value.toFixed(2)} dBm`;
}

export function opticalChartData(
  points: OpticalHistoryPoint[],
  laneIds: number[],
  period: HistoryPeriod,
): OpticalChartDatum[] {
  const raw = points.map((point): OpticalChartDatum => {
    const datum: OpticalChartDatum = {
      timestamp: point.timestamp,
      label: timeLabel(point.timestamp, period),
      sampleCount: point.sampleCount,
      source: point,
      rxAvg: point.rxAvg,
      txAvg: point.txAvg,
    };
    for (const laneId of laneIds) {
      const lane = point.lanes.find((item) => item.lane === laneId);
      datum[`lane_${laneId}_rxAvg`] = lane?.rxAvg ?? null;
      datum[`lane_${laneId}_txAvg`] = lane?.txAvg ?? null;
    }
    return datum;
  });
  return withTemporalGapMarkers(raw, period, (timestamp) => {
    const gap: OpticalChartDatum = {
      timestamp,
      label: timeLabel(timestamp, period),
      sampleCount: 0,
      source: null,
      rxAvg: null,
      txAvg: null,
    };
    for (const laneId of laneIds) {
      gap[`lane_${laneId}_rxAvg`] = null;
      gap[`lane_${laneId}_txAvg`] = null;
    }
    return gap;
  });
}

export function opticalSeries(laneIds: number[], direction: 'rx' | 'tx') {
  if (!laneIds.length) {
    return [{
      dataKey: `${direction}Avg`,
      name: direction.toUpperCase(),
      stroke: direction === 'rx' ? '#43d6b5' : '#44a8e8',
    }];
  }
  return laneIds.map((lane, index) => ({
    dataKey: `lane_${lane}_${direction}Avg`,
    name: `Lane ${lane}`,
    stroke: laneColors[index % laneColors.length] ?? '#43d6b5',
  }));
}

export function OpticalHistoryCharts({
  networkInterface,
}: {
  networkInterface: NetworkInterface;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>('1h');
  const history = useQuery({
    queryKey: ['optical-history', networkInterface.id, period],
    queryFn: () => getOpticalHistory(networkInterface.id, period),
  });
  const laneIds = [...new Set([
    ...(networkInterface.opticalLanes ?? []).map((lane) => lane.lane),
    ...(history.data ?? []).flatMap((point) => point.lanes.map((lane) => lane.lane)),
  ])].sort((left, right) => left - right);
  const data = opticalChartData(history.data ?? [], laneIds, period);

  return (
    <section className="charts-section optical-history-section">
      <div className="chart-heading">
        <div>
          <span>HISTÓRICO ÓPTICO</span>
          <strong>Potência recebida e transmitida</strong>
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

      {!data.length ? (
        <div className="chart-empty">Sem amostras ópticas no período</div>
      ) : (
        <div className="chart-pair chart-pair--optical">
          <OpticalPowerChart data={data} laneIds={laneIds} direction="rx" />
          <OpticalPowerChart data={data} laneIds={laneIds} direction="tx" />
        </div>
      )}
    </section>
  );
}

function OpticalPowerChart({
  data,
  laneIds,
  direction,
}: {
  data: OpticalChartDatum[];
  laneIds: number[];
  direction: 'rx' | 'tx';
}) {
  const title = direction.toUpperCase();
  return (
    <div className="chart-block chart-block--optical">
      <div className="chart-block__legend">
        <strong>{title} · dBm</strong>
        {laneIds.map((lane, index) => (
          <span key={lane} style={{ color: laneColors[index % laneColors.length] }}>
            Lane {lane}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="#23303a" vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="label" tick={{ fill: '#6f8392', fontSize: 8 }} minTickGap={24} />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#6f8392', fontSize: 8 }}
            tickLine={false}
            axisLine={false}
            unit=" dBm"
          />
          <Tooltip content={(props) => (
            <OpticalHistoryTooltip
              active={props.active}
              payload={props.payload as unknown as ReadonlyArray<{ payload?: OpticalChartDatum }> | undefined}
              direction={direction}
              laneIds={laneIds}
            />
          )} />
          {opticalSeries(laneIds, direction).map((series) => (
            <Line
              key={series.dataKey}
              type="stepAfter"
              dataKey={series.dataKey}
              name={series.name}
              stroke={series.stroke}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function OpticalHistoryTooltip({
  active,
  payload,
  direction,
  laneIds,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: OpticalChartDatum }> | undefined;
  direction: 'rx' | 'tx';
  laneIds: number[];
}) {
  const point = payload?.find((item) => item.payload?.source)?.payload?.source;
  if (!active || !point) return null;
  const scalar = direction === 'rx'
    ? { avg: point.rxAvg, min: point.rxMin, max: point.rxMax }
    : { avg: point.txAvg, min: point.txMin, max: point.txMax };
  return (
    <div className="chart-tooltip">
      <strong>{new Date(point.timestamp).toLocaleString('pt-BR')}</strong>
      {laneIds.length ? laneIds.map((laneId) => {
        const lane = point.lanes.find((item) => item.lane === laneId);
        if (!lane) return null;
        const values = direction === 'rx'
          ? { avg: lane.rxAvg, min: lane.rxMin, max: lane.rxMax }
          : { avg: lane.txAvg, min: lane.txMin, max: lane.txMax };
        return (
          <span key={laneId}>
            Lane {laneId} · média {formatDbm(values.avg)} · mín {formatDbm(values.min)} · máx {formatDbm(values.max)}
          </span>
        );
      }) : (
        <span>
          Média {formatDbm(scalar.avg)} · mín {formatDbm(scalar.min)} · máx {formatDbm(scalar.max)}
        </span>
      )}
      <small>{point.sampleCount} amostra{point.sampleCount === 1 ? '' : 's'} no bucket</small>
    </div>
  );
}
