'use client';
import { useEffect, useState } from 'react';
import type { MitigationFastBridgeStatusDto } from '@gmj/shared';
import { diagnosticRate } from './mitigation-telemetry';
import { formatDateTime } from '@/lib/mitigation-labels';
import styles from './mitigation-telemetry.module.css';

export function MitigationFastBridgeFacts({
  profileId,
  report,
}: {
  profileId: string;
  report: MitigationFastBridgeStatusDto | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!report || report.mode === 'OFF' || !report.profileIds.includes(profileId)) return null;
  const sample = report.samples.find((s) => s.profileId === profileId),
    decision = report.decisions.find((d) => d.profileId === profileId);
  const enforce = report.mode === 'ENFORCE' && report.enforceProfileIds.includes(profileId);
  const stale =
    now - new Date(report.generatedAt).getTime() > 10_000 ||
    !sample?.sampleAt ||
    now - new Date(sample.sampleAt).getTime() > 30_000;
  const mitigated =
    decision?.outcome === 'ACTIVATED' ||
    ['MITIGATED', 'MITIGATING', 'RECOVERY_PENDING'].includes(decision?.runtimeState ?? '');
  const phase =
    stale || !sample?.available
      ? 'UNAVAILABLE'
      : mitigated
        ? 'MITIGATED'
        : (decision?.samplesOver ?? 0) >= (decision?.requiredSamples ?? 3)
          ? 'CONFIRMED'
          : (decision?.samplesOver ?? 0) > 0
            ? 'SUSPECTED'
            : 'NORMAL';
  const deadline =
    !mitigated &&
    decision?.firstAbnormalAt &&
    decision.outcome !== 'ACTIVATED' &&
    now - new Date(decision.firstAbnormalAt).getTime() > report.responseBudgetMs;
  return (
    <div className={styles.facts} aria-label="Pipeline prioritário">
      <strong>
        Fonte da avaliação: FAST · {enforce ? 'ENFORCE' : 'SHADOW'} · {phase}
      </strong>
      <span>
        RX {diagnosticRate(sample?.rxBps ?? null)} · TX {diagnosticRate(sample?.txBps ?? null)}
      </span>
      <time dateTime={sample?.sampleAt ?? undefined}>{formatDateTime(sample?.sampleAt)}</time>
      <small>
        Idade{' '}
        {sample?.sampleAt
          ? Math.max(0, Math.floor((now - new Date(sample.sampleAt).getTime()) / 1000)) + ' s'
          : '—'}{' '}
        · intervalo{' '}
        {sample?.intervalMs == null ? '—' : (sample.intervalMs / 1000).toFixed(3) + ' s'}
      </small>
      <span>
        Confirmações {decision?.samplesOver ?? 0}/{decision?.requiredSamples ?? 3} · limiar{' '}
        {diagnosticRate(decision?.thresholdBps ?? null)}
      </span>
      <span>
        {decision?.outcome ?? 'Sem decisão'}
        {decision?.reason ? ' · ' + decision.reason : ''}
      </span>
      {!enforce && <strong>SHADOW: nenhuma execução Huawei disponível</strong>}
      {(stale || sample?.reason) && (
        <strong>{stale ? 'AMOSTRA OU DIAGNÓSTICO ANTIGO' : sample?.reason}</strong>
      )}
      <small>
        Execução: {decision?.commandStatus ?? 'não executada'} · readback:{' '}
        {decision?.verified ? 'CONFIRMADO' : 'NÃO CONFIRMADO'}
      </small>
      <small>
        Total:{' '}
        {decision?.totalResponseMs == null
          ? 'não medido'
          : (decision.totalResponseMs / 1000).toFixed(3) + ' s'}
      </small>
      <small>
        Decisão: {decision?.decisionMs == null ? 'não medida' : decision.decisionMs + ' ms'} ·
        atraso amostra→decisão:{' '}
        {decision?.sampleToDecisionMs == null ? 'não medido' : decision.sampleToDecisionMs + ' ms'}
      </small>
      {(deadline || decision?.responseDeadlineExceeded) && (
        <strong>ORÇAMENTO DE 60 s EXCEDIDO</strong>
      )}
      {(enforce ? report.engine?.lastError : report.shadow.lastError) && (
        <strong>Motor indisponível — ver health</strong>
      )}
    </div>
  );
}
