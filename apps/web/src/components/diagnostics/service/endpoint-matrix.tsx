import type { CSSProperties } from 'react';
import type { VsiServiceDiagnosis } from '@gmj/shared';
import { Badge, OriginBadge, ToneIcon, toneClass } from './badges';
import { LAYERS, STATUS_ROWS, buildCell, endpointBadges, endpointStatusCells } from './view-model';
import styles from './service-view.module.css';

/**
 * Uma coluna por PE, uma linha por camada: Master e Backup ficam lado a lado.
 * Abaixo de 900 px vira cartoes empilhados por PE (ordem controlada por `--o`).
 */
export function EndpointMatrix({
  diagnosis,
  onEvidence,
}: {
  diagnosis: VsiServiceDiagnosis;
  onEvidence: (id: string) => void;
}) {
  const { endpoints } = diagnosis;
  let row = 0;
  const order = (column: number, r: number): CSSProperties => ({ '--o': (column + 1) * 100 + r } as CSSProperties);
  return (
    <div className={styles.mxScroll}>
      <div className={styles.mx} style={{ '--n': endpoints.length } as CSSProperties} role="table" aria-label="Comparação por equipamento">
        <div className={styles.mxCorner} aria-hidden="true" />
        {endpoints.map((e, c) => (
          <div key={e.hostName} className={styles.mxHead} style={order(c, 0)} role="columnheader" data-endpoint={e.hostName}>
            <div className={styles.mxName}>{e.hostName}</div>
            <div className={styles.quiet}>{[e.platform, e.loopback].filter(Boolean).join(' · ') || 'plataforma não identificada'}</div>
            <div className={styles.badgeLine}>
              {endpointBadges(e, diagnosis.engine).map((b) => (
                <Badge key={b.label} tone={b.tone} label={b.label} />
              ))}
            </div>
          </div>
        ))}
        {LAYERS.map((group) => [
          <div key={group.group} className={styles.mxGroup}>
            {group.group}
          </div>,
          ...group.rows.map((layer) => {
            row += 1;
            const r = row;
            return [
              <div key={`${layer.key}-label`} className={styles.mxLab}>
                {layer.label}
              </div>,
              ...endpoints.map((e, c) => (
                <div key={`${layer.key}-${e.hostName}`} className={styles.mxCell} style={order(c, r)} data-layer={layer.key} data-endpoint={e.hostName}>
                  <span className={styles.mxCellLab}>{layer.label}</span>
                  {buildCell(layer.key, e, diagnosis).map((entry, i) => (
                    <div key={i} className={`${styles.entry} ${toneClass(entry.tone)}`} data-tone={entry.tone}>
                      <div className={styles.entryHead}>
                        <span className={styles.entryState}>
                          <ToneIcon tone={entry.tone} />
                          {entry.label}
                        </span>
                        <OriginBadge origin={entry.origin} />
                      </div>
                      {entry.lines.map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                      {entry.details.map((line) => (
                        <small key={line}>{line}</small>
                      ))}
                      {entry.evidenceId ? (
                        <button className={styles.evlink} data-evidence-id={entry.evidenceId} onClick={() => onEvidence(entry.evidenceId!)}>
                          ver evidência
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )),
            ];
          }),
        ])}
        <div className={styles.mxGroup}>Coleta, evidência e estado do serviço</div>
        {STATUS_ROWS.map((statusRow, i) => [
          <div key={`${statusRow.key}-label`} className={styles.mxLab}>
            {statusRow.label}
          </div>,
          ...endpoints.map((e, c) => {
            const status = endpointStatusCells(e, diagnosis).find((s) => s.key === statusRow.key)!;
            return (
              <div key={`${statusRow.key}-${e.hostName}`} className={styles.mxCell} style={order(c, 90 + i)} data-status={statusRow.key} data-endpoint={e.hostName}>
                <span className={styles.mxCellLab}>{statusRow.label}</span>
                <div className={`${styles.entry} ${toneClass(status.tone)}`} data-status-tone={status.tone}>
                  <div className={styles.entryHead}>
                    <span className={styles.entryState}>
                      <ToneIcon tone={status.tone} />
                      {status.label}
                    </span>
                  </div>
                  {status.lines.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                  {status.details.map((line) => (
                    <small key={line}>{line}</small>
                  ))}
                </div>
              </div>
            );
          }),
        ])}
      </div>
    </div>
  );
}
