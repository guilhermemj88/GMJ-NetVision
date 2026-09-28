import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Ação primária (botão) ou dica de próximo passo. */
  action?: ReactNode;
  /** Lista curta de fatos/hints (ex.: o que verificar antes). */
  hints?: ReactNode;
  variant?: 'default' | 'compact' | 'inline';
  className?: string;
}

/**
 * Estado vazio padrão.
 *
 * Sempre diz o que está vazio e qual é o próximo passo; nunca deixa um vazio
 * silencioso ocupando a tela inteira.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  hints,
  variant = 'default',
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`nv-empty nv-empty--${variant} ${className}`.trim()}>
      {icon ? <span className="nv-empty__icon">{icon}</span> : null}
      <strong className="nv-empty__title">{title}</strong>
      {description ? <p className="nv-empty__description">{description}</p> : null}
      {hints ? <div className="nv-empty__hints">{hints}</div> : null}
      {action ? <div className="nv-empty__action">{action}</div> : null}
    </div>
  );
}
