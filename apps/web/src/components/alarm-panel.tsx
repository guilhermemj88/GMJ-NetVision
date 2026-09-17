'use client';

import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  alarmTypeLabel,
  formatAlarmDownSince,
  formatAlarmDuration,
  type Alarm,
  type AlarmPanelPosition,
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

export function AlarmPanel({
  alarms,
  resolvedAlarms = [],
  onFocus,
}: {
  alarms: Alarm[];
  resolvedAlarms?: Alarm[];
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
                <button
                  type="button"
                  className="alarm-panel__item"
                  onClick={() => onFocus(alarm)}
                  title="Focar no mapa"
                >
                  <span
                    className={`alarm-panel__severity alarm-panel__severity--${alarm.severity.toLowerCase()}`}
                  >
                    {severityLabels[alarm.severity]}
                  </span>
                  <span className="alarm-panel__item-body">
                    <strong>{alarmTypeLabel(alarm.type)}</strong>
                    <span className="alarm-panel__device">{alarm.deviceName}</span>
                    <span className="alarm-panel__interface">
                      {alarm.interfaceLabel} — {alarm.interfaceName}
                    </span>
                    <small>
                      Interface: {alarm.interfaceName} · Down desde{' '}
                      {formatAlarmDownSince(alarm.startedAt)}
                    </small>
                  </span>
                </button>
              </li>
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
                <button
                  type="button"
                  className="alarm-panel__resolved"
                  onClick={() => onFocus(alarm)}
                  title="Focar no mapa"
                >
                  <span className="alarm-panel__resolved-check" aria-hidden="true">
                    ✓
                  </span>
                  <span className="alarm-panel__resolved-body">
                    <strong>{alarm.deviceName}</strong>
                    <span className="alarm-panel__interface">
                      {alarm.interfaceLabel} — {alarm.interfaceName}
                    </span>
                    <small>
                      Resolvido às {formatAlarmDownSince(alarm.endedAt ?? '')} · Duração{' '}
                      {formatAlarmDuration(alarm.startedAt, alarm.endedAt ?? '')}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
