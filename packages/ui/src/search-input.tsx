import type { ReactNode } from 'react';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  'aria-label'?: string;
  /** Ícone à esquerda (padrão: lupa desenhada em CSS). */
  icon?: ReactNode;
  size?: 'sm' | 'md';
  /** Indicador à direita (ex.: spinner de busca em andamento). */
  trailing?: ReactNode;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** Campo de busca padrão (filtros de módulo, buscas globais, listas). */
export function SearchInput({
  value,
  onChange,
  placeholder,
  icon,
  size = 'md',
  trailing,
  className = '',
  autoFocus = false,
  onKeyDown,
  ...rest
}: SearchInputProps) {
  return (
    <label className={`nv-search nv-search--${size} ${className}`.trim()}>
      <span className="nv-search__icon" aria-hidden="true">
        {icon ?? <i className="nv-search__glyph" />}
      </span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={rest['aria-label'] ?? placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoFocus={autoFocus}
        {...(onKeyDown ? { onKeyDown } : {})}
      />
      {trailing ? <span className="nv-search__trailing">{trailing}</span> : null}
    </label>
  );
}
