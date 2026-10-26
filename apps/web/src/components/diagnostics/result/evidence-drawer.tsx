'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { VsiDiagnosticEvidence } from '@gmj/shared';
import { evidenceJson, evidenceSummary, formatUtc } from './health-model';
import styles from './result-view.module.css';

type Tab = 'resumo' | 'comando' | 'saida' | 'json';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'resumo', label: 'Resumo' },
  { id: 'comando', label: 'Comando' },
  { id: 'saida', label: 'Saída bruta' },
  { id: 'json', label: 'JSON bruto' },
];

/**
 * Drawer lateral de evidencia. Mostra apenas o que o backend ja devolveu
 * (saida textual sanitizada no servidor); nenhum segredo e lido ou derivado.
 */
export function EvidenceDrawer({
  evidence,
  onClose,
}: {
  evidence: VsiDiagnosticEvidence | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('resumo');

  useEffect(() => {
    setTab('resumo');
  }, [evidence?.id]);

  useEffect(() => {
    if (!evidence) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [evidence, onClose]);

  if (!evidence) return null;

  return (
    <>
      <button className={styles.scrim} aria-label="Fechar evidência" onClick={onClose} />
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={`Evidência ${evidence.id}`}
      >
        <header className={styles.drawerHeader}>
          <div>
            <strong>{evidence.source}</strong>
            <span className={styles.drawerHost}>{evidence.hostId}</span>
          </div>
          <button className={styles.drawerClose} onClick={onClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </header>
        <nav className={styles.drawerTabs} aria-label="Visões da evidência">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={item.id === tab ? styles.drawerTabActive : styles.drawerTab}
              aria-pressed={item.id === tab}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className={styles.drawerBody}>
          {tab === 'resumo' && (
            <dl className={styles.evidenceMeta}>
              <div>
                <dt>Host</dt>
                <dd>{evidence.hostId}</dd>
              </div>
              <div>
                <dt>Fonte</dt>
                <dd>{evidence.source}</dd>
              </div>
              <div>
                <dt>Observado em</dt>
                <dd>{formatUtc(evidence.observedAt)}</dd>
              </div>
              <div>
                <dt>Coletado em</dt>
                <dd>{formatUtc(evidence.collectedAt)}</dd>
              </div>
              <div>
                <dt>Duração</dt>
                <dd>{evidence.durationMs === undefined ? '—' : `${evidence.durationMs} ms`}</dd>
              </div>
              <div>
                <dt>Completa</dt>
                <dd>{evidence.complete === undefined ? '—' : evidence.complete ? 'sim' : 'não'}</dd>
              </div>
              {evidence.errorCode ? (
                <div>
                  <dt>Código</dt>
                  <dd>{evidence.errorCode}</dd>
                </div>
              ) : null}
              {evidence.sha256 ? (
                <div>
                  <dt>sha256</dt>
                  <dd>
                    <code>{evidence.sha256}</code>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Resumo</dt>
                <dd>{evidenceSummary(evidence) || '—'}</dd>
              </div>
            </dl>
          )}
          {tab === 'comando' && (
            <pre className={styles.pre}>{evidence.command ?? 'sem comando associado'}</pre>
          )}
          {tab === 'saida' && <pre className={styles.pre}>{evidence.output}</pre>}
          {tab === 'json' && <pre className={styles.pre}>{evidenceJson(evidence)}</pre>}
        </div>
      </aside>
    </>
  );
}
