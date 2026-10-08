'use client';

import type {
  HistoryPeriod,
  MetricPoint,
  NetworkInterface,
  OpticalHistoryPoint,
  OpticalThresholdsV1,
} from '@gmj/shared';
import {
  COUNTER_RX_COLOR,
  MetricCounterChart,
  metricChartData,
  nearestChartLabel,
  nearestChartPoint,
} from './metric-charts';
import { OpticalHistoryView, opticalChartData } from './optical-history-charts';
import { SnapshotReadySignal } from './snapshot-ready';
import type { SnapshotChartPayload } from '@/lib/snapshot-api';

const TYPE_LABELS: Record<string, string> = {
  INTERFACE_DOWN: 'Interface DOWN',
  INTERFACE_CRC: 'CRC/FCS',
  INTERFACE_DISCARDS: 'Discards',
  INTERFACE_ERRORS: 'Erros de interface',
  OPTICAL_RX_DEGRADATION: 'Degradação óptica',
};

const PERIOD_LABELS: Record<HistoryPeriod, string> = {
  '15m': 'últimos 15 min',
  '1h': 'última 1 h',
  '6h': 'últimas 6 h',
  '24h': 'últimas 24 h',
  '7d': 'últimos 7 dias',
};

const TONE_COLORS: Record<'crc' | 'rx' | 'tx', string> = {
  crc: '#e3a64b',
  rx: COUNTER_RX_COLOR,
  tx: '#d16565',
};

/**
 * Pagina interna renderizada pelo Chromium do snapshot. Reutiliza os MESMOS
 * componentes de gráfico do NetVision (`MetricCounterChart` /
 * `OpticalHistoryView`), com período fixo, escala LIMITES (WARN + ALARM) e a
 * linha vertical do evento.
 */
export function SnapshotView({ data }: { data: SnapshotChartPayload }) {
  const { spec } = data;

  return (
    <main className="snapshot-canvas">
      <SnapshotReadySignal />
      <header className="snapshot-header">
        <div className="snapshot-header__brand">
          <strong>GMJ NetVision</strong>
          <span>Alarme de rede · gráfico do evento</span>
        </div>
        <div className="snapshot-header__event">
          <span className={`snapshot-severity snapshot-severity--${spec.header.severity.toLowerCase()}`}>
            {spec.header.severity}
          </span>
          <strong>{TYPE_LABELS[spec.header.type] ?? spec.header.type}</strong>
        </div>
        <dl className="snapshot-facts">
          <div>
            <dt>Equipamento</dt>
            <dd>{spec.header.device}</dd>
          </div>
          <div>
            <dt>Interface</dt>
            <dd>
              {spec.header.interfaceName}
              {spec.header.alias ? ` · ${spec.header.alias}` : ''}
            </dd>
          </div>
          <div>
            <dt>Janela</dt>
            <dd>{PERIOD_LABELS[spec.period]}</dd>
          </div>
          <div>
            <dt>Evento</dt>
            <dd>{formatTimestamp(spec.header.eventAt)}</dd>
          </div>
          {spec.header.resolvedAt ? (
            <div>
              <dt>Recuperação</dt>
              <dd className="snapshot-facts__recovery">
                {formatTimestamp(spec.header.resolvedAt)}
              </dd>
            </div>
          ) : null}
        </dl>
        {spec.header.message ? <p className="snapshot-message">{spec.header.message}</p> : null}
      </header>

      <section className="snapshot-chart">
        {spec.kind === 'OPTICAL' ? (
          <OpticalSnapshot spec={spec} points={data.points as OpticalHistoryPoint[]} />
        ) : (
          <MetricSnapshot spec={spec} points={data.points as MetricPoint[]} />
        )}
      </section>
    </main>
  );
}

function MetricSnapshot({
  spec,
  points,
}: {
  spec: SnapshotChartPayload['spec'];
  points: MetricPoint[];
}) {
  const metric = spec.metric;
  const chartData = metricChartData(points, spec.period);
  const markers = [
    { point: nearestChartPoint(chartData, spec.header.eventAt), title: 'ALARME', tone: 'ALARM' as const },
    ...(spec.header.resolvedAt
      ? [
          {
            point: nearestChartPoint(chartData, spec.header.resolvedAt),
            title: 'RECUPERAÇÃO',
            tone: 'RECOVERY' as const,
          },
        ]
      : []),
  ]
    .filter(
      (marker): marker is { point: { index: number; label: string }; title: string; tone: 'ALARM' | 'RECOVERY' } =>
        marker.point !== null,
    )
    .map((marker) => ({ ...marker.point, title: marker.title, tone: marker.tone }));

  return (
    <>
      <MetricCounterChart
        data={chartData}
        title={`${metric?.series.map((item) => item.label).join(' / ') ?? 'Série'} · ${metric?.unit ?? ''}`}
        series={(metric?.series ?? []).map((item) => ({ key: item.key, label: item.label, color: TONE_COLORS[item.tone] }))}
        markers={markers}
        thresholdValue={metric?.thresholdValue ?? null}
        thresholdLabel={metric?.thresholdLabel ?? null}
        height={300}
        showAxis
      />
      {!points.length ? <p className="snapshot-empty">Sem amostras na janela do alarme</p> : null}
    </>
  );
}

function OpticalSnapshot({
  spec,
  points,
}: {
  spec: SnapshotChartPayload['spec'];
  points: OpticalHistoryPoint[];
}) {
  const optical = spec.optical;
  const laneIds = [...new Set(points.flatMap((point) => point.lanes.map((lane) => lane.lane)))].sort(
    (left, right) => left - right,
  );
  const chartData = opticalChartData(points, laneIds, spec.period);
  const markers = [
    { label: nearestChartLabel(chartData, spec.header.eventAt), title: 'ALARME', tone: 'ALARM' as const },    ...(spec.header.resolvedAt
      ? [
          {
            label: nearestChartLabel(chartData, spec.header.resolvedAt),
            title: 'RECUPERAÇÃO',
            tone: 'RECOVERY' as const,
          },
        ]
      : []),
  ].filter((marker): marker is { label: string; title: string; tone: 'ALARM' | 'RECOVERY' } => Boolean(marker.label));

  return (
    <>
      <OpticalHistoryView
        networkInterface={snapshotNetworkInterface(spec, optical)}
        points={points}
        period={spec.period}
        scaleMode="LIMITS"
        onPeriodChange={() => undefined}
        onScaleModeChange={() => undefined}
        markers={markers}
      />
      {!points.length ? <p className="snapshot-empty">Sem amostras ópticas na janela do alarme</p> : null}
    </>
  );
}

/**
 * NetworkInterface sintetica: a pagina de snapshot NAO consulta o cadastro —
 * recebe os limites que o próprio alarme usou (assinados no token) para o
 * desenho nunca divergir do que o motor comparou.
 */
export function snapshotNetworkInterface(
  spec: SnapshotChartPayload['spec'],
  optical: SnapshotChartPayload['spec']['optical'],
): NetworkInterface {
  const side = (low: number | null, high: number | null): OpticalThresholdsV1['scalar']['rx'] => ({
    lowAlarmDbm: low,
    highAlarmDbm: high,
    lowSource: low === null ? null : 'DEVICE',
    highSource: high === null ? null : 'DEVICE',
  });
  const rx = {
    ...side(optical?.lowAlarmDbm ?? null, optical?.highAlarmDbm ?? null),
    lowWarningDbm: optical?.lowWarningDbm ?? null,
    highWarningDbm: optical?.highWarningDbm ?? null,
  };
  const tx = side(null, null);
  return {
    id: '',
    deviceId: '',
    name: spec.header.interfaceName,
    alias: spec.header.alias,
    description: '',
    ifIndex: 0,
    mac: '',
    mtu: 0,
    speedBps: 0,
    adminStatus: 'UP',
    operStatus: 'UP',
    rxBps: 0,
    txBps: 0,
    rxUtilization: 0,
    txUtilization: 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    dataSources: ['SNMP'],
    telemetryUpdatedAt: null,
    opticalLanes: [],
    opticalLaneSource: null,
    opticalLanesUpdatedAt: null,
    opticalSource: null,
    opticalUpdatedAt: null,
    opticalThresholds: { version: 1, scalar: { rx, tx }, lanes: [] },
    opticalThresholdSource: 'DEVICE',
  } as NetworkInterface;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
