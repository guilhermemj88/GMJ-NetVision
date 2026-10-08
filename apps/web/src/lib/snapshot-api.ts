import type { HistoryPeriod, MetricPoint, OpticalHistoryPoint } from '@gmj/shared';
import { request } from './api';

export interface SnapshotChartSeries {
  key: 'rxErrors' | 'txErrors' | 'rxDiscards' | 'txDiscards';
  label: string;
  tone: 'crc' | 'rx' | 'tx';
}

export interface SnapshotChartSpec {
  kind: 'METRIC' | 'OPTICAL';
  period: HistoryPeriod;
  header: {
    device: string;
    interfaceName: string;
    alias: string;
    type: string;
    severity: string;
    message: string | null;
    eventAt: string;
    resolvedAt: string | null;
  };
  metric: {
    series: SnapshotChartSeries[];
    unit: string;
    thresholdValue: number | null;
    thresholdLabel: string;
  } | null;
  optical: {
    lane: number | null;
    lowAlarmDbm: number | null;
    highAlarmDbm: number | null;
    lowWarningDbm: number | null;
    highWarningDbm: number | null;
  } | null;
}

export interface SnapshotChartPayload {
  spec: SnapshotChartSpec;
  points: Array<MetricPoint | OpticalHistoryPoint>;
}

/**
 * Dados da pagina de snapshot: rota publica protegida por token ASSINADO de
 * escopo minimo (uma interface, um periodo, janela curta). O token vem na URL
 * que SÓ o renderer interno navega.
 */
export function getSnapshotChart(token: string): Promise<SnapshotChartPayload> {
  return request<SnapshotChartPayload>(`/api/public/snapshot/${encodeURIComponent(token)}`);
}
