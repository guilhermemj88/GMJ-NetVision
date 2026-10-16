'use client';

/**
 * MAP-VISUAL-V2 — Fase G: legenda do enlace bidirecional.
 *
 * Só aparece no modo V2 (a V1 mantém o rodapé dela intacto). As cores vêm dos
 * MESMOS tokens usados pelo traço, pelas setas e pelas plaquetas (`--wm-*`),
 * então legenda e mapa não divergem:
 *  - DIREÇÃO é fixa (A→B ciano, B→A violeta);
 *  - PLAQUETA é a única que muda com a utilização (direção → âmbar → coral);
 *  - estados operacionais anômalos mantêm tracejado e cor semântica próprios.
 */

import {
  LINK_V2_ANIMATION_LABELS,
  type LinkV2AnimationMode,
} from '@/lib/map-visual-v2-weathermap';

interface StateItem {
  label: string;
  state: string;
  color: string;
}

const STATE_ITEMS: readonly StateItem[] = [
  { label: 'DOWN', state: 'down', color: 'var(--wm-state-down)' },
  { label: 'Sem dados', state: 'no-data', color: 'var(--wm-state-no-data)' },
  { label: 'Stale', state: 'stale', color: 'var(--wm-state-stale)' },
  { label: 'Inconsistente / parcial', state: 'inconsistent', color: 'var(--wm-state-inconsistent)' },
];

export function MapV2Legend({ animation }: { animation: LinkV2AnimationMode }) {
  return (
    <div className="map-v2-legend" role="note" aria-label="Legenda dos enlaces (V2)">
      <span className="map-v2-legend__item" data-direction="a2b">
        <i className="is-solid" />
        A→B ciano (seta cheia)
      </span>
      <span className="map-v2-legend__item" data-direction="b2a">
        <i className="is-chevron" />
        B→A roxa (chevron)
      </span>
      <span className="map-v2-legend__item map-v2-legend__item--center">
        <i className="is-center" />
        sentidos se encontram no centro
      </span>
      <span className="map-v2-legend__sep" aria-hidden="true" />
      <span className="map-v2-legend__item" data-pill="normal">
        <i className="is-pill is-normal" />
        &lt;50% na cor do sentido
      </span>
      <span className="map-v2-legend__item" data-pill="attention">
        <i className="is-pill" style={{ '--wm-color': 'var(--wm-util-attention)' } as React.CSSProperties} />
        50–79% âmbar
      </span>
      <span className="map-v2-legend__item" data-pill="critical">
        <i className="is-pill" style={{ '--wm-color': 'var(--wm-util-critical)' } as React.CSSProperties} />
        ≥80% crítico
      </span>
      <span className="map-v2-legend__sep" aria-hidden="true" />
      {STATE_ITEMS.map((item) => (
        <span className="map-v2-legend__item" key={item.state} data-state={item.state}>
          <i
            className="is-dashed"
            style={{ '--wm-color': item.color } as React.CSSProperties}
          />
          {item.label}
        </span>
      ))}
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
