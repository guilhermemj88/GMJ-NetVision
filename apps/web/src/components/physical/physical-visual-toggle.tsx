'use client';

import type { PhysicalVisualMode } from './physical-types';

interface Props {
  mode: PhysicalVisualMode;
  onChange: (mode: PhysicalVisualMode) => void;
}

/**
 * Alternância **Real ↔ Técnica** do módulo físico.
 *
 * O modo real continua sendo o padrão; o modo técnico é adicional e só muda o
 * desenho dos modelos com renderer técnico declarado (protótipo controlado).
 */
export function PhysicalVisualToggle({ mode, onChange }: Props) {
  return (
    <div className="physical-visual" aria-label="Visualização do rack">
      <span>VISUALIZAÇÃO</span>
      <div className="physical-visual__options" role="group">
        <button
          type="button"
          className={mode === 'REAL' ? 'is-active' : ''}
          aria-pressed={mode === 'REAL'}
          onClick={() => onChange('REAL')}
        >
          Real
        </button>
        <button
          type="button"
          className={mode === 'TECHNICAL' ? 'is-active' : ''}
          aria-pressed={mode === 'TECHNICAL'}
          onClick={() => onChange('TECHNICAL')}
        >
          Técnica
        </button>
      </div>
    </div>
  );
}
