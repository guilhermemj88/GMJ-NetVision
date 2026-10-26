'use client';

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { HealthCard, Tone } from './health-model';
import styles from './result-view.module.css';

const ICON: Record<Tone, LucideIcon> = {
  ok: CheckCircle2,
  attention: AlertTriangle,
  error: XCircle,
  neutral: CircleDashed,
};

const TONE_LABEL: Record<Tone, string> = {
  ok: 'ok',
  attention: 'atenção',
  error: 'falha',
  neutral: 'sem evidência',
};

export function HealthCards({ cards }: { cards: HealthCard[] }) {
  return (
    <ul className={styles.cards} aria-label="Saúde dos componentes">
      {cards.map((card) => {
        const Icon = ICON[card.tone];
        return (
          <li key={card.id} className={`${styles.card} ${styles[`card_${card.tone}`]}`}>
            <span className={styles.cardIcon} aria-hidden="true">
              <Icon size={16} />
            </span>
            <span className={styles.cardTitle}>{card.title}</span>
            <span className={styles.cardDetail} title={card.detail}>
              {card.detail}
            </span>
            <span className={styles.srOnly}>estado: {TONE_LABEL[card.tone]}</span>
          </li>
        );
      })}
    </ul>
  );
}
