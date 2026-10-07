'use client';

import { useEffect } from 'react';
import {
  alarmResolutionReasonLabel,
  alarmSuppressionModeLabel,
  alarmSuppressionReasonLabel,
  formatAlarmDuration,
  operationalOccurrenceCloseReasonLabel,
  type AlertCenterItem,
} from '@gmj/shared';
import {
  alertAckText,
  alertCanAcknowledge,
  alertClock,
  alertSeverityLabel,
  alertSeverityTone,
  alertStateText,
  alertStateTone,
} from './alerts-format';

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function formatDbm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} dBm`;
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="alerts-drawer__row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/**
 * Detalhe do alerta aberto na propria workspace (sem sair da Central). Apresenta
 * os campos semanticamente: nada de JSON cru e nenhum dado sensivel.
 */
export function AlertDetailDrawer({
  item,
  nowMs,
  pending,
  error,
  onClose,
  onAcknowledge,
  onSuppress,
  onOpenInterface,
  onOpenMap,
}: {
  item: AlertCenterItem;
  nowMs: number;
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  onAcknowledge: (item: AlertCenterItem) => void;
  onSuppress: (item: AlertCenterItem) => void;
  onOpenInterface: (item: AlertCenterItem) => void;
  onOpenMap: (item: AlertCenterItem) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const alarm = item.alarm ?? null;
  const occurrence = item.occurrence ?? null;
  const optical = alarm?.optical ?? null;
  const duration = formatAlarmDuration(
    item.startedAt,
    item.endedAt ?? new Date(nowMs).toISOString(),
  );

  return (
    <aside className="alerts-drawer" aria-label="Detalhes do alerta">
      <header className="alerts-drawer__header">
        <div>
          <span className={`alerts-chip alerts-chip--${alertStateTone(item.state)}`}>
            {alertStateText(item.state)}
          </span>
          {item.severity ? (
            <span className={`alerts-chip alerts-chip--${alertSeverityTone(item.severity)}`}>
              {alertSeverityLabel(item.severity)}
            </span>
          ) : (
            <span className="alerts-chip alerts-chip--occurrence">OCORRÊNCIA</span>
          )}
          <strong>{item.typeLabel}</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar detalhes">
          ×
        </button>
      </header>

      <div className="alerts-drawer__body">
        <section>
          <h4>Origem</h4>
          <Row label="Equipamento" value={item.deviceName} />
          <Row label="Hostname" value={item.deviceHostname} />
          <Row label="Site" value={item.site} />
          <Row label="Interface" value={item.interfaceName} />
          <Row label="Alias" value={item.interfaceAlias} />
          <Row label="ifIndex" value={item.ifIndex === null ? null : String(item.ifIndex)} />
          <Row label="Lane" value={alarm?.optical?.lane != null ? String(alarm.optical.lane) : null} />
          <Row label="Direção" value={alarm?.direction ?? null} />
        </section>

        <section>
          <h4>Tempo</h4>
          <Row label="Primeiro evento" value={alertClock(item.startedAt)} />
          <Row label="Última atualização" value={alertClock(item.lastSeenAt)} />
          <Row label="Encerrado" value={item.endedAt ? alertClock(item.endedAt) : '—'} />
          <Row label="Duração" value={duration} />
          <Row label="Reconhecimento" value={alertAckText(item)} />
        </section>

        {alarm ? (
          <section>
            <h4>Alarme</h4>
            <Row label="Regra" value={alarm.ruleName ?? alarm.ruleId} />
            <Row label="Métrica" value={alarm.metricKey} />
            <Row label="Valor atual" value={formatNumber(alarm.currentValue)} />
            <Row label="Threshold" value={formatNumber(alarm.thresholdValue)} />
            <Row label="Unidade" value={alarm.unit} />
            <Row label="Mensagem" value={alarm.message} />
            <Row
              label="Motivo do encerramento"
              value={alarmResolutionReasonLabel(alarm.resolutionReason) ?? null}
            />
            {alarm.suppression ? (
              <>
                <Row
                  label="Supressão"
                  value={alarmSuppressionModeLabel(alarm.suppression.mode) ?? null}
                />
                <Row
                  label="Motivo da retirada"
                  value={alarmSuppressionReasonLabel(alarm.suppression.reason) ?? null}
                />
                <Row label="Nota" value={alarm.suppression.note} />
                <Row
                  label="Retirado por"
                  value={`${alarm.suppression.suppressedBy} ${alertClock(alarm.suppression.suppressedAt)}`}
                />
                <Row
                  label="Válido até"
                  value={alarm.suppression.expiresAt ? alertClock(alarm.suppression.expiresAt) : 'até normalizar'}
                />
              </>
            ) : null}
          </section>
        ) : null}

        {optical ? (
          <section>
            <h4>Óptico</h4>
            <Row label="RX atual" value={formatDbm(optical.rxPowerDbm)} />
            <Row label="Low Alarm" value={formatDbm(optical.rxLowAlarmDbm)} />
            <Row label="High Alarm" value={formatDbm(optical.rxHighAlarmDbm)} />
            <Row label="Margem" value={optical.marginDb == null ? null : `${formatNumber(optical.marginDb)} dB`} />
            <Row
              label="Proximidade"
              value={optical.proximityPercent == null ? null : `${formatNumber(optical.proximityPercent)}%`}
            />
            <Row
              label="Queda"
              value={
                optical.trendDropDb == null
                  ? null
                  : `${formatNumber(optical.trendDropDb)} dB em ${optical.trendWindowMinutes ?? 30} min`
              }
            />
            <Row
              label="Critérios"
              value={optical.triggerReasons.length ? optical.triggerReasons.join(', ') : null}
            />
            <Row label="Fonte do threshold" value={optical.thresholdSource} />
            <Row label="Fonte da potência" value={optical.currentPowerSource} />
          </section>
        ) : null}

        {occurrence ? (
          <section>
            <h4>Ocorrência</h4>
            <Row label="Tipo" value={item.typeLabel} />
            <Row label="Ocorrências" value={String(occurrence.occurrenceCount)} />
            <Row label="CRC acumulado" value={String(occurrence.crcDeltaTotal)} />
            <Row label="Discards RX" value={String(occurrence.rxDiscardDeltaTotal)} />
            <Row label="Discards TX" value={String(occurrence.txDiscardDeltaTotal)} />
            <Row label="Taxa atual" value={`${formatNumber(occurrence.currentRatePerMin)}/min`} />
            <Row label="Pico" value={`${formatNumber(occurrence.peakRatePerMin)}/min`} />
            <Row
              label="Encerramento"
              value={
                operationalOccurrenceCloseReasonLabel(occurrence.closeReason) ??
                (occurrence.closedAt ? 'encerrada' : null)
              }
            />
            <Row label="Mídia" value="N/A (ocorrência não gera mídia)" />
          </section>
        ) : null}

        {error ? (
          <p className="alerts-drawer__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="alerts-drawer__actions">
        {alertCanAcknowledge(item) ? (
          <button type="button" disabled={pending} onClick={() => onAcknowledge(item)}>
            RECONHECER
          </button>
        ) : null}
        {item.category === 'ALARM' && item.state === 'ACTIVE_UNACKNOWLEDGED' ? (
          <button type="button" disabled={pending} onClick={() => onSuppress(item)}>
            RETIRAR / SUPRIMIR
          </button>
        ) : null}
        {item.category === 'ALARM' && item.state === 'ACTIVE_ACKNOWLEDGED' ? (
          <button type="button" disabled={pending} onClick={() => onSuppress(item)}>
            RETIRAR / SUPRIMIR
          </button>
        ) : null}
        {item.interfaceId ? (
          <button type="button" onClick={() => onOpenInterface(item)}>
            ABRIR INTERFACE
          </button>
        ) : null}
        <button type="button" onClick={() => onOpenMap(item)}>
          ABRIR NO MAPA
        </button>
      </footer>
    </aside>
  );
}
