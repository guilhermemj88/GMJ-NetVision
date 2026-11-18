import { AlertTriangle, Check, Clock, HelpCircle, Pause, Triangle, Unplug, X } from 'lucide-react';
import type { OriginView, Tone } from './view-model';
import styles from './service-view.module.css';

/** Icone por tom: o estado nunca depende so da cor. */
export function ToneIcon({ tone, size = 13 }: { tone: Tone; size?: number }) {
  const props = { size, 'aria-hidden': true, strokeWidth: 2.4 } as const;
  switch (tone) {
    case 'ok':
      return <Check {...props} />;
    case 'active':
      return <Triangle {...props} fill="currentColor" />;
    case 'warn':
      return <AlertTriangle {...props} />;
    case 'crit':
      return <X {...props} />;
    case 'standby':
      return <Pause {...props} fill="currentColor" />;
    case 'stale':
      return <Clock {...props} />;
    case 'collect':
      return <Unplug {...props} />;
    default:
      return <HelpCircle {...props} />;
  }
}

export const toneClass = (tone: Tone): string => styles[`t_${tone}`] ?? '';

export function Badge({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`${styles.badge} ${toneClass(tone)}`} data-tone={tone}>
      <ToneIcon tone={tone} />
      {label}
    </span>
  );
}

export function OriginBadge({ origin }: { origin: OriginView }) {
  return (
    <span className={`${styles.origin} ${styles[`origin_${origin.kind}`]}`} data-origin={origin.kind}>
      {origin.label}
    </span>
  );
}
