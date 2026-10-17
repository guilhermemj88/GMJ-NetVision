'use client';

/**
 * MAP-VISUAL-V2 — Fase G: legenda do enlace bidirecional (Fase M: ciente do
 * estilo A/B do preview).
 *
 * Só aparece no modo V2 (a V1 mantém o rodapé dela intacto). As cores vêm dos
 * MESMOS tokens usados pelo traço, pelas setas e pelas plaquetas (`--wm-*`),
 * então legenda e mapa não divergem:
 *  - DIRECIONAL (padrão): a DIREÇÃO é fixa (A→B ciano, B→A violeta) e a
 *    plaqueta é a única que muda com a utilização;
 *  - WEATHERMAP (utilização, valor interno `operational`): cada metade tem a cor
 *    da SUA utilização (verde-sálvia <50%, âmbar fosco 50–79%, coral fosco ≥80%)
 *    na linha, na seta e na borda da plaqueta; o sentido continua explícito pela
 *    forma da seta;
 *  - em ambos, estados operacionais anômalos mantêm tracejado e cor semântica.
 */

import type { CSSProperties } from 'react';
import { useLinkV2StyleMode } from '@/lib/map-visual-v2-style';
import {
  LINK_V2_ANIMATION_LABELS,
  WEATHER_OPERATIONAL_COLOR_VAR,
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

const OPERATIONAL_ITEMS = [
  { key: 'normal', label: '<50% verde-sálvia', token: WEATHER_OPERATIONAL_COLOR_VAR.normal },
  { key: 'attention', label: '50–79% âmbar', token: WEATHER_OPERATIONAL_COLOR_VAR.attention },
  { key: 'critical', label: '≥80% coral', token: WEATHER_OPERATIONAL_COLOR_VAR.critical },
] as const;

export function MapV2Legend({ animation }: { animation: LinkV2AnimationMode }) {
  const style = useLinkV2StyleMode();
  const operational = style === 'operational';

  return (
    <div
      className="map-v2-legend"
      data-link-style={style}
      role="note"
      aria-label="Legenda dos enlaces (V2)"
    >
      {operational ? (
        <>
          <span className="map-v2-legend__item map-v2-legend__item--center">
            WeatherMap: cor = utilização de cada sentido
          </span>
          <span className="map-v2-legend__item" data-direction="a2b">
            <i className="is-solid" />
            A→B (seta cheia)
          </span>
          <span className="map-v2-legend__item" data-direction="b2a">
            <i className="is-chevron" />
            B→A (chevron)
          </span>
        </>
      ) : (
        <>
          <span className="map-v2-legend__item" data-direction="a2b">
            <i className="is-solid" />
            Direcional: A→B ciano (seta cheia)
          </span>
          <span className="map-v2-legend__item" data-direction="b2a">
            <i className="is-chevron" />
            B→A roxa (chevron)
          </span>
          <span className="map-v2-legend__item map-v2-legend__item--center">
            <i className="is-center" />
            sentidos se encontram no centro
          </span>
        </>
      )}
      <span className="map-v2-legend__sep" aria-hidden="true" />
      {operational ? (
        OPERATIONAL_ITEMS.map((item) => (
          <span className="map-v2-legend__item" key={item.key} data-op-band={item.key}>
            <i style={{ '--wm-color': item.token } as CSSProperties} />
            {item.label}
          </span>
        ))
      ) : (
        <>
          <span className="map-v2-legend__item" data-pill="normal">
            <i className="is-pill is-normal" />
            &lt;50% na cor do sentido
          </span>
          <span className="map-v2-legend__item" data-pill="attention">
            <i className="is-pill" style={{ '--wm-color': 'var(--wm-util-attention)' } as CSSProperties} />
            50–79% âmbar
          </span>
          <span className="map-v2-legend__item" data-pill="critical">
            <i className="is-pill" style={{ '--wm-color': 'var(--wm-util-critical)' } as CSSProperties} />
            ≥80% crítico
          </span>
        </>
      )}
      <span className="map-v2-legend__sep" aria-hidden="true" />
      {STATE_ITEMS.map((item) => (
        <span className="map-v2-legend__item" key={item.state} data-state={item.state}>
          <i
            className="is-dashed"
            style={{ '--wm-color': item.color } as CSSProperties}
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
