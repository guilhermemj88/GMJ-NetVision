import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  compact?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'nv-button nv-button--primary',
  secondary: 'nv-button nv-button--secondary',
  ghost: 'nv-button nv-button--ghost',
  danger: 'nv-button nv-button--danger',
};

export function Button({
  className = '',
  variant = 'secondary',
  compact = false,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${variants[variant]} ${compact ? 'nv-button--compact' : ''} ${className}`.trim()}
      type="button"
      {...props}
    />
  );
}
