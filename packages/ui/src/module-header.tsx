import type { ReactNode } from 'react';

export interface ModuleHeaderProps {
  /** Micro-rótulo acima do título (ex.: 'INVENTÁRIO GLOBAL'). */
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Linha de fatos/indicadores logo abaixo do subtítulo. */
  meta?: ReactNode;
  /** Botões e controles primários do módulo. */
  actions?: ReactNode;
  /** Faixa opcional logo abaixo do cabeçalho (filtros, abas, busca). */
  toolbar?: ReactNode;
  /**
   * `band` = faixa de largura total com borda (Mapa / Físico).
   * `inline` = sem fundo nem borda, para viver dentro de um shell já espaçado.
   */
  variant?: 'band' | 'inline';
  className?: string;
}

/**
 * Cabeçalho padrão de módulo (Hosts, BGP, Físico, Mapa).
 *
 * Mantém o mesmo ritmo visual em todas as áreas: micro-rótulo em mono, título,
 * subtítulo discreto, fatos em linha e ações alinhadas à direita.
 */
export function ModuleHeader({
  eyebrow,
  title,
  subtitle,
  meta,
  actions,
  toolbar,
  variant = 'band',
  className = '',
}: ModuleHeaderProps) {
  return (
    <header className={`nv-module-header nv-module-header--${variant} ${className}`.trim()}>
      <div className="nv-module-header__row">
        <div className="nv-module-header__identity">
          {eyebrow ? <span className="nv-module-header__eyebrow">{eyebrow}</span> : null}
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
          {meta ? <div className="nv-module-header__meta">{meta}</div> : null}
        </div>
        {actions ? <div className="nv-module-header__actions">{actions}</div> : null}
      </div>
      {toolbar ? <div className="nv-module-header__toolbar">{toolbar}</div> : null}
    </header>
  );
}

export interface MetaFactProps {
  label?: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'warning' | 'unknown' | 'info';
  title?: string;
}

/** Fato curto do cabeçalho: ícone + valor + rótulo discreto. */
export function MetaFact({ label, value, icon, tone = 'neutral', title }: MetaFactProps) {
  return (
    <span className={`nv-fact nv-fact--${tone}`} {...(title ? { title } : {})}>
      {icon}
      <strong>{value}</strong>
      {label ? <span>{label}</span> : null}
    </span>
  );
}
