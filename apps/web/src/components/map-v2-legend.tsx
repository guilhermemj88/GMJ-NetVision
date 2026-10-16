'use client';

/**
 * MAP-VISUAL-V2 — Fase E: legenda do enlace bidirecional.
 *
 * Só aparece no modo V2 (a V1 mantém o rodapé dela intacto). As cores vêm dos
 * MESMOS tokens usados pelo traço, pelas setas e pelos rótulos (`--wm-*`), então
 * legenda e mapa não divergem. O texto de animação reflete o modo escolhido no
 * preview.
 */

import {
  LINK_V2_ANIMATION_LABELS,
  type LinkV2AnimationMode,
} from '@/lib/map-visual-v2-weathermap';

interface LegendItem {
  label: string;
  state: string;
  dashed?: boolean;
  hint?: string;
}

const UTILIZATION_ITEMS: readonly LegendItem[] = [
  { label: 'Operacional (0–49%)', state: 'normal' },
  { label: 'Atenção (50–79%)', state: 'attention' },
  { label: 'Crítico (≥80%)', state: 'critical' },
];

const STATE_ITEMS: readonly LegendItem[] = [
  { label: 'DOWN', state: 'down', dashed: true },
  { label: 'Sem dados', state: 'no-data', dashed: true },
  { label: 'Stale', state: 'stale', dashed: true },
  { label: 'Inconsistente / parcial', state: 'inconsistent', dashed: true },
];

export function MapV2Legend({ animation }: { animation: LinkV2AnimationMode }) {
  return (
    <div className="map-v2-legend" role="note" aria-label="Legenda dos enlaces (V2)">
      {UTILIZATION_ITEMS.map((item) => (
        <span className="map-v2-legend__item" key={item.state} data-state={item.state}>
          <i style={{ '--wm-color': `var(--wm-util-${item.state})` } as React.CSSProperties} />
          {item.label}
        </span>
      ))}
      <span className="map-v2-legend__sep" aria-hidden="true" />
      {STATE_ITEMS.map((item) => (
        <span className="map-v2-legend__item" key={item.state} data-state={item.state}>
          <i
            className={item.dashed ? 'is-dashed' : undefined}
            style={
              {
                '--wm-color': `var(--wm-state-${item.state === 'no-data' ? 'no-data' : item.state})`,
              } as React.CSSProperties
            }
          />
          {item.label}
        </span>
      ))}
      <span className="map-v2-legend__sep" aria-hidden="true" />
      <span className="map-v2-legend__item" data-sense="a2b">
        <i className="is-solid" />
        A→B sólido
      </span>
      <span className="map-v2-legend__item" data-sense="b2a">
        <i className="is-dimmed" />
        B→A esmaecido
      </span>
      <span className="map-v2-legend__item map-v2-legend__item--center">
        <i className="is-center" />
        troca de sentido no centro
      </span>
      <span className="map-v2-legend__sep" aria-hidden="true" />
      <span className="map-v2-legend__flow" data-mode={animation}>
        <span aria-hidden="true" />
        <small style={{ fontSize: 9, color: '#647882' }}>ANIMAÇÃO</small>
        <strong style={{ fontWeight: 620, color: '#93a7b1' }}>
          {LINK_V2_ANIMATION_LABELS[animation]}
        </strong>
        <span aria-hidden="true" />
      </span>
    </div>
  );
}
