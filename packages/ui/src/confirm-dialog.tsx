import type { ReactNode } from 'react';
import { Button } from './button';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** Explica a consequência real da ação. */
  description?: ReactNode;
  /** Fatos adicionais (o que exatamente será afetado). */
  details?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'neutral';
  pending?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmação única para ações destrutivas.
 *
 * Genérico de propósito: as confirmações com semântica própria (como a de
 * ação administrativa de BGP, com read-back e fatos do peer) continuam nos
 * seus próprios painéis.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  details,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'danger',
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  const titleId = 'nv-confirm-title';
  const descriptionId = 'nv-confirm-description';

  return (
    <div className="nv-confirm-backdrop" role="presentation">
      <section
        className={`nv-confirm nv-confirm--${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="nv-confirm__header">
          <span className="nv-confirm__badge">{tone === 'danger' ? 'AÇÃO DESTRUTIVA' : 'CONFIRMAÇÃO'}</span>
          <h2 id={titleId}>{title}</h2>
        </header>
        {description ? (
          <p className="nv-confirm__description" id={descriptionId}>
            {description}
          </p>
        ) : null}
        {details ? <div className="nv-confirm__details">{details}</div> : null}
        {error ? (
          <div className="nv-confirm__error" role="alert">
            {error}
          </div>
        ) : null}
        <footer className="nv-confirm__footer">
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? 'Executando…' : confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
