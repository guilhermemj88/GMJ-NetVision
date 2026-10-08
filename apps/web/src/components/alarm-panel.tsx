'use client';

import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  alertCenterAttentionCount,
  formatAlarmDownSince,
  formatAlarmDuration,
  type AlarmPanelPosition,
  type AlarmSeverity,
  type AlertCenterItem,
  type AlertCenterListQuery,
} from '@gmj/shared';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  ALARM_SCALE_OPTIONS,
  getAlarmScale,
  setAlarmScale,
  subscribeAlarmScale,
} from '@/lib/alarm-panel-preferences';
import type { SuppressAlarmPayload } from '@/lib/api';
import {
  useAcknowledgeAlertItem,
  useAlertCenterList,
  useAlertCenterSummary,
  useSuppressAlertItem,
} from '@/lib/use-alert-center';
import { useMapStore } from '@/store/map-store';
import { AlertDetailDrawer } from './alerts/alert-detail-drawer';
import { openAlertInterface, openAlertOnMap } from './alerts/alert-navigation';
import { SuppressAlarmDialog } from './alerts/suppress-alarm-dialog';
import {
  ALARM_PANEL_VISIBLE_ALARMS,
  ALARM_PANEL_VISIBLE_OCCURRENCES,
  ALARM_PANEL_VISIBLE_RESOLVED,
  alertLastSeenText,
  comparePanelAlarms,
  mergeRecentResolved,
  occurrenceCountersText,
  panelOccurrenceVisible,
  resolvedReasonText,
} from './alerts/alerts-format';

const POSITION_STORAGE_KEY = 'gmj:alarms:panel-position';

/**
 * Painel compacto do mapa (F9.4): visao resumida da MESMA Central de Alertas
 * (/api/alert-center). Ele nao recalcula ocorrencias nem monta a visao pelas
 * rotas antigas de alarme: cada secao e uma janela pequena do read-model da
 * F9.3, e o resumo operacional vem do cache compartilhado com a TopBar e a
 * propria Central (mesma familia de query keys).
 */
const ACTIVE_QUERY: AlertCenterListQuery = {
  state: 'ACTIVE',
  category: 'ALARM',
  // Varredura maior que o corte visual: a ordem final e por severidade.
  limit: 25,
};
const OCCURRENCE_QUERY: AlertCenterListQuery = {
  state: 'UNACKNOWLEDGED',
  category: 'OCCURRENCE',
  limit: ALARM_PANEL_VISIBLE_OCCURRENCES,
};
const RESOLVED_QUERY: AlertCenterListQuery = {
  state: 'RESOLVED',
  category: 'ALARM',
  period: '24h',
  limit: ALARM_PANEL_VISIBLE_RESOLVED,
};
const SUPPRESSED_QUERY: AlertCenterListQuery = {
  state: 'SUPPRESSED',
  category: 'ALARM',
  period: '24h',
  limit: ALARM_PANEL_VISIBLE_RESOLVED,
};

/** Lista vazia ESTAVEL: identidade nova a cada render realimentaria os memos. */
const EMPTY_ITEMS: readonly AlertCenterItem[] = Object.freeze([]);

function loadPosition(): AlarmPanelPosition {
  if (typeof window === 'undefined') return 'LEFT';
  try {
    const stored = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (stored === 'LEFT' || stored === 'RIGHT' || stored === 'HIDDEN') return stored;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 'LEFT';
}

const severityLabels: Record<AlarmSeverity, string> = {
  CRITICAL: 'CRIT',
  MAJOR: 'MAJOR',
  WARNING: 'WARN',
  INFO: 'INFO',
};

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDbm(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/D';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} dBm`;
}

function formatClock(value: string): string {
  return formatAlarmDownSince(value);
}

function MetricAlarmBody({ item }: { item: AlertCenterItem }) {
  const alarm = item.alarm ?? null;
  const direction = alarm?.direction ?? (alarm?.metricKey === 'FCS' ? 'RX' : null);
  const rate = alarm?.ratePerMinute ?? alarm?.currentValue ?? null;
  const limit = alarm?.thresholdPerMinute ?? alarm?.thresholdValue ?? null;
  const unit = item.type === 'INTERFACE_CRC'
    ? 'CRC'
    : item.type === 'INTERFACE_DISCARDS'
      ? 'discards'
      : 'erros';
  return (
    <>
      <span className="alarm-panel__rate">
        {direction ? `${direction} ` : ''}
        {formatNumber(rate)} {unit}/min
      </span>
      <span className="alarm-panel__limit">
        {limit !== null && limit <= 0 ? 'QUALQUER OCORRÊNCIA' : `Limite ${formatNumber(limit)}/min`}
      </span>
      {alarm?.delta ? (
        <span className="alarm-panel__limit">+{alarm.delta} no período</span>
      ) : null}
      <small>Ativo desde {formatClock(item.startedAt)}</small>
    </>
  );
}

/**
 * Optico multi-lane: os motivos vem de `triggerReasons`, entao proximidade e
 * queda rapida aparecem JUNTOS quando os dois sustentam o mesmo alarme.
 */
function OpticalAlarmBody({ item }: { item: AlertCenterItem }) {
  const optical = item.alarm?.optical ?? null;
  const reasons = optical?.triggerReasons ?? [];
  const details: string[] = [];
  if (reasons.includes('PROXIMITY') && optical?.proximityPercent != null) {
    details.push(`Proximidade ${formatNumber(optical.proximityPercent)}%`);
  }
  if (reasons.includes('RAPID_DROP') && optical?.trendDropDb != null) {
    details.push(
      `Queda ↓ ${formatNumber(optical.trendDropDb)} dB / ${optical.trendWindowMinutes ?? 30} min`,
    );
  }
  return (
    <>
      <span className="alarm-panel__scope">
        {item.interfaceLabel ?? item.interfaceName}
        {optical?.lane == null ? '' : ` · Lane ${optical.lane}`}
      </span>
      <span className="alarm-panel__optical">
        RX atual {formatDbm(optical?.rxPowerDbm)} · LOW {formatDbm(optical?.rxLowAlarmDbm)}
      </span>
      {optical?.rxHighAlarmDbm != null ? (
        <span className="alarm-panel__optical">HIGH {formatDbm(optical.rxHighAlarmDbm)}</span>
      ) : null}
      {optical?.marginDb != null ? (
        <span className="alarm-panel__optical">Margem {formatNumber(optical.marginDb)} dB</span>
      ) : null}
      {details.length ? <span className="alarm-panel__reason">{details.join(' · ')}</span> : null}
      <small>Ativo desde {formatClock(item.startedAt)}</small>
    </>
  );
}

function AlarmBody({ item }: { item: AlertCenterItem }) {
  if (item.type === 'INTERFACE_DOWN') {
    return (
      <>
        <span className="alarm-panel__interface">
          {item.interfaceLabel && item.interfaceLabel !== item.interfaceName
            ? `${item.interfaceLabel} — ${item.interfaceName}`
            : (item.interfaceName ?? item.interfaceLabel ?? '—')}
        </span>
        <small>Down desde {formatClock(item.startedAt)}</small>
      </>
    );
  }
  if (item.type === 'OPTICAL_RX_DEGRADATION') return <OpticalAlarmBody item={item} />;
  return <MetricAlarmBody item={item} />;
}

function AlarmCard({
  item,
  pending,
  onDetail,
  onAcknowledge,
  onRequestSuppress,
}: {
  item: AlertCenterItem;
  pending: boolean;
  onDetail: (item: AlertCenterItem) => void;
  onAcknowledge: (item: AlertCenterItem) => void;
  onRequestSuppress: (item: AlertCenterItem) => void;
}) {
  const acknowledged = Boolean(item.acknowledgedAt);
  const severity = item.severity ?? 'INFO';
  return (
    <div className={`alarm-panel__row ${acknowledged ? 'alarm-panel__row--ack' : ''}`}>
      <button
        type="button"
        className="alarm-panel__item"
        onClick={() => onDetail(item)}
        title="Abrir detalhes do alerta"
      >
        <span className={`alarm-panel__severity alarm-panel__severity--${severity.toLowerCase()}`}>
          {severityLabels[severity]}
        </span>
        <span className="alarm-panel__item-body">
          <strong>{item.typeLabel}</strong>
          <span className="alarm-panel__device">{item.deviceName}</span>
          <AlarmBody item={item} />
          {acknowledged ? (
            <span className="alarm-panel__ack">
              ✓ RECONHECIDO por {item.acknowledgedBy ?? 'operador'} às{' '}
              {formatClock(item.acknowledgedAt as string)}
            </span>
          ) : null}
        </span>
      </button>
      <div className="alarm-panel__row-actions">
        {acknowledged ? null : (
          <button
            type="button"
            disabled={pending}
            onClick={() => onAcknowledge(item)}
            title="Reconhecer sem resolver"
          >
            Reconhecer
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => onRequestSuppress(item)}
          title="Retirar / suprimir enquanto a condição durar"
        >
          Retirar
        </button>
      </div>
    </div>
  );
}

/** Episodio de CRC/FCS ou de descartes: RX e TX do MESMO card. */
function OccurrenceCard({
  item,
  nowMs,
  pending,
  onDetail,
  onAcknowledge,
}: {
  item: AlertCenterItem;
  nowMs: number;
  pending: boolean;
  onDetail: (item: AlertCenterItem) => void;
  onAcknowledge: (item: AlertCenterItem) => void;
}) {
  const occurrence = item.occurrence ?? null;
  const count = occurrence?.occurrenceCount ?? 0;
  return (
    <div className="alarm-panel__row">
      <button
        type="button"
        className="alarm-panel__item alarm-panel__item--occurrence"
        onClick={() => onDetail(item)}
        title="Abrir detalhes da ocorrência"
      >
        <span className="alarm-panel__severity alarm-panel__severity--occurrence">OCORRÊNCIA</span>
        <span className="alarm-panel__item-body">
          <strong className="alarm-panel__occurrence-type">{item.typeLabel}</strong>
          <span className="alarm-panel__device">{item.deviceName}</span>
          <span className="alarm-panel__interface">
            {item.interfaceLabel ?? item.interfaceName ?? '—'}
          </span>
          <span className="alarm-panel__rate">{occurrenceCountersText(item)}</span>
          <span className="alarm-panel__limit">
            {count} {count === 1 ? 'ocorrência' : 'ocorrências'}
          </span>
          <span className="alarm-panel__limit">
            Atual {formatNumber(occurrence?.currentRatePerMin)}/min
          </span>
          <span className="alarm-panel__limit">
            Pico {formatNumber(occurrence?.peakRatePerMin)}/min
          </span>
          <small>{alertLastSeenText(item.lastSeenAt, nowMs)}</small>
        </span>
      </button>
      <div className="alarm-panel__row-actions">
        <button type="button" disabled={pending} onClick={() => onAcknowledge(item)}>
          Reconhecer
        </button>
      </div>
    </div>
  );
}

/**
 * Resolvido recente: duracao e horario sempre; o motivo administrativo
 * (regra desativada, manutencao, retirada) nunca e confundido com recuperacao
 * tecnica.
 */
function ResolvedCard({
  item,
  onDetail,
}: {
  item: AlertCenterItem;
  onDetail: (item: AlertCenterItem) => void;
}) {
  const suppressed = item.state === 'SUPPRESSED';
  return (
    <div className="alarm-panel__row">
      <button
        type="button"
        className="alarm-panel__resolved"
        onClick={() => onDetail(item)}
        title="Abrir detalhes do alerta"
      >
        <span className="alarm-panel__resolved-check">✓</span>
        <span className="alarm-panel__resolved-body">
          <strong>
            {suppressed ? 'SUPRIMIDO' : 'RESOLVIDO'} · {item.typeLabel}
          </strong>
          <span className="alarm-panel__device">{item.deviceName}</span>
          <span className="alarm-panel__interface">
            {item.interfaceLabel ?? item.interfaceName ?? '—'}
          </span>
          <small>{resolvedReasonText(item)}</small>
          <small>
            Duração {formatAlarmDuration(item.startedAt, item.endedAt ?? '')} · Resolvido às{' '}
            {formatClock(item.endedAt ?? '')}
          </small>
        </span>
      </button>
    </div>
  );
}

export function AlarmPanel() {
  const [position, setPosition] = useState<AlarmPanelPosition>(loadPosition);
  const [detail, setDetail] = useState<AlertCenterItem | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [suppressTarget, setSuppressTarget] = useState<AlertCenterItem | null>(null);
  const [suppressError, setSuppressError] = useState<string | null>(null);
  const alarmScale = useSyncExternalStore(subscribeAlarmScale, getAlarmScale, getAlarmScale);

  const active = useAlertCenterList(ACTIVE_QUERY);
  const occurrences = useAlertCenterList(OCCURRENCE_QUERY);
  const resolved = useAlertCenterList(RESOLVED_QUERY);
  const suppressed = useAlertCenterList(SUPPRESSED_QUERY);
  const summary = useAlertCenterSummary();
  const acknowledge = useAcknowledgeAlertItem();
  const suppress = useSuppressAlertItem();

  // Relogio da leitura: a idade das ocorrencias acompanha o que foi recebido.
  const nowMs = active.data ? new Date(active.data.generatedAt).getTime() : Date.now();
  const activeItems = active.data?.items ?? EMPTY_ITEMS;

  const alarms = useMemo(
    () => [...activeItems].sort(comparePanelAlarms).slice(0, ALARM_PANEL_VISIBLE_ALARMS),
    [activeItems],
  );
  const occurrenceItems = occurrences.data?.items ?? EMPTY_ITEMS;
  const visibleOccurrences = useMemo(
    () =>
      occurrenceItems
        .filter((item) => panelOccurrenceVisible(item, nowMs))
        .slice(0, ALARM_PANEL_VISIBLE_OCCURRENCES),
    [occurrenceItems, nowMs],
  );
  const resolvedItems = resolved.data?.items ?? EMPTY_ITEMS;
  const suppressedItems = suppressed.data?.items ?? EMPTY_ITEMS;
  const recentResolved = useMemo(
    () => mergeRecentResolved(resolvedItems, suppressedItems, ALARM_PANEL_VISIBLE_RESOLVED),
    [resolvedItems, suppressedItems],
  );

  const alarmsTotal = active.data?.total ?? 0;
  const occurrencesTotal = occurrences.data?.total ?? 0;
  const hiddenAlarms = Math.max(alarmsTotal - alarms.length, 0);
  const hiddenOccurrences = Math.max(occurrencesTotal - visibleOccurrences.length, 0);
  const attention = alertCenterAttentionCount(summary);

  const loading = active.isPending && !active.data;
  // Falha da leitura principal derruba o corpo para o aviso com retry, igual a
  // Central: o mapa continua utilizavel e nada de stack trace na tela.
  const failed = active.isError || occurrences.isError;
  const isEmpty =
    !loading
    && !failed
    && alarmsTotal === 0
    && occurrencesTotal === 0
    && recentResolved.length === 0;

  const updatePosition = (next: AlarmPanelPosition) => {
    setPosition(next);
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  };

  const retry = () => {
    void active.refetch();
    void occurrences.refetch();
    void resolved.refetch();
    void suppressed.refetch();
  };

  const openAlertCenter = () => {
    useMapStore.getState().setView('ALERTS');
  };

  const openDetail = (item: AlertCenterItem) => {
    setDetailError(null);
    setDetail(item);
  };

  const acknowledgeItem = async (item: AlertCenterItem) => {
    setDetailError(null);
    try {
      await acknowledge.mutateAsync(item);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'falha ao reconhecer');
    }
  };

  const requestSuppression = (item: AlertCenterItem) => {
    setSuppressError(null);
    setSuppressTarget(item);
  };

  const submitSuppression = async (item: AlertCenterItem, payload: SuppressAlarmPayload) => {
    setSuppressError(null);
    try {
      await suppress.mutateAsync({ item, payload });
      setSuppressTarget(null);
      setDetail(null);
    } catch (error) {
      setSuppressError(error instanceof Error ? error.message : 'falha ao retirar o alarme');
    }
  };

  /** Navegacao compartilhada com a Central; sem destino, avisa sem quebrar. */
  const goToInterface = (item: AlertCenterItem) => {
    const message = openAlertInterface(item);
    if (message) useMapStore.getState().showToast(message);
    setDetail(null);
  };

  const goToMap = (item: AlertCenterItem) => {
    const message = openAlertOnMap(item);
    if (message) useMapStore.getState().showToast(message);
    setDetail(null);
  };

  const detailDrawer = detail ? (
    <AlertDetailDrawer
      item={detail}
      nowMs={nowMs}
      pending={acknowledge.isPending}
      error={detailError}
      onClose={() => setDetail(null)}
      onAcknowledge={(item) => void acknowledgeItem(item)}
      onSuppress={requestSuppression}
      onOpenInterface={goToInterface}
      onOpenMap={goToMap}
    />
  ) : null;
  const suppressDialog = suppressTarget ? (
    <SuppressAlarmDialog
      item={suppressTarget}
      pending={suppress.isPending}
      error={suppressError}
      onCancel={() => setSuppressTarget(null)}
      onSubmit={(payload) => void submitSuppression(suppressTarget, payload)}
    />
  ) : null;

  if (position === 'HIDDEN') {
    return (
      <>
        <button
          type="button"
          className={`alarm-panel__reveal ${attention ? 'alarm-panel__reveal--active' : ''}`}
          onClick={() => updatePosition('LEFT')}
          title="Mostrar painel de alertas"
          aria-label="Mostrar painel de alertas"
        >
          ⚠ {attention}
        </button>
        {detailDrawer}
        {suppressDialog}
      </>
    );
  }

  // Nada exigindo acao: faixa compacta em vez de uma caixa grande no canvas.
  if (isEmpty) {
    return (
      <>
        <aside
          className={`alarm-panel alarm-panel--compact alarm-panel--${position.toLowerCase()}`}
          aria-label="Painel de alertas"
        >
          <span className="alarm-panel__ok" aria-hidden="true">
            ✓
          </span>
          <strong>Alarmes</strong>
          <span className="alarm-panel__compact-text">Nenhum alerta exigindo atenção.</span>
          <button type="button" className="alarm-panel__compact-link" onClick={openAlertCenter}>
            Ver Central
          </button>
          <button
            type="button"
            onClick={() => updatePosition('HIDDEN')}
            title="Ocultar painel de alertas"
            aria-label="Ocultar painel de alertas"
          >
            <X size={13} />
          </button>
        </aside>
        {detailDrawer}
        {suppressDialog}
      </>
    );
  }

  return (
    <>
      <aside
        className={`alarm-panel alarm-panel--${position.toLowerCase()}`}
        aria-label="Painel de alertas"
        style={{ '--alarm-scale': alarmScale / 100 } as CSSProperties}
      >
        <header className="alarm-panel__header">
          <strong>Alarmes</strong>
          <span
            className={`alarm-panel__count ${
              summary.alarmsActive ? 'alarm-panel__count--active' : ''
            }`}
            title="Alarmes ativos"
          >
            {summary.alarmsActive}
          </span>
          <span className="alarm-panel__actions">
            <button
              type="button"
              onClick={() => updatePosition(position === 'RIGHT' ? 'LEFT' : 'RIGHT')}
              title={position === 'RIGHT' ? 'Mover para a esquerda' : 'Mover para a direita'}
              aria-label={position === 'RIGHT' ? 'Mover para a esquerda' : 'Mover para a direita'}
            >
              {position === 'RIGHT' ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
            <button
              type="button"
              onClick={() => updatePosition('HIDDEN')}
              title="Ocultar painel de alertas"
              aria-label="Ocultar painel de alertas"
            >
              <X size={14} />
            </button>
          </span>
        </header>
        <div className="alarm-panel__counters" role="group" aria-label="Contadores por severidade">
          <span
            className="alarm-panel__counter alarm-panel__counter--critical"
            title="Alarmes ativos críticos"
          >
            CRIT {summary.alarmsActiveCritical}
          </span>
          <span
            className="alarm-panel__counter alarm-panel__counter--major"
            title="Alarmes ativos major"
          >
            MAJOR {summary.alarmsActiveMajor}
          </span>
          <span
            className="alarm-panel__counter alarm-panel__counter--warning"
            title="Alarmes ativos warning"
          >
            WARN {summary.alarmsActiveWarning}
          </span>
          <span
            className="alarm-panel__counter alarm-panel__counter--event"
            title="Ocorrências não reconhecidas e vigentes (sem severidade de regra)"
          >
            EVENTOS {summary.occurrencesUnacknowledged}
          </span>
        </div>
        <div className="alarm-panel__scale" role="group" aria-label="Tamanho do painel de alarmes">
          {ALARM_SCALE_OPTIONS.map(({ value, label }) => (
            <button
              type="button"
              key={value}
              className={alarmScale === value ? 'is-active' : ''}
              aria-pressed={alarmScale === value}
              title={`Tamanho ${label.toLowerCase()}`}
              onClick={() => setAlarmScale(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="alarm-panel__body">
          {failed ? (
            <div className="alarm-panel__error" role="alert">
              <span>Não foi possível carregar alertas.</span>
              <button type="button" onClick={retry}>
                Tentar novamente
              </button>
            </div>
          ) : loading ? (
            <p className="alarm-panel__loading">Carregando alertas…</p>
          ) : (
            <>
              {alarms.length ? (
                <>
                  <p className="alarm-panel__section alarm-panel__section--active">
                    🔴 Ativos{hiddenAlarms ? ` · +${hiddenAlarms}` : ''}
                  </p>
                  <ul className="alarm-panel__list">
                    {alarms.map((item) => (
                      <li key={item.id}>
                        <AlarmCard
                          item={item}
                          pending={acknowledge.isPending || suppress.isPending}
                          onDetail={openDetail}
                          onAcknowledge={(alarm) => void acknowledgeItem(alarm)}
                          onRequestSuppress={requestSuppression}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="alarm-panel__empty">Sem alarmes ativos</p>
              )}
              {visibleOccurrences.length ? (
                <>
                  <p className="alarm-panel__section alarm-panel__section--occurrences">
                    ❗ Ocorrências não reconhecidas
                    {hiddenOccurrences ? ` · +${hiddenOccurrences}` : ''}
                  </p>
                  <ul className="alarm-panel__list alarm-panel__list--occurrences">
                    {visibleOccurrences.map((item) => (
                      <li key={item.id}>
                        <OccurrenceCard
                          item={item}
                          nowMs={nowMs}
                          pending={acknowledge.isPending}
                          onDetail={openDetail}
                          onAcknowledge={(occurrence) => void acknowledgeItem(occurrence)}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {recentResolved.length ? (
                <>
                  <p className="alarm-panel__section alarm-panel__section--resolved">
                    ✓ Resolvidos recentemente
                  </p>
                  <ul className="alarm-panel__list alarm-panel__list--resolved">
                    {recentResolved.map((item) => (
                      <li key={item.id}>
                        <ResolvedCard item={item} onDetail={openDetail} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
        </div>
        <footer className="alarm-panel__footer">
          <button type="button" className="alarm-panel__all" onClick={openAlertCenter}>
            VER TODOS OS ALERTAS
          </button>
        </footer>
      </aside>
      {detailDrawer}
      {suppressDialog}
    </>
  );
}
