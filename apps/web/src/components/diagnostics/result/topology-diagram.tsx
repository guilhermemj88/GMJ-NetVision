'use client';

import type { VsiDiagnosticResult } from '@gmj/shared';
import type { Tone } from './health-model';
import styles from './result-view.module.css';

function labelOf(result: VsiDiagnosticResult): { local: string; remote: string } {
  const pw = result.checks.find((check) => check.category === 'PW' && /^PW /.test(check.label));
  const parts = pw ? pw.label.replace(/^PW\s+/, '').split(/\s+/) : [];
  return {
    local: result.local.observedVsi?.peers[0]?.outboundLabel?.toString() ?? parts[0] ?? '—',
    remote: result.local.observedVsi?.peers[0]?.inboundLabel?.toString() ?? parts[1] ?? '—',
  };
}

function toneFor(result: VsiDiagnosticResult): Tone {
  const pwChecks = result.checks.filter((check) => check.category === 'PW');
  if (pwChecks.some((check) => check.status === 'FAILED')) return 'error';
  if (pwChecks.some((check) => check.status === 'WARNING')) return 'attention';
  if (pwChecks.length && pwChecks.every((check) => check.status === 'OK')) return 'ok';
  return 'neutral';
}

/**
 * Cadeia PE local -> VSI -> PW -> VSI -> PE remoto. Representacao puramente
 * visual do que ja veio no resultado: nao infere topologia nem estado.
 */
export function TopologyDiagram({ result }: { result: VsiDiagnosticResult }) {
  const local = result.local;
  const remote = result.remotes[0] ?? null;
  const labels = labelOf(result);
  const pwTone = toneFor(result);
  const acLocal = result.checks.find((c) => c.category === 'AC' && c.hostId === local.hostId);
  const acRemote = remote
    ? result.checks.find((c) => c.category === 'AC' && c.hostId === remote.hostId)
    : undefined;

  return (
    <div className={styles.topology} aria-label="Cadeia do circuito">
      <div className={`${styles.node} ${styles.nodeEnd}`}>
        <strong>{local.name}</strong>
        <span>PE local</span>
        <code>{local.loopback?.address ?? 'loopback não confirmado'}</code>
        <span className={styles.nodeMeta}>
          AC {acLocal ? acLocal.label.replace(/^AC\s*/, '') : 'não comprovada'}
        </span>
        <span className={styles.nodeMeta}>label {labels.local}</span>
      </div>
      <div className={styles.link} aria-hidden="true">
        <span className={`${styles.linkLine} ${styles[`line_${acLocal?.status === 'FAILED' ? 'error' : 'ok'}`]}`} />
      </div>
      <div className={styles.node}>
        <strong>VSI</strong>
        <span>{local.vsiName ?? result.vsiName}</span>
        <code>{local.vsiId ?? result.vsiId}</code>
      </div>
      <div className={styles.link} aria-hidden="true">
        <span className={styles.linkLine} />
        <span className={`${styles.linkTag} ${styles[`tag_${pwTone}`]}`}>PW</span>
      </div>
      <div className={styles.node}>
        <strong>VSI remota</strong>
        <span>{remote?.vsiName ?? '—'}</span>
        <code>{remote?.vsiId ?? '—'}</code>
      </div>
      <div className={styles.link} aria-hidden="true">
        <span className={`${styles.linkLine} ${styles[`line_${acRemote?.status === 'FAILED' ? 'error' : 'ok'}`]}`} />
      </div>
      <div className={`${styles.node} ${styles.nodeEnd}`}>
        <strong>{remote?.name ?? 'PE remoto não identificado'}</strong>
        <span>PE remoto</span>
        <code>{remote?.loopback?.address ?? 'loopback não confirmado'}</code>
        <span className={styles.nodeMeta}>
          AC {acRemote ? acRemote.label.replace(/^AC\s*/, '') : 'não comprovada'}
        </span>
        <span className={styles.nodeMeta}>label {labels.remote}</span>
      </div>
    </div>
  );
}
