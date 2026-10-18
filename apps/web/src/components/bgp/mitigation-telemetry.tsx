'use client';
import type { MitigationTelemetryEntryDto, MitigationTelemetryReason } from '@gmj/shared';
import { formatDateTime } from '@/lib/mitigation-labels';
import { useEffect, useState } from 'react';
import styles from './mitigation-telemetry.module.css';

const labels: Record<MitigationTelemetryReason, string> = {
  DIRECTION_NOT_CONFIGURED: 'CONFIGURAÇÃO PENDENTE — SELECIONAR RX/TX',
  INTERFACE_NOT_LINKED: 'Interface não vinculada',
  INTERFACE_NOT_FOUND: 'Interface não encontrada',
  SAMPLE_NOT_FOUND: 'Sem amostra',
  SAMPLE_STALE: 'Amostra antiga',
  INVALID_SAMPLE: 'Amostra inválida',
  INTERFACE_ADMIN_DOWN: 'Interface administrativamente DOWN',
  INTERFACE_NOT_UP: 'Interface não está UP',
  COLLECTION_UNAVAILABLE: 'Fonte de dados indisponível',
};
export const telemetryReasonLabel = (reason: MitigationTelemetryReason) => labels[reason];
export function diagnosticRate(value: string | null) {
  if (value === null) return 'indisponível';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 'inválido';
  const unit = n >= 1e9 ? 'Gbps' : n >= 1e6 ? 'Mbps' : n >= 1e3 ? 'Kbps' : 'bps';
  const divisor = unit === 'Gbps' ? 1e9 : unit === 'Mbps' ? 1e6 : unit === 'Kbps' ? 1e3 : 1;
  return `${(n / divisor).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${unit}`;
}
export function MitigationTelemetryFacts({
  entry,
  generatedAt,
}: {
  entry?: MitigationTelemetryEntryDto | undefined;
  generatedAt?: string | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  if (!entry)
    return (
      <div className={styles.facts}>Diagnóstico indisponível — autorização não confirmada</div>
    );
  const age = entry.sampleAt ? Math.max(0, now - new Date(entry.sampleAt).getTime()) : null;
  const responseOld = !generatedAt || now - new Date(generatedAt).getTime() > 30_000;
  const measurementOld = age !== null && age > entry.maxAgeMs;
  return (
    <div className={styles.facts} data-testid={`telemetry-${entry.profileId}`}>
      <span>
        RX: {diagnosticRate(entry.rxBps)} · TX: {diagnosticRate(entry.txBps)}
      </span>
      <small>
        {entry.source} · {entry.adminStatus}/{entry.operStatus} · ifIndex {entry.ifIndex ?? '—'}
      </small>
      <time dateTime={entry.sampleAt ?? undefined}>{formatDateTime(entry.sampleAt)}</time>
      <small>
        Idade: {age === null ? '—' : `${Math.floor(age / 1000)} s`}
        {measurementOld ? ' · AMOSTRA ANTIGA' : ''}
      </small>
      <strong>
        {responseOld
          ? 'Diagnóstico desatualizado — atualizar'
          : entry.reasons.length
            ? entry.reasons.map(telemetryReasonLabel).join(' · ')
            : 'Telemetria disponível'}
      </strong>
      <small>
        {entry.mode} · Proteção automática:{' '}
        {entry.executionAuthorized && !responseOld && !measurementOld
          ? 'AUTORIZADA (sujeita ao preflight)'
          : 'NÃO AUTORIZADA'}
      </small>
    </div>
  );
}
