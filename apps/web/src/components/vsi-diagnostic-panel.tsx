'use client';
import { useEffect, useRef, useState } from 'react';
import type { VsiDiagnosticResult } from '@gmj/shared';
import { Button } from '@gmj/ui';
import styles from './vsi-diagnostic.module.css';
import { VsiDiagnosticResultView } from './diagnostics/result/result-view';
type Approval = {
  approvalId: string;
  hostId: string;
  vsiId: string;
  createdAt: string;
  expiresAt: string;
};
export function VsiDiagnosticPanel({
  hostId,
  vsiId,
  diagnosticEnabled = false,
  canArm = true,
  canExecute = true,
}: {
  hostId: string;
  vsiId: string;
  diagnosticEnabled?: boolean;
  canArm?: boolean;
  canExecute?: boolean;
}) {
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
    if (!diagnosticEnabled || !canArm) return;
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
    if (!diagnosticEnabled || !canExecute) return;
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
      {!diagnosticEnabled && <p role="status">Diagnóstico VSI desativado</p>}
      <Button
        disabled={busy || Boolean(running) || !diagnosticEnabled || !canArm}
        onClick={() => void arm()}
      >
        {approvalValid ? 'Renovar janela' : 'Preparar janela'}
      </Button>
      <Button
        disabled={
          busy || Boolean(running) || !diagnosticEnabled || !canExecute || !approvalValid
        }
        onClick={() => void start()}
      >
        {busy || running ? 'Diagnóstico em andamento...' : 'Diagnosticar'}
      </Button>
      {approvalValid && <p role="status">Janela one-shot válida por {approvalLeft}s.</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <div aria-live="polite">
          <VsiDiagnosticResultView result={result} />
          {running && (
            <Button
              onClick={() =>
                void json<VsiDiagnosticResult>(
                  `${base}/diagnostics/${result.diagnosticId}/cancel`,
                  'POST',
                )
                  .then(setResult)
                  .catch((e) => setError(e.message))
              }
            >
              Cancelar
            </Button>
          )}
          <p>Resultado temporário; retenção em memória. Não substitui monitoramento recorrente.</p>
        </div>
      )}
    </section>
  );
}
