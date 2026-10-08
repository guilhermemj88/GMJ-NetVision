'use client';

import { useState } from 'react';
import type {
  HistoryPeriod,
  NetworkInterface,
  OpticalHistoryPoint,
  OpticalThresholdSource,
} from '@gmj/shared';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
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

/** AUTO = escala só com os dados medidos; LIMITES = dados + LOW + HIGH. */
export type OpticalScaleMode = 'AUTO' | 'LIMITS';

/**
 * Com UMA amostra um gráfico de linha não desenha nada: nesse caso os pontos
 * viram dots, para as lanes e o timestamp continuarem visíveis.
 */
export function opticalDots(sampleCount: number): boolean {
  return sampleCount === 1;
}

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

/** Two-decimal axis tick label without the dBm suffix (kept in the chart title). */
export function formatAxisDbm(value: number): string {
  return Number(value).toFixed(2);
}

/**
 * Lane ids that actually carry optical power in one direction, so bias-only
 * lanes never become phantom RX/TX series on the power chart.
 */
export function laneIdsWithPower(
  points: OpticalHistoryPoint[],
  laneIds: number[],
  direction: 'rx' | 'tx',
): number[] {
  return laneIds.filter((laneId) => points.some((point) => {
    const lane = point.lanes.find((item) => item.lane === laneId);
    if (!lane) return false;
    const value = direction === 'rx' ? lane.rxAvg : lane.txAvg;
    return typeof value === 'number' && Number.isFinite(value);
  }));
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
  return withTemporalGapMarkers(raw, (timestamp) => {
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

/** Limite LOW/HIGH efetivo de um lado, com a origem que o forneceu. */
export interface OpticalThresholdRange {
  low: number | null;
  high: number | null;
  source: OpticalThresholdSource | null;
  scope: 'MODULE' | 'LANE' | null;
}

/**
 * Le o MESMO `Interface.opticalThresholds` canonico usado pelo Alarm Engine.
 * Prefere o limite do modulo; sem ele, usa a envoltoria dos limites por lane.
 * Sem threshold real devolve nulls (o grafico mostra N/D, nunca um limite falso).
 */
export function opticalThresholdRange(
  networkInterface: NetworkInterface,
  direction: 'rx' | 'tx',
): OpticalThresholdRange {
  const thresholds = networkInterface.opticalThresholds ?? null;
  const scalarSide = direction === 'rx' ? thresholds?.scalar.rx : thresholds?.scalar.tx;
  if (scalarSide && (scalarSide.lowAlarmDbm !== null || scalarSide.highAlarmDbm !== null)) {
    return {
      low: scalarSide.lowAlarmDbm,
      high: scalarSide.highAlarmDbm,
      source: scalarSide.lowSource ?? scalarSide.highSource ?? networkInterface.opticalThresholdSource ?? null,
      scope: 'MODULE',
    };
  }
  const laneSides = (thresholds?.lanes ?? []).map((lane) => (direction === 'rx' ? lane.rx : lane.tx));
  const lows = laneSides.map((side) => side.lowAlarmDbm).filter((value): value is number => value !== null);
  const highs = laneSides.map((side) => side.highAlarmDbm).filter((value): value is number => value !== null);
  if (!lows.length && !highs.length) return { low: null, high: null, source: null, scope: null };
  return {
    low: lows.length ? Math.min(...lows) : null,
    high: highs.length ? Math.max(...highs) : null,
    source: laneSides.find((side) => side.lowSource ?? side.highSource)?.lowSource
      ?? networkInterface.opticalThresholdSource
      ?? null,
    scope: 'LANE',
  };
}

/**
 * Janela Y a partir SOMENTE dos dados: as lanes mantem a variacao visivel e um
 * threshold distante nunca achata o grafico. `null` = deixa o recharts decidir.
 */
export function axisWindow(
  values: ReadonlyArray<number | null | undefined>,
  paddingRatio = 0.08,
): [number, number] | null {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!finite.length) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  const padding = span > 0 ? span * paddingRatio : Math.max(Math.abs(max) * 0.02, 0.1);
  return [Number((min - padding).toFixed(2)), Number((max + padding).toFixed(2))];
}

export interface OpticalThresholdMarker {
  value: number;
  /** Dentro da janela Y: vira linha de referencia tracejada. */
  visible: boolean;
  /** Fora da janela: o chip mostra o valor e para que lado ele esta. */
  hint: 'above' | 'below' | null;
}

export function thresholdMarker(
  value: number | null,
  window: [number, number] | null,
): OpticalThresholdMarker | null {
  if (value === null) return null;
  if (!window) return { value, visible: true, hint: null };
  const [min, max] = window;
  if (value < min) return { value, visible: false, hint: 'below' };
  if (value > max) return { value, visible: false, hint: 'above' };
  return { value, visible: true, hint: null };
}

export function thresholdMarkers(
  range: OpticalThresholdRange,
  window: [number, number] | null,
): { low: OpticalThresholdMarker | null; high: OpticalThresholdMarker | null } {
  return { low: thresholdMarker(range.low, window), high: thresholdMarker(range.high, window) };
}

/**
 * LIMITES: o domínio Y passa a cobrir dados + LOW + HIGH (com padding), para as
 * duas linhas de referência aparecerem na posição matemática correta.
 */
export function limitsWindow(
  values: ReadonlyArray<number | null | undefined>,
  range: Pick<OpticalThresholdRange, 'low' | 'high'>,
  paddingRatio = 0.08,
): [number, number] | null {
  return axisWindow([...values, range.low, range.high], paddingRatio);
}

export interface OpticalChartScale {
  /** Domínio Y efetivo (`null` = deixa o recharts decidir). */
  domain: [number, number] | null;
  low: OpticalThresholdMarker | null;
  high: OpticalThresholdMarker | null;
  /** Chip mostra "abaixo/acima da janela"? Só no AUTO com limite fora. */
  showHints: boolean;
}

/**
 * Decide domínio + markers de UM gráfico (RX e TX calculam o seu, de forma
 * independente). Não conhece período nem histórico: trocar o modo de escala
 * nunca refaz dados, não muda thresholds e não toca no Alarm Engine.
 */
export function chartScale(
  mode: OpticalScaleMode,
  values: ReadonlyArray<number | null | undefined>,
  thresholds: OpticalThresholdRange,
): OpticalChartScale {
  const domain = mode === 'LIMITS' ? limitsWindow(values, thresholds) : axisWindow(values);
  return {
    domain,
    low: thresholdMarker(thresholds.low, domain),
    high: thresholdMarker(thresholds.high, domain),
    showHints: mode === 'AUTO',
  };
}

/** Texto do chip quando o limite está fora da janela (nunca concatenado). */
export function thresholdHint(marker: OpticalThresholdMarker | null): string | null {
  if (marker?.hint === 'below') return '↓ abaixo da janela';
  if (marker?.hint === 'above') return '↑ acima da janela';
  return null;
}

/**
 * Cabeçalho do gráfico: cada informação em seu próprio chip/bloco. Nunca
 * concatenar LOW, HIGH e a fonte no mesmo texto.
 */
export function OpticalThresholdChips({
  thresholds,
  scale,
}: {
  thresholds: OpticalThresholdRange;
  scale: OpticalChartScale;
}) {
  const chips = [
    { key: 'LOW', label: 'LOW', value: thresholds.low, marker: scale.low },
    { key: 'HIGH', label: 'HIGH', value: thresholds.high, marker: scale.high },
  ] as const;
  return (
    <div className="chart-thresholds">
      {chips.map((chip) => {
        const hint = scale.showHints ? thresholdHint(chip.marker) : null;
        return (
          <span key={chip.key} className="chart-thresholds__chip">
            <em>{chip.label}</em>
            <span>{formatDbm(chip.value)}</span>
            {hint ? <small>{hint}</small> : null}
          </span>
        );
      })}
      <span className="chart-thresholds__chip chart-thresholds__chip--source">
        <em>FONTE</em>
        <span>{thresholds.source ?? 'N/D'}</span>
      </span>
    </div>
  );
}

/** Seletor de escala do eixo Y: AUTO (default) ou LIMITES. */
export function OpticalScalePicker({
  mode,
  onChange,
}: {
  mode: OpticalScaleMode;
  onChange: (mode: OpticalScaleMode) => void;
}) {
  return (
    <div className="scale-picker" role="group" aria-label="Escala do eixo Y">
      <button
        type="button"
        className={mode === 'AUTO' ? 'is-active' : ''}
        aria-pressed={mode === 'AUTO'}
        title="Escala somente com os valores medidos"
        onClick={() => onChange('AUTO')}
      >
        AUTO
      </button>
      <button
        type="button"
        className={mode === 'LIMITS' ? 'is-active' : ''}
        aria-pressed={mode === 'LIMITS'}
        title="Escala incluindo os limites LOW e HIGH"
        onClick={() => onChange('LIMITS')}
      >
        LIMITES
      </button>
    </div>
  );
}

export interface OpticalHistoryViewProps {
  networkInterface: NetworkInterface;
  /** Pontos já carregados (o histórico nunca é recalculado ao trocar a escala). */
  points: OpticalHistoryPoint[];
  period: HistoryPeriod;
  scaleMode: OpticalScaleMode;
  onPeriodChange: (period: HistoryPeriod) => void;
  onScaleModeChange: (mode: OpticalScaleMode) => void;
}

/**
 * Parte APRESENTACIONAL do histórico óptico (sem query): período e escala são
 * estados do container, então alternar AUTO/LIMITES só re-renderiza o eixo.
 */
export function OpticalHistoryView({
  networkInterface,
  points,
  period,
  scaleMode,
  onPeriodChange,
  onScaleModeChange,
}: OpticalHistoryViewProps) {
  const laneIds = [...new Set([
    ...(networkInterface.opticalLanes ?? []).map((lane) => lane.lane),
    ...points.flatMap((point) => point.lanes.map((lane) => lane.lane)),
  ])].sort((left, right) => left - right);
  const rxLaneIds = laneIdsWithPower(points, laneIds, 'rx');
  const txLaneIds = laneIdsWithPower(points, laneIds, 'tx');
  const data = opticalChartData(points, laneIds, period);

  return (
    <section className="charts-section optical-history-section">
      <div className="chart-heading">
        <div>
          <span>HISTÓRICO ÓPTICO</span>
          <strong>Potência recebida e transmitida</strong>
        </div>
        <div className="chart-heading__actions">
          <div className="period-picker">
            {periods.map((item) => (
              <button
                key={item}
                type="button"
                className={period === item ? 'is-active' : ''}
                aria-pressed={period === item}
                onClick={() => onPeriodChange(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <OpticalScalePicker mode={scaleMode} onChange={onScaleModeChange} />
        </div>
      </div>

      {!data.length ? (
        <div className="chart-empty">Sem amostras ópticas no período</div>
      ) : (
        <div className="chart-pair chart-pair--optical">
          <OpticalPowerChart
            data={data}
            laneIds={rxLaneIds}
            direction="rx"
            thresholds={opticalThresholdRange(networkInterface, 'rx')}
            scaleMode={scaleMode}
          />
          <OpticalPowerChart
            data={data}
            laneIds={txLaneIds}
            direction="tx"
            thresholds={opticalThresholdRange(networkInterface, 'tx')}
            scaleMode={scaleMode}
          />
        </div>
      )}
    </section>
  );
}

export function OpticalHistoryCharts({
  networkInterface,
}: {
  networkInterface: NetworkInterface;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>('1h');
  const [scaleMode, setScaleMode] = useState<OpticalScaleMode>('AUTO');
  const history = useQuery({
    queryKey: ['optical-history', networkInterface.id, period],
    queryFn: () => getOpticalHistory(networkInterface.id, period),
  });

  return (
    <OpticalHistoryView
      networkInterface={networkInterface}
      points={history.data ?? []}
      period={period}
      scaleMode={scaleMode}
      onPeriodChange={setPeriod}
      onScaleModeChange={setScaleMode}
    />
  );
}

function OpticalPowerChart({
  data,
  laneIds,
  direction,
  thresholds,
  scaleMode,
}: {
  data: OpticalChartDatum[];
  laneIds: number[];
  direction: 'rx' | 'tx';
  thresholds: OpticalThresholdRange;
  scaleMode: OpticalScaleMode;
}) {
  const title = direction.toUpperCase();
  const series = opticalSeries(laneIds, direction);
  const values = data.flatMap((datum) =>
    series.map((item) => {
      const value = datum[item.dataKey];
      return typeof value === 'number' ? value : null;
    }));
  // AUTO: domínio SÓ dos dados (lanes com variação visível) e limite distante
  // vira chip direcional. LIMITES: domínio cobre dados + LOW + HIGH e as duas
  // linhas de referência aparecem na posição real, sem hint de janela.
  const scale = chartScale(scaleMode, values, thresholds);
  const sampleCount = data.filter((datum) => datum.source !== null).length;
  const dots = opticalDots(sampleCount);

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
      <OpticalThresholdChips thresholds={thresholds} scale={scale} />
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="#23303a" vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="label" tick={{ fill: '#6f8392', fontSize: 8 }} minTickGap={24} />
          <YAxis
            domain={scale.domain ?? ['auto', 'auto']}
            tick={{ fill: '#6f8392', fontSize: 8 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatAxisDbm}
          />
          <Tooltip content={(props) => (
            <OpticalHistoryTooltip
              active={props.active}
              payload={props.payload as unknown as ReadonlyArray<{ payload?: OpticalChartDatum }> | undefined}
              direction={direction}
              laneIds={laneIds}
            />
          )} />
          {scale.low?.visible && (
            <ReferenceLine
              y={scale.low.value}
              stroke="#e3a64b"
              strokeDasharray="3 3"
              strokeWidth={1}
              label={{
                value: `LOW ${formatAxisDbm(scale.low.value)}`,
                position: 'insideBottomRight',
                fill: '#e3a64b',
                fontSize: 8,
              }}
            />
          )}
          {scale.high?.visible && (
            <ReferenceLine
              y={scale.high.value}
              stroke="#d17a65"
              strokeDasharray="3 3"
              strokeWidth={1}
              label={{
                value: `HIGH ${formatAxisDbm(scale.high.value)}`,
                position: 'insideTopRight',
                fill: '#d17a65',
                fontSize: 8,
              }}
            />
          )}
          {series.map((item) => (
            <Line
              key={item.dataKey}
              type="stepAfter"
              dataKey={item.dataKey}
              name={item.name}
              stroke={item.stroke}
              strokeWidth={1.5}
              dot={dots ? { r: 3, fill: item.stroke, strokeWidth: 0 } : false}
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
