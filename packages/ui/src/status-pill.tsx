import type { ReactNode } from 'react';

/**
 * Estados operacionais canônicos do NetVision.
 *
 * A cor é sempre acompanhada de rótulo textual e de um marcador com forma
 * própria (anel cheio / losango para WARNING / traço para DISABLED), para que o
 * estado não dependa só de cor.
 */
export type OperationalStatus =
  | 'UP'
  | 'DOWN'
  | 'WARNING'
  | 'UNKNOWN'
  | 'DISABLED'
  | 'SELECTED'
  | 'INFO';

export type StatusPillSize = 'sm' | 'md';

export interface StatusPillProps {
  status: OperationalStatus;
  label?: ReactNode;
  size?: StatusPillSize;
  /** Rótulo técnico secundário (ex.: código SNMP, estado bruto do BGP). */
  detail?: ReactNode;
  title?: string;
  className?: string;
}

export function StatusPill({
  status,
  label,
  size = 'md',
  detail,
  title,
  className = '',
}: StatusPillProps) {
  const text = label ?? (status === 'INFO' ? 'INFO' : status);
  return (
    <span
      className={`nv-status nv-status--${status.toLowerCase()} nv-status--${size} ${className}`.trim()}
      {...(title ? { title } : {})}
    >
      <i className="nv-status__mark" aria-hidden="true" />
      <span className="nv-status__text">{text}</span>
      {detail ? <em className="nv-status__detail">{detail}</em> : null}
    </span>
  );
}
