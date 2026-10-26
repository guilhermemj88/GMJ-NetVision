'use client';
import { useEffect, useRef, useState } from 'react';
import type { VsiDiagnosticResult } from '@gmj/shared';
import { Button } from '@gmj/ui';
import styles from './vsi-diagnostic.module.css';
type Approval = {
  approvalId: string;
  hostId: string;
  vsiId: string;
  createdAt: string;
  expiresAt: string;
};
export function VsiDiagnosticPanel({ hostId, vsiId }: { hostId: string; vsiId: string }) {
  const [result, setResult] = useState<VsiDiagnosticResult | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const base = `/api/hosts/${encodeURIComponent(hostId)}/mpls/vsis/${encodeURIComponent(vsiId)}`;
  const diagnosticId = result?.diagnosticId;
  const jobState = result?.state;
  const approvalLeft = approval
    ? Math.max(0, Math.ceil((Date.parse(approval.expiresAt) - clock) / 1000))
    : 0;
  const approvalValid = approval !== null && approvalLeft > 0;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!approvalValid) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approvalValid]);
  async function json<T>(path: string, method = 'GET', signal?: AbortSignal, payload?: unknown) {
    const response = await fetch(path, {
      method,
      credentials: 'include',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      ...(method === 'POST'
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) }
        : {}),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? `Falha HTTP ${response.status}`);
    return body as T;
  }
  useEffect(() => {
    if (!diagnosticId || !jobState || !['QUEUED', 'RUNNING'].includes(jobState)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await json<VsiDiagnosticResult>(
          `${base}/diagnostics/${diagnosticId}`,
          'GET',
          abort.signal,
        );
        if (!abort.signal.aborted) setResult(next);
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [base, diagnosticId, jobState]);
  async function arm() {
    setBusy(true);
    setError('');
    controller.current?.abort();
    controller.current = new AbortController();
    try {
      const created = await json<Approval>(
        `${base}/diagnostic-approvals`,
        'POST',
        controller.current.signal,
      );
      setApproval(created);
      setClock(Date.now());
    } catch (e) {
      if (!controller.current.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!approvalValid) {
      setError('Prepare a janela one-shot antes de diagnosticar.');
      return;
    }
    setBusy(true);
    setError('');
    controller.current?.abort();
    controller.current = new AbortController();
    try {
      setResult(
        await json<VsiDiagnosticResult>(base + '/diagnose', 'POST', controller.current.signal, {
          approvalId: approval!.approvalId,
        }),
      );
      setApproval(null);
    } catch (e) {
      if (!controller.current.signal.aborted) {
        setError((e as Error).message);
        setApproval(null);
      }
    } finally {
      setBusy(false);
    }
  }
  const running = result && ['QUEUED', 'RUNNING'].includes(result.state);
  return (
    <section className={styles.panel} aria-label="Diagnóstico automático da VSI">
      <Button disabled={busy || Boolean(running)} onClick={() => void arm()}>
        {approvalValid ? 'Renovar janela' : 'Preparar janela'}
      </Button>
      <Button disabled={busy || Boolean(running) || !approvalValid} onClick={() => void start()}>
        {busy || running ? 'Diagnóstico em andamento...' : 'Diagnosticar'}
      </Button>
      {approvalValid && <p role="status">Janela one-shot válida por {approvalLeft}s.</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <div aria-live="polite">
          <strong>
            {result.overallStatus} · {result.vsiName}
          </strong>
          <p>{result.stage}</p>
          <p>{result.summary}</p>
          {result.underlayClassification && (
            <p>
              Underlay: <strong>{result.underlayClassification}</strong>
            </p>
          )}
          <p>
            Execução: {result.diagnosticId} · {result.operator.username} · {result.state}
          </p>
          {result.remotes.map((remote) => (
            <p key={remote.hostId}>
              PE remoto: {remote.name} · LoopBack {remote.loopback?.address ?? 'não confirmada'}
            </p>
          ))}
          {result.probes?.map((probe) => (
            <p key={probe.sourceHostId + probe.destinationHostId}>
              IP {probe.source} → {probe.destination} · perda {probe.lossPercent ?? 'N/D'}% · RTT
              médio {probe.rttMs?.avg ?? 'N/D'} ms · respostas {probe.received ?? 'N/D'}/
              {probe.transmitted ?? 'N/D'}
              {probe.tracerouteNotExecutedReason && (
                <span> · Tracert não executado: {probe.tracerouteNotExecutedReason}</span>
              )}
              {probe.hops.map((hop) => (
                <span key={hop.ttl}>
                  {' '}
                  · salto {hop.ttl}: {hop.address ?? '*'} ({hop.timesMs.join('/') || 'N/D'} ms)
                </span>
              ))}
            </p>
          ))}
          {running && (
            <Button
              onClick={() =>
                void json<VsiDiagnosticResult>(`${base}/diagnostics/${result.diagnosticId}/cancel`, 'POST')
                  .then(setResult)
                  .catch((e) => setError(e.message))
              }
            >
              Cancelar
            </Button>
          )}
          <p>
            Origem MPLS: {result.local.loopback?.address ?? 'não confirmada'} · VLAN não é inferida
            pelo nome ou sufixo.
          </p>
          <ol>
            {result.checks.map((check) => (
              <li key={check.id}>
                <strong>
                  {check.category} · {check.status}
                </strong>
                <p>
                  {check.label} · equipamento{' '}
                  {result.local.hostId === check.hostId
                    ? result.local.name
                    : (result.remotes.find((r) => r.hostId === check.hostId)?.name ?? check.hostId)}
                </p>
                <p>
                  {check.message} · {check.certainty}
                </p>
              </li>
            ))}
          </ol>
          {result.nextTests.map((text) => (
            <p key={text}>Próximo teste: {text}</p>
          ))}
          {result.warnings.map((text) => (
            <p key={text}>Limitação: {text}</p>
          ))}
          <details>
            <summary>Evidências e comandos ({result.evidence.length})</summary>
            {result.evidence.map((e) => (
              <div key={e.id}>
                <strong>
                  {e.source} · {e.hostId}
                </strong>
                <p>
                  Observado: {e.observedAt ?? 'não confirmado'} · coletado: {e.collectedAt}
                </p>
                {e.command && <code>{e.command}</code>}
                <pre>{e.output || 'Sem saída confirmada.'}</pre>
              </div>
            ))}
          </details>
          <p>Resultado temporário; retenção em memória. Não substitui monitoramento recorrente.</p>
        </div>
      )}
    </section>
  );
}
