'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VsiServiceRunSummary } from '@gmj/shared';
import { vsiServiceClient, type VsiServiceClient } from '@/lib/vsi-service-api';
import { VsiServiceDiagnosisView } from './service-view';
import { VERDICT_META, formatInstant } from './view-model';
import styles from './service-workspace.module.css';

/** Real x replay precisa estar claro ja na lista, antes de abrir o resultado. */
export function originTag(run: Pick<VsiServiceRunSummary, 'origin' | 'label'>): { text: string; kind: 'real' | 'replay' | 'other' } {
  if (run.origin === 'REPLAY') return { text: 'REPLAY · SEM SSH', kind: 'replay' };
  if (run.origin === 'FIXTURE') return { text: 'FIXTURE', kind: 'other' };
  if (run.origin === 'LEGACY_JOB') return { text: 'MOTOR LEGADO', kind: 'other' };
  return { text: run.label ? `COLETA REAL · ${run.label.toUpperCase()}` : 'COLETA REAL', kind: 'real' };
}

const ROLE: Record<string, string> = {
  ACTIVE: 'ativo',
  STANDBY_EXPECTED: 'standby esperado',
  DOWN_UNEXPECTED: 'falha',
  ROLE_UNKNOWN: 'papel indeterminado',
};

/**
 * Diagnostico VSI/VPLS por servico dentro da area de Diagnostico: lista os resultados JA GUARDADOS
 * e abre o escolhido na tela de servico. So aparece quando a API informa o recurso habilitado.
 *
 * Esta tela NAO executa coleta: listar e abrir sao leituras (GET). Abrir um resultado nunca dispara
 * diagnostico nem SSH; nada e aberto sozinho — o operador escolhe.
 */
export function VsiServiceWorkspace({
  vsiName = null,
  client = vsiServiceClient,
}: {
  /** VSI selecionada na area de Diagnostico; filtra a lista. null = todas. */
  vsiName?: string | null;
  client?: VsiServiceClient;
}) {
  const [onlySelected, setOnlySelected] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const filter = vsiName && onlySelected ? vsiName : null;

  const status = useQuery({ queryKey: ['vsi-service-status'], queryFn: () => client.status(), staleTime: 60_000, retry: false });
  const enabled = status.data?.enabled === true;
  const runs = useQuery({
    queryKey: ['vsi-service-runs', filter],
    queryFn: () => client.list(filter ?? undefined),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
  // Somente apos o operador escolher um resultado (openId): nunca ha busca automatica de resultado.
  const opened = useQuery({
    queryKey: ['vsi-service-run', openId],
    queryFn: () => client.get(openId!),
    enabled: enabled && openId !== null,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => setOpenId(null), [vsiName]);

  if (!enabled) return null;
  const list = runs.data ?? [];
  return (
    <section className={styles.section} aria-label="Diagnóstico VSI/VPLS por serviço" data-vsi-service-workspace>
      <div className={styles.head}>
        <h2>Diagnóstico VSI/VPLS por serviço · resultados guardados</h2>
        {vsiName ? (
          <label className={styles.filter}>
            <input type="checkbox" checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)} />
            somente a VSI selecionada ({vsiName})
          </label>
        ) : null}
      </div>
      <p className={styles.note}>
        Abrir um resultado guardado só consulta o que já foi coletado: não executa diagnóstico e não abre SSH. Uma nova coleta real
        continua exigindo aprovação específica por equipamento.
      </p>
      {runs.isPending ? <p className={styles.empty}>Consultando resultados…</p> : null}
      {runs.isError ? (
        <p className={styles.error} role="alert">
          Não foi possível listar os resultados: {(runs.error as Error).message}
        </p>
      ) : null}
      {runs.isSuccess && list.length === 0 ? (
        <p className={styles.empty} data-empty>
          Nenhum resultado guardado{filter ? ` para ${filter}` : ''}.
        </p>
      ) : null}
      {list.length > 0 ? (
        <ul className={styles.list}>
          {list.map((run) => {
            const tag = originTag(run);
            const isOpen = run.runId === openId;
            const tagClass = tag.kind === 'real' ? styles.tagReal : tag.kind === 'replay' ? styles.tagReplay : styles.tagOther;
            return (
              <li key={run.runId} className={`${styles.run} ${isOpen ? styles.runOpen : ''}`} data-run-id={run.runId}>
                <div>
                  <div className={styles.runTitle}>
                    <strong>{run.vsiName}</strong>
                    <span>{VERDICT_META[run.verdict].label}</span>
                    <span className={`${styles.tag} ${tagClass}`} data-origin-tag={tag.kind}>
                      {tag.text}
                    </span>
                  </div>
                  <div className={styles.runMeta}>
                    coletado em {formatInstant(run.completedAt)} ·{' '}
                    {run.endpoints
                      .map((e) => `${e.hostName} (${e.collection === 'NOT_READ' ? 'não lido' : (e.accessRole && ROLE[e.accessRole]) || 'lido'})`)
                      .join(' · ')}
                  </div>
                </div>
                <button type="button" className={styles.open} aria-pressed={isOpen} onClick={() => setOpenId(isOpen ? null : run.runId)}>
                  {isOpen ? 'Fechar' : 'Abrir'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {openId !== null ? (
        <div className={styles.result} aria-live="polite">
          {opened.isPending ? <p className={styles.empty}>Carregando resultado guardado…</p> : null}
          {opened.isError ? (
            <p className={styles.error} role="alert">
              Não foi possível abrir o resultado: {(opened.error as Error).message}
            </p>
          ) : null}
          {opened.data ? <VsiServiceDiagnosisView diagnosis={opened.data} /> : null}
        </div>
      ) : null}
    </section>
  );
}
