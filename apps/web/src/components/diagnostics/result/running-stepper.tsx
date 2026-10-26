'use client';

import type { VsiDiagnosticResult } from '@gmj/shared';
import styles from './result-view.module.css';

const STEPS = [
  'Inventário',
  'PE local',
  'PE remoto',
  'Reachability',
  'Correlação',
  'Resultado final',
] as const;

function reached(stage: string, step: string): boolean {
  const normalized = stage.toLocaleLowerCase('pt-BR');
  const key = step.toLocaleLowerCase('pt-BR');
  if (key === 'inventário') return /invent|pré|pre/.test(normalized);
  if (key === 'pe local') return /local/.test(normalized);
  if (key === 'pe remoto') return /remot/.test(normalized);
  if (key === 'reachability') return /ping|reach|probe|alcanc|conectiv/.test(normalized);
  if (key === 'correlação') return /correlac|compar|reciproc/.test(normalized);
  return /conclu|resultado final|finaliz/.test(normalized);
}

/**
 * Estado de execucao. Nunca exibe veredito: enquanto o job roda, o resultado
 * tecnico ainda nao existe.
 */
export function RunningStepper({ result }: { result: VsiDiagnosticResult }) {
  const history = result.progress ?? [];
  const currentStage = result.stage;
  const currentIndex = Math.max(
    0,
    STEPS.findIndex((step) => reached(currentStage, step)),
  );
  const elapsed = Date.parse(new Date().toISOString()) - Date.parse(result.startedAt);
  return (
    <section className={styles.running} aria-label="Diagnóstico em andamento" aria-live="polite">
      <header className={styles.runningHeader}>
        <span className={styles.pulse} aria-hidden="true" />
        <strong>Diagnóstico em andamento</strong>
        <span className={styles.runningStage}>{currentStage}</span>
        {Number.isFinite(elapsed) && elapsed >= 0 ? (
          <span className={styles.runningElapsed}>{Math.round(elapsed / 1000)} s</span>
        ) : null}
      </header>
      <ol className={styles.steps}>
        {STEPS.map((step, index) => {
          const state =
            index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
          return (
            <li key={step} className={`${styles.step} ${styles[`step_${state}`]}`}>
              <span className={styles.stepDot} aria-hidden="true" />
              {step}
            </li>
          );
        })}
      </ol>
      {history.length > 0 ? (
        <p className={styles.runningHint}>
          {history.length} etapa{history.length > 1 ? 's' : ''} registrada
          {history.length > 1 ? 's' : ''} · nenhum veredito é exibido antes da conclusão.
        </p>
      ) : null}
    </section>
  );
}
