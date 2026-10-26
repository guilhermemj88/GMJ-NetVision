'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  VsiDiagnosticExecutionContext,
  VsiDiagnosticResult,
  VsiDiagnosticStatus,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import styles from './vsi-diagnostic.module.css';
function reachability(status: VsiDiagnosticStatus): string {
  return status === 'OK'
    ? 'Alcançável'
    : status === 'WARNING'
      ? 'Alcançável com perda'
      : status === 'FAILED'
        ? 'Sem resposta'
        : 'Inconclusivo';
}
/** Informativo: separa RBAC do NetVision, conta SSH e autorização no equipamento. */
function ExecutionContext({
  result,
  context,
}: {
  result: VsiDiagnosticResult;
  context: VsiDiagnosticExecutionContext;
}) {
  const sessions = context.endpoints.filter((e) => e.executedCommands > 0);
  const usernames = [...new Set(sessions.map((e) => e.sshUsername).filter(Boolean))];
  const confirmed =
    context.endpoints.length > 0 &&
    context.endpoints.every((e) => e.commandAuthorization === 'CONFIRMED_FOR_EXECUTED_COMMANDS');
  const pes = context.endpoints.length === 2 ? 'nos dois PEs' : 'no PE';
  return (
    <section className={styles.context} aria-label="Contexto de execução">
      <h3>Contexto de execução</h3>
      <dl>
        <dt>Permissão no NetVision</dt>
        <dd>
          {result.operator.username} ({result.operator.role}) — usuário que iniciou esta execução.
        </dd>
        <dt>Acesso aos equipamentos</dt>
        <dd>
          {sessions.length === 0
            ? 'Nenhuma sessão SSH aberta nesta execução.'
            : usernames.length === 1
              ? `Conta de serviço ${usernames[0]}.`
              : sessions.map((e) => `${e.name}: ${e.sshUsername ?? 'N/D'}`).join(' · ')}
        </dd>
        <dt>Autorização dos comandos</dt>
        <dd>
          {confirmed
            ? `Todos os comandos necessários desta execução foram aceitos e produziram evidência válida ${pes}.`
            : context.endpoints
                .map((e) =>
                  e.commandAuthorization === 'CONFIRMED_FOR_EXECUTED_COMMANDS'
                    ? `${e.name}: comandos desta execução aceitos (${e.acceptedCommands}/${e.executedCommands}).`
                    : e.commandAuthorization === 'NOT_EXECUTED'
                      ? `${e.name}: nenhum comando executado.`
                      : e.acceptedCommands < e.executedCommands
                        ? `${e.name}: não confirmada (${e.acceptedCommands}/${e.executedCommands} comandos com evidência válida).`
                        : `${e.name}: não confirmada; nem todos os comandos necessários foram executados (${e.acceptedCommands}/${e.executedCommands} executados com evidência válida).`,
                )
                .join(' ')}{' '}
          Vale somente para os comandos executados nesta execução.
        </dd>
        <dt>Nível de privilégio no equipamento</dt>
        <dd>
          Não verificado explicitamente.
          {confirmed && ' Isso não afeta o resultado desta execução.'}
        </dd>
      </dl>
    </section>
  );
}
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
          {running ? (
            <>
              <strong>DIAGNÓSTICO EM ANDAMENTO · {result.vsiName}</strong>
              <p>Coletando e validando evidências dos PEs…</p>
              <p>{result.stage}</p>
            </>
          ) : (
            <>
              <strong>
                {result.overallStatus} · {result.vsiName}
              </strong>
              <p>{result.stage}</p>
              <p>{result.summary}</p>
            </>
          )}
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
              IP {probe.source} → {probe.destination} · {reachability(probe.status)} ·{' '}
              {probe.received ?? 'N/D'}/{probe.transmitted ?? 'N/D'} respostas · RTT médio{' '}
              {probe.rttMs?.avg ?? 'N/D'} ms
              {probe.lossPercent !== null && (
                <small>
                  {' '}
                  (perda {probe.lossPercent}% em {probe.transmitted ?? 'N/D'} pacotes)
                </small>
              )}
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
          {!running && result.executionContext && (
            <ExecutionContext result={result} context={result.executionContext} />
          )}
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
