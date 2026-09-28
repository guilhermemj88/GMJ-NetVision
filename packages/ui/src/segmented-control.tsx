import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  label?: ReactNode;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  /** `stacked` = rótulo acima, controle abaixo (painéis laterais). */
  layout?: 'inline' | 'stacked';
  ariaLabel?: string;
  className?: string;
}

/** Controle segmentado único para todo o produto. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  layout = 'inline',
  ariaLabel,
  className = '',
}: SegmentedControlProps<T>) {
  return (
    <div className={`nv-segmented nv-segmented--${layout} nv-segmented--${size} ${className}`.trim()}>
      {label ? <span className="nv-segmented__label">{label}</span> : null}
      <div
        className="nv-segmented__options"
        role="group"
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      >
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={option.value === value ? 'is-active' : ''}
            aria-pressed={option.value === value}
            {...(option.title ? { title: option.title } : {})}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
