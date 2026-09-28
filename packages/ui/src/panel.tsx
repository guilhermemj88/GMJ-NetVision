import type { ReactNode } from 'react';

export interface PanelProps {
  /** Rótulo micro em mono acima do título. */
  eyebrow?: ReactNode;
  title?: ReactNode;
  /** Conteúdo à direita do cabeçalho (badges, ações). */
  headerActions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** `rail` = coluna estreita de layers; `inspector` = painel lateral largo. */
  variant?: 'inspector' | 'rail' | 'overlay';
  className?: string;
  /** Torna o corpo rolável (padrão) ou deixa o conteúdo controlar o scroll. */
  scroll?: boolean;
}

/**
 * Painel lateral padrão do NetVision (inspector contextual, layers, overlays).
 *
 * Não é modal por si só: quem monta decide o posicionamento. O cabeçalho só
 * aparece quando há título, ações ou fechamento.
 */
export function Panel({
  eyebrow,
  title,
  headerActions,
  onClose,
  closeLabel = 'Fechar painel',
  children,
  footer,
  variant = 'inspector',
  className = '',
  scroll = true,
}: PanelProps) {
  const hasHeader = Boolean(eyebrow || title || headerActions || onClose);
  return (
    <section className={`nv-panel nv-panel--${variant} ${className}`.trim()}>
      {hasHeader ? (
        <header className="nv-panel__header">
          <div className="nv-panel__identity">
            {eyebrow ? <span className="nv-panel__eyebrow">{eyebrow}</span> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {headerActions ? <div className="nv-panel__actions">{headerActions}</div> : null}
          {onClose ? (
            <button
              type="button"
              className="nv-panel__close"
              aria-label={closeLabel}
              onClick={onClose}
            >
              ×
            </button>
          ) : null}
        </header>
      ) : null}
      <div className={`nv-panel__body ${scroll ? 'is-scroll' : ''}`.trim()}>{children}</div>
      {footer ? <footer className="nv-panel__footer">{footer}</footer> : null}
    </section>
  );
}

export interface PanelSectionProps {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Bloco titulado dentro de um Panel, com o mesmo padrão em todos os módulos. */
export function PanelSection({
  title,
  icon,
  actions,
  children,
  className = '',
}: PanelSectionProps) {
  return (
    <section className={`nv-panel-section ${className}`.trim()}>
      {title || actions ? (
        <header className="nv-panel-section__header">
          {title ? (
            <span className="nv-panel-section__title">
              {icon}
              {title}
            </span>
          ) : null}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}
