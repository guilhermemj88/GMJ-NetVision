'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { HistoryPeriod, LinkInterfaceResolver, MetricPoint, NetworkLink } from '@gmj/shared';
import { formatBitsPerSecond } from '@gmj/shared';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getHistory } from '@/lib/api';
import { withTemporalGapMarkers } from '@/lib/chart-history';
import {
  buildLinkCounterRecords,
  buildLinkHistorySeries,
  linkHistoryPlans,
  seriesStats,
  utilizationPercent,
  type LinkHistoryDirectionId,
  type LinkHistorySeries,
} from '@/lib/link-traffic-history';
import { emptyHistoryNotice } from '@/lib/telemetry-feedback';
import { MetricCounterChart } from './metric-charts';

const PERIODS: HistoryPeriod[] = ['1h', '6h', '24h', '7d'];
const A_TO_B_COLOR = '#58abd5';
const B_TO_A_COLOR = '#59bca1';
const A_TO_B_FILL_ID = 'linkAToBFill';
const B_TO_A_FILL_ID = 'linkBToAFill';
const DIRECTION_LABELS: Record<LinkHistoryDirectionId, string> = {
  A_TO_B: 'A → B',
  B_TO_A: 'B → A',
};

function axisLabel(timestamp: string, period: HistoryPeriod): string {
  const date = new Date(timestamp);
  if (period === '7d') {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

interface LinkHistoryChartRow {
  timestamp: string;
  aToB: number | null;
  bToA: number | null;
}

interface LinkHistoryChartDatum extends LinkHistoryChartRow {
  index: number;
  label: string;
  aToBGbps: number | null;
  bToAGbps: number | null;
}

function LinkHistoryTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: LinkHistoryChartRow }> | undefined;
}) {
  const point = payload?.find((item) => item.payload)?.payload;
  if (!active || !point) return null;
  return (
    <div className="chart-tooltip">
      <strong>{new Date(point.timestamp).toLocaleString('pt-BR')}</strong>
      <span>A → B {point.aToB === null ? 'N/D' : formatBitsPerSecond(point.aToB)}</span>
      <span>B → A {point.bToA === null ? 'N/D' : formatBitsPerSecond(point.bToA)}</span>
    </div>
  );
}

function DirectionSummary({
  direction,
  series,
  capacityBps,
}: {
  direction: LinkHistoryDirectionId;
  series: LinkHistorySeries;
  capacityBps: number;
}) {
  const stats = seriesStats(series.points);
  const utilization = utilizationPercent(stats.current, capacityBps);
  return (
    <div className={direction === 'A_TO_B' ? 'tx' : ''}>
      <span>
        {DIRECTION_LABELS[direction]} · {series.used?.label ?? 'sem dados'}
      </span>
      <strong>{stats.current === null ? 'N/D' : formatBitsPerSecond(stats.current)}</strong>
      <small>
        {stats.samples
          ? [
              `média ${formatBitsPerSecond(stats.average ?? 0)}`,
              `pico ${formatBitsPerSecond(stats.peak ?? 0)}`,
              utilization === null ? null : `${utilization.toFixed(1)}% da capacidade`,
            ]
              .filter((item): item is string => item !== null)
              .join(' · ')
          : 'sem amostras no período'}
      </small>
    </div>
  );
}

/**
 * TRAFEGO HISTORICO do enlace: serie A → B e B → A montada das MESMAS amostras
 * SNMP que o painel da interface usa (`/api/interfaces/:id/history`), com a
 * orientacao canonica do mapa (TX da origem; RX do destino so como fallback
 * comprovado quando o TX nao tem historico). Lacunas viram quebra de linha —
 * nunca interpolacao — e nenhuma ponta e somada com a outra.
 */
export function LinkTrafficHistory({
  link,
  findInterface,
}: {
  link: NetworkLink;
  findInterface: LinkInterfaceResolver;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>('1h');
  const plans = useMemo(() => linkHistoryPlans(link, findInterface), [link, findInterface]);
  const allInterfaces = useMemo(
    () =>
      plans.flatMap((plan) => [
        ...(plan.primary?.interfaces ?? []),
        ...(plan.fallback?.interfaces ?? []),
      ]),
    [plans],
  );
  const interfaceIds = useMemo(
    () => [...new Set(allInterfaces.map((item) => item.id))],
    [allInterfaces],
  );
  const queries = useQueries({
    queries: interfaceIds.map((interfaceId) => ({
      queryKey: ['history', interfaceId, period] as const,
      queryFn: () => getHistory(interfaceId, period),
    })),
  });
  const historyFor = useCallback(
    (interfaceId: string): MetricPoint[] | undefined => {
      const index = interfaceIds.indexOf(interfaceId);
      return index === -1 ? undefined : queries[index]?.data;
    },
    [interfaceIds, queries],
  );
  const series = useMemo(
    () => plans.map((plan) => buildLinkHistorySeries(plan, historyFor)),
    [plans, historyFor],
  );
  const rows = useMemo<LinkHistoryChartDatum[]>(() => {
    const aToB = series.find((item) => item.direction === 'A_TO_B');
    const bToA = series.find((item) => item.direction === 'B_TO_A');
    const aMap = new Map((aToB?.points ?? []).map((point) => [point.timestamp, point.value]));
    const bMap = new Map((bToA?.points ?? []).map((point) => [point.timestamp, point.value]));
    const timestamps = [...new Set([...aMap.keys(), ...bMap.keys()])].sort(
      (left, right) => left.localeCompare(right),
    );
    const raw: LinkHistoryChartRow[] = timestamps.map((timestamp) => ({
      timestamp,
      aToB: aMap.get(timestamp) ?? null,
      bToA: bMap.get(timestamp) ?? null,
    }));
    const gapped = withTemporalGapMarkers(raw, (timestamp) => ({
      timestamp,
      aToB: null,
      bToA: null,
    }));
    return gapped.map((row, index) => ({
      ...row,
      index,
      label: axisLabel(row.timestamp, period),
      aToBGbps: row.aToB === null ? null : row.aToB / 1_000_000_000,
      bToAGbps: row.bToA === null ? null : row.bToA / 1_000_000_000,
    }));
  }, [series, period]);
  const counterRows = useMemo(
    () =>
      buildLinkCounterRecords(series, historyFor).map((record, index) => ({
        ...record,
        index,
        label: axisLabel(record.timestamp, period),
        rxErrors: record.aToBErrors,
        txErrors: record.bToAErrors,
        rxDiscards: record.aToBDiscards,
        txDiscards: record.bToADiscards,
      })),
    [series, historyFor, period],
  );
  const lastCollectedAt = useMemo(() => {
    const timestamps = allInterfaces
      .map((item) => (item.telemetryUpdatedAt ? Date.parse(item.telemetryUpdatedAt) : Number.NaN))
      .filter((value) => Number.isFinite(value));
    return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
  }, [allInterfaces]);
  const isLoading = queries.some((query) => query.isLoading);
  const failed = queries.some((query) => query.isError);
  const hasAnyReading = series.some((item) => item.points.some((point) => point.value !== null));
  const hasCounterTelemetry = series.some((item) => item.used !== null);

  const notes: string[] = [];
  if (hasAnyReading) {
    for (const item of series) {
      const label = DIRECTION_LABELS[item.direction];
      if (!item.used) {
        notes.push(`${label}: sem amostras no período`);
        continue;
      }
      if (item.usedFallback) {
        notes.push(
          `${label} exibido por ${item.used.label} (TX da origem sem amostras no período)`,
        );
      }
      if (item.used.interfaces.length > 1) {
        notes.push(
          `${label}: ${item.used.label} somado de ${item.used.interfaces.length} interfaces`,
        );
      }
    }
    if (failed) notes.push('Falha ao recarregar o histórico de uma das pontas');
  }

  return (
    <section className="charts-section link-history-section">
      <div className="chart-heading">
        <div>
          <span>TRAFEGO HISTÓRICO</span>
          <strong>Fluxo A → B / B → A · amostras SNMP</strong>
        </div>
        {interfaceIds.length ? (
          <div className="period-picker">
            {PERIODS.map((item) => (
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
        ) : null}
      </div>
      {!interfaceIds.length ? (
        <p className="chart-empty-inline">
          O histórico usa as amostras SNMP reais das interfaces das pontas. Este enlace não tem
          interfaces reais associadas — não há histórico de tráfego para exibir.
          {link.metricSource === 'DEMO'
            ? ' Métricas marcadas como DEMO não são convertidas em gráfico.'
            : ''}
        </p>
      ) : (
        <>
          <div className="metric-hero">
            {series.map((item) => (
              <DirectionSummary
                key={item.direction}
                direction={item.direction}
                series={item}
                capacityBps={link.capacityBps}
              />
            ))}
          </div>
          <div className="chart-block">
            <div className="chart-block__legend">
              <strong>HISTÓRICO</strong>
              <span className="tx">A → B</span>
              <span className="rx">B → A</span>
            </div>
            {isLoading && !rows.length ? (
              <p className="chart-empty-inline">Carregando histórico de tráfego…</p>
            ) : failed && !hasAnyReading ? (
              <p className="chart-empty-inline">
                Falha ao carregar o histórico de tráfego.{' '}
                <button
                  type="button"
                  className="link-history-retry"
                  onClick={() => void Promise.all(queries.map((query) => query.refetch()))}
                >
                  TENTAR NOVAMENTE
                </button>
              </p>
            ) : rows.length ? (
              <ResponsiveContainer width="100%" height={185}>
                <ComposedChart data={rows} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
                  <defs>
                    <linearGradient id={A_TO_B_FILL_ID} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={A_TO_B_COLOR} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={A_TO_B_COLOR} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id={B_TO_A_FILL_ID} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={B_TO_A_COLOR} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={B_TO_A_COLOR} stopOpacity={0} />
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
                  <Tooltip content={(props) => (
                    <LinkHistoryTooltip
                      active={props.active}
                      payload={
                        props.payload as unknown as
                          | ReadonlyArray<{ payload?: LinkHistoryChartRow }>
                          | undefined
                      }
                    />
                  )} />
                  <Area
                    type="stepAfter"
                    dataKey="aToBGbps"
                    name="A → B Gbps"
                    stroke={A_TO_B_COLOR}
                    fill={`url(#${A_TO_B_FILL_ID})`}
                    strokeWidth={1.7}
                    dot={false}
                    connectNulls={false}
                  />
                  <Area
                    type="stepAfter"
                    dataKey="bToAGbps"
                    name="B → A Gbps"
                    stroke={B_TO_A_COLOR}
                    fill={`url(#${B_TO_A_FILL_ID})`}
                    strokeWidth={1.7}
                    dot={false}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <p className="chart-empty-inline">
                {emptyHistoryNotice(period, lastCollectedAt)}
              </p>
            )}
          </div>
          {notes.length ? (
            <ul className="link-history-notes">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          {counterRows.length && hasCounterTelemetry ? (
            <div className="chart-pair">
              <MetricCounterChart
                data={counterRows}
                title="Erros · A → B / B → A"
                series={[
                  { key: 'rxErrors', label: 'A → B', color: A_TO_B_COLOR },
                  { key: 'txErrors', label: 'B → A', color: B_TO_A_COLOR },
                ]}
              />
              <MetricCounterChart
                data={counterRows}
                title="Discards · A → B / B → A"
                series={[
                  { key: 'rxDiscards', label: 'A → B', color: A_TO_B_COLOR },
                  { key: 'txDiscards', label: 'B → A', color: B_TO_A_COLOR },
                ]}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
