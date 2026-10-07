'use client';

import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  alarmTypeLabel,
  formatAlarmDownSince,
  formatAlarmDuration,
  type Alarm,
  type AlarmPanelPosition,
  type InterfaceOccurrence,
} from '@gmj/shared';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  ALARM_SCALE_OPTIONS,
  getAlarmScale,
  setAlarmScale,
  subscribeAlarmScale,
} from '@/lib/alarm-panel-preferences';

const POSITION_STORAGE_KEY = 'gmj:alarms:panel-position';

export type AlarmFocusTarget =
  | { kind: 'device'; deviceId: string }
  | { kind: 'link'; deviceId: string; linkId: string };

/**
 * Resolves what the map should focus when an alarm is clicked: the link that
 * owns the interface when there is one, otherwise the device node.
 */
export function alarmFocusTarget(alarm: Alarm): AlarmFocusTarget {
  return alarm.linkId
    ? { kind: 'link', deviceId: alarm.deviceId, linkId: alarm.linkId }
    : { kind: 'device', deviceId: alarm.deviceId };
}

/** Secao do drawer da interface aberta pelo clique no alarme. */
export type AlarmDrawerSection = 'OPTICAL' | 'METRICS' | null;

/**
 * Onde o operador precisa olhar depois de clicar no alarme: opticos abrem no
 * bloco/grafico optico; erros/CRC/discards abrem nas metricas da interface.
 */
export function alarmDrawerSection(alarm: Alarm): AlarmDrawerSection {
  if (alarm.type === 'OPTICAL_RX_DEGRADATION') return 'OPTICAL';
  if (
    alarm.type === 'INTERFACE_ERRORS'
    || alarm.type === 'INTERFACE_CRC'
    || alarm.type === 'INTERFACE_DISCARDS'
  ) {
    return 'METRICS';
  }
  return null;
}

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

const severityLabels: Record<Alarm['severity'], string> = {
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

const RESOLUTION_REASON_LABELS: Record<string, string> = {
  RULE_DISABLED: 'regra desativada',
  RULE_DELETED: 'regra excluída',
};

/**
 * Motivos legiveis do alarme ativo. O alarme e UNICO: quando proximidade e
 * queda valem juntos, os dois aparecem em vez de virar dois cards.
 */
export function alarmReasonText(alarm: Alarm): string | null {
  const metadata = alarm.metadata ?? null;
  const reasons = metadata?.triggerReasons ?? [];
  const parts: string[] = [];
  if (reasons.includes('PROXIMITY') && metadata?.proximityPercent != null) {
    parts.push(`${formatNumber(metadata.proximityPercent)}% do limite`);
  }
  if (reasons.includes('RAPID_DROP') && metadata?.trendDropDb != null) {
    parts.push(
      `↓ ${formatNumber(metadata.trendDropDb)} dB em ${metadata.trendWindowMinutes ?? 30} min`,
    );
  }
  return parts.length ? parts.join(' · ') : null;
}

function MetricAlarmBody({ alarm }: { alarm: Alarm }) {
  const metadata = alarm.metadata ?? null;
  const direction = metadata?.direction ?? (alarm.metricKey === 'FCS' ? 'RX' : null);
  const rate = metadata?.ratePerMinute ?? alarm.currentValue ?? null;
  const limit = metadata?.thresholdPerMinute ?? alarm.thresholdValue ?? null;
  const unit = alarm.type === 'INTERFACE_CRC'
    ? 'CRC'
    : alarm.type === 'INTERFACE_DISCARDS'
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
      {alarm.type === 'INTERFACE_CRC' && metadata?.delta ? (
        <span className="alarm-panel__limit">+{metadata.delta} no período</span>
      ) : null}
      <small>Ativo desde {formatClock(alarm.startedAt)}</small>
    </>
  );
}

function OpticalAlarmBody({ alarm }: { alarm: Alarm }) {
  const metadata = alarm.metadata ?? null;
  const reason = alarmReasonText(alarm);
  const low = metadata?.rxLowAlarmDbm ?? null;
  const margin = metadata?.marginDb ?? null;
  return (
    <>
      <span className="alarm-panel__scope">
        {alarm.interfaceName}
        {metadata?.lane == null ? '' : ` · Lane ${metadata.lane}`}
      </span>
      <span className="alarm-panel__optical">
        RX atual {formatDbm(metadata?.rxPowerDbm)} · LOW {formatDbm(low)}
      </span>
      {margin !== null ? (
        <span className="alarm-panel__optical">Margem {formatNumber(margin)} dB</span>
      ) : null}
      {reason ? <span className="alarm-panel__reason">{reason}</span> : null}
      <small>Ativo desde {formatClock(alarm.startedAt)}</small>
    </>
  );
}

function AlarmBody({ alarm }: { alarm: Alarm }) {
  if (alarm.type === 'INTERFACE_DOWN') {
    return <small>Down desde {formatClock(alarm.startedAt)}</small>;
  }
  if (alarm.type === 'OPTICAL_RX_DEGRADATION') return <OpticalAlarmBody alarm={alarm} />;
  return <MetricAlarmBody alarm={alarm} />;
}

function AlarmCard({ alarm, onFocus }: { alarm: Alarm; onFocus: (alarm: Alarm) => void }) {
  return (
    <button
      type="button"
      className="alarm-panel__item"
      onClick={() => onFocus(alarm)}
      title="Focar no mapa e abrir a interface"
    >
      <span className={`alarm-panel__severity alarm-panel__severity--${alarm.severity.toLowerCase()}`}>
        {severityLabels[alarm.severity]}
      </span>
      <span className="alarm-panel__item-body">
        <strong>{alarmTypeLabel(alarm.type)}</strong>
        <span className="alarm-panel__device">{alarm.deviceName}</span>
        {alarm.type === 'INTERFACE_DOWN' ? (
          <span className="alarm-panel__interface">
            {alarm.interfaceLabel} — {alarm.interfaceName}
          </span>
        ) : null}
        <AlarmBody alarm={alarm} />
      </span>
    </button>
  );
}

/** Card de resolvido: duracao, valores do encerramento e motivo ficam visiveis. */
function ResolvedCard({ alarm, onFocus }: { alarm: Alarm; onFocus: (alarm: Alarm) => void }) {
  const metadata = alarm.metadata ?? null;
  const resolutionReason = metadata?.resolutionReason
    ? RESOLUTION_REASON_LABELS[metadata.resolutionReason] ?? null
    : null;
  const drop = metadata?.trendDropDb ?? null;
  return (
    <button
      type="button"
      className="alarm-panel__resolved"
      onClick={() => onFocus(alarm)}
      title="Focar no mapa e abrir a interface"
    >
      <span className="alarm-panel__resolved-check" aria-hidden="true">
        ✓
      </span>
      <span className="alarm-panel__resolved-body">
        <strong>RESOLVIDO · {alarmTypeLabel(alarm.type)}</strong>
        <span className="alarm-panel__device">{alarm.deviceName}</span>
        <span className="alarm-panel__interface">
          {alarm.interfaceLabel} — {alarm.interfaceName}
          {metadata?.lane == null ? '' : ` · Lane ${metadata.lane}`}
        </span>
        {alarm.type === 'OPTICAL_RX_DEGRADATION' ? (
          <small>
            Último RX {formatDbm(metadata?.rxPowerDbm)} · LOW {formatDbm(metadata?.rxLowAlarmDbm)}
            {drop ? ` · Queda ${formatNumber(drop)} dB` : ''}
          </small>
        ) : null}
        <small>
          {resolutionReason ? `${resolutionReason} · ` : ''}
          Duração {formatAlarmDuration(alarm.startedAt, alarm.endedAt ?? '')} · Resolvido às{' '}
          {formatClock(alarm.endedAt ?? '')}
        </small>
      </span>
    </button>
  );
}

function OccurrenceCard({ occurrence }: { occurrence: InterfaceOccurrence }) {
  const counters = occurrence.kind === 'CRC'
    ? `+${occurrence.crcDelta} CRC`
    : `RX +${occurrence.rxDelta} · TX +${occurrence.txDelta}`;
  return (
    <li className="alarm-panel__occurrence">
      <strong>
        {occurrence.kind === 'CRC' ? 'CRC/FCS' : 'DISCARDS'} · {counters}
      </strong>
      <span className="alarm-panel__device">{occurrence.deviceName}</span>
      <span className="alarm-panel__interface">
        {occurrence.interfaceLabel} — {occurrence.interfaceName}
      </span>
      <small>
        Última ocorrência {formatClock(occurrence.lastOccurrenceAt)} ·{' '}
        {formatNumber(occurrence.ratePerMinute)}/min
      </small>
    </li>
  );
}

export function AlarmPanel({
  alarms,
  resolvedAlarms = [],
  occurrences = [],
  onFocus,
}: {
  alarms: Alarm[];
  resolvedAlarms?: Alarm[];
  occurrences?: InterfaceOccurrence[];
  onFocus: (alarm: Alarm) => void;
}) {
  const [position, setPosition] = useState<AlarmPanelPosition>(loadPosition);
  const alarmScale = useSyncExternalStore(subscribeAlarmScale, getAlarmScale, getAlarmScale);

  // The panel stays compact: at most the 3 most recently resolved alarms,
  // ordered by resolution time descending regardless of the source order.
  const recentResolved = useMemo(
    () =>
      [...resolvedAlarms]
        .filter((alarm) => alarm.endedAt)
        .sort(
          (a, b) =>
            new Date(b.endedAt as string).getTime() - new Date(a.endedAt as string).getTime(),
        )
        .slice(0, 3),
    [resolvedAlarms],
  );

  const counters = useMemo(() => {
    const result = { CRITICAL: 0, MAJOR: 0, WARNING: 0 };
    for (const alarm of alarms) {
      if (alarm.severity === 'CRITICAL') result.CRITICAL += 1;
      else if (alarm.severity === 'MAJOR') result.MAJOR += 1;
      else if (alarm.severity === 'WARNING') result.WARNING += 1;
    }
    return result;
  }, [alarms]);

  const recentOccurrences = useMemo(() => occurrences.slice(0, 6), [occurrences]);

  const updatePosition = (next: AlarmPanelPosition) => {
    setPosition(next);
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  };

  if (position === 'HIDDEN') {
    return (
      <button
        type="button"
        className={`alarm-panel__reveal ${alarms.length ? 'alarm-panel__reveal--active' : ''}`}
        onClick={() => updatePosition('LEFT')}
        title="Mostrar painel de alarmes"
        aria-label="Mostrar painel de alarmes"
      >
        ⚠ {alarms.length}
      </button>
    );
  }

  // Sem alarmes, resoluções nem ocorrências o painel não precisa ocupar área
  // nobre do canvas: vira uma faixa compacta, e a escala some junto.
  const isEmpty =
    alarms.length === 0 && recentResolved.length === 0 && recentOccurrences.length === 0;

  if (isEmpty) {
    return (
      <aside
        className={`alarm-panel alarm-panel--compact alarm-panel--${position.toLowerCase()}`}
        aria-label="Painel de alarmes"
      >
        <span className="alarm-panel__ok" aria-hidden="true">
          ✓
        </span>
        <strong>Sem alarmes ativos</strong>
        <button
          type="button"
          onClick={() => updatePosition('HIDDEN')}
          title="Ocultar painel de alarmes"
          aria-label="Ocultar painel de alarmes"
        >
          <X size={13} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={`alarm-panel alarm-panel--${position.toLowerCase()}`}
      aria-label="Painel de alarmes"
      style={{ '--alarm-scale': alarmScale / 100 } as CSSProperties}
    >
      <header className="alarm-panel__header">
        <strong>Alarmes</strong>
        <span className={`alarm-panel__count ${alarms.length ? 'alarm-panel__count--active' : ''}`}>
          {alarms.length}
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
            title="Ocultar painel de alarmes"
            aria-label="Ocultar painel de alarmes"
          >
            <X size={14} />
          </button>
        </span>
      </header>
      <div className="alarm-panel__counters" role="group" aria-label="Contadores por severidade">
        <span className="alarm-panel__counter alarm-panel__counter--critical">
          CRIT {counters.CRITICAL}
        </span>
        <span className="alarm-panel__counter alarm-panel__counter--major">
          MAJOR {counters.MAJOR}
        </span>
        <span className="alarm-panel__counter alarm-panel__counter--warning">
          WARN {counters.WARNING}
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
      {alarms.length === 0 ? (
        <p className="alarm-panel__empty">Sem alarmes ativos</p>
      ) : (
        <>
          <p className="alarm-panel__section alarm-panel__section--active">🔴 Ativos</p>
          <ul className="alarm-panel__list">
            {alarms.map((alarm) => (
              <li key={alarm.id}>
                <AlarmCard alarm={alarm} onFocus={onFocus} />
              </li>
            ))}
          </ul>
        </>
      )}
      {recentOccurrences.length > 0 && (
        <>
          <p className="alarm-panel__section alarm-panel__section--occurrences">
            ❗ Ocorrências recentes
          </p>
          <ul className="alarm-panel__list alarm-panel__list--occurrences">
            {recentOccurrences.map((occurrence) => (
              <OccurrenceCard
                key={`${occurrence.kind}-${occurrence.interfaceId}`}
                occurrence={occurrence}
              />
            ))}
          </ul>
        </>
      )}
      {recentResolved.length > 0 && (
        <>
          <p className="alarm-panel__section alarm-panel__section--resolved">
            ✓ Resolvidos recentemente
          </p>
          <ul className="alarm-panel__list alarm-panel__list--resolved">
            {recentResolved.map((alarm) => (
              <li key={alarm.id}>
                <ResolvedCard alarm={alarm} onFocus={onFocus} />
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
