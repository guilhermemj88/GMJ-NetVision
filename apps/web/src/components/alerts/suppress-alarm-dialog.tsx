'use client';

import { useState } from 'react';
import {
  alarmSuppressionModeLabel,
  alarmSuppressionReasonLabel,
  type AlarmSuppressionMode,
  type AlarmSuppressionReason,
  type AlertCenterItem,
} from '@gmj/shared';
import type { SuppressAlarmPayload } from '@/lib/api';

const SUPPRESSION_REASONS: readonly AlarmSuppressionReason[] = [
  'INTENTIONAL_SHUTDOWN',
  'MAINTENANCE',
  'FALSE_POSITIVE',
  'OTHER',
];

/**
 * Retirada/supressao do alarme reutilizando EXATAMENTE a semantica da F9.1
 * (POST /api/alarms/:id/suppress). Nunca envia RESOLVED tecnico: a condicao
 * continua existindo, o operador assumiu a ocorrencia.
 */
export function SuppressAlarmDialog({
  item,
  pending = false,
  error,
  onCancel,
  onSubmit,
}: {
  item: AlertCenterItem;
  pending?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (payload: SuppressAlarmPayload) => void;
}) {
  const [mode, setMode] = useState<AlarmSuppressionMode>('UNTIL_CLEAR');
  const [reason, setReason] = useState<AlarmSuppressionReason>('INTENTIONAL_SHUTDOWN');
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');

  const untilMs = until ? new Date(until).getTime() : Number.NaN;
  const untilValid = Number.isFinite(untilMs) && untilMs > Date.now();
  const canSubmit = !pending && (mode === 'UNTIL_CLEAR' || untilValid);

  return (
    <div className="alerts-modal" role="dialog" aria-modal="true" aria-label="Retirar alarme">
      <form
        className="alerts-modal__card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            mode,
            reason,
            note: note.trim() ? note.trim() : null,
            expiresAt: mode === 'UNTIL_TIME' ? new Date(untilMs).toISOString() : null,
          });
        }}
      >
        <header>
          <strong>RETIRAR / SUPRIMIR ALARME</strong>
          <button type="button" onClick={onCancel} aria-label="Fechar">
            ×
          </button>
        </header>
        <p className="alerts-modal__target">
          <span>{item.deviceName}</span>
          <span>
            {item.interfaceLabel ?? item.interfaceName ?? '—'}
            {item.interfaceName && item.interfaceLabel ? ` — ${item.interfaceName}` : ''}
          </span>
          <span>{item.typeLabel}</span>
        </p>
        <label>
          MODO
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as AlarmSuppressionMode)}
          >
            <option value="UNTIL_CLEAR">{alarmSuppressionModeLabel('UNTIL_CLEAR')}</option>
            <option value="UNTIL_TIME">{alarmSuppressionModeLabel('UNTIL_TIME')}</option>
          </select>
        </label>
        <label>
          MOTIVO
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value as AlarmSuppressionReason)}
          >
            {SUPPRESSION_REASONS.map((value) => (
              <option key={value} value={value}>
                {alarmSuppressionReasonLabel(value)}
              </option>
            ))}
          </select>
        </label>
        {mode === 'UNTIL_TIME' ? (
          <label>
            ATÉ
            <input
              type="datetime-local"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              required
            />
          </label>
        ) : null}
        {mode === 'UNTIL_TIME' && until && !untilValid ? (
          <small className="alerts-modal__hint">Informe um horário futuro.</small>
        ) : null}
        <label>
          NOTA (opcional)
          <input
            type="text"
            value={note}
            maxLength={280}
            placeholder="ex.: porta desligada para manutenção do cliente"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {error ? (
          <p className="alerts-modal__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="alerts-modal__actions">
          <button type="submit" disabled={!canSubmit}>
            {pending ? 'SUPRIMINDO…' : 'SUPRIMIR'}
          </button>
          <button type="button" onClick={onCancel}>
            CANCELAR
          </button>
        </div>
      </form>
    </div>
  );
}
