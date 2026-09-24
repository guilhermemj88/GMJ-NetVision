'use client';

import type { PhysicalVisualMode } from './physical-types';

interface Props {
  mode: PhysicalVisualMode;
  onChange: (mode: PhysicalVisualMode) => void;
}

/**
 * Alternância **Técnica ↔ Real** do módulo físico.
 *
 * A visão técnica é a principal do módulo (primeira opção e selecionada por
 * padrão). O modo real continua disponível como alternativa/fallback e não
 * muda nada além do desenho do painel.
 */
export function PhysicalVisualToggle({ mode, onChange }: Props) {
  return (
    <div className="physical-visual" aria-label="Visualização do rack">
      <span>VISUALIZAÇÃO</span>
      <div className="physical-visual__options" role="group">
        <button
          type="button"
          className={mode === 'TECHNICAL' ? 'is-active' : ''}
          aria-pressed={mode === 'TECHNICAL'}
          onClick={() => onChange('TECHNICAL')}
        >
          Técnica
        </button>
        <button
          type="button"
          className={mode === 'REAL' ? 'is-active' : ''}
          aria-pressed={mode === 'REAL'}
          onClick={() => onChange('REAL')}
        >
          Real
        </button>
      </div>
    </div>
  );
}
