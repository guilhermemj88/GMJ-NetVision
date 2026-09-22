'use client';

import type { PhysicalPort } from '@gmj/shared';
import { PORT_STATE_LABELS } from './physical-catalog';
import type { PlacedConnector } from './physical-panel-layout';

interface Props {
  port: PhysicalPort;
  placed: PlacedConnector;
  /** px por unidade de grade do painel */
  scale: number;
  selected: boolean;
  inPath: boolean;
  /** Diagnóstico da preview: destaca conectores com bbox sobreposto. */
  overlap?: boolean;
  onSelect: (id: string) => void;
}

/**
 * Um conector do painel frontal.
 *
 * A geometria vem do `PlacedConnector` (grade normalizada) e é convertida para
 * pixels com a mesma escala usada para ancorar os cabos — o cabo sempre sai da
 * porta desenhada, nunca de uma posição aproximada por índice.
 */
export function PhysicalPortShape({
  port,
  placed,
  scale,
  selected,
  inPath,
  overlap = false,
  onSelect,
}: Props) {
  const width = Math.max(7, Math.round(placed.shape.width * scale));
  const height = Math.max(7, Math.round(placed.shape.height * scale));
  const title = [
    port.name,
    placed.shape.label,
    port.label && port.label !== port.name ? port.label : null,
    PORT_STATE_LABELS[port.state],
    port.mappedInterface ? `Interface ${port.mappedInterface.name}` : null,
    port.lldp ? `LLDP ${port.lldp.remoteHostname}/${port.lldp.remotePortName}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      data-port-id={port.id}
      data-connector={placed.kind}
      className={[
        'physical-port',
        `physical-port--${placed.kind.toLowerCase()}`,
        `state-${port.state.toLowerCase()}`,
        selected || inPath ? 'is-selected' : '',
        overlap ? 'is-overlap' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: placed.x * scale,
        top: placed.y * scale,
        width,
        height,
      }}
      title={title}
      aria-label={`Porta ${port.name} (${placed.shape.label})`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(port.id);
      }}
    >
      <span />
      {port.lldp ? <i className="physical-port__lldp" aria-hidden="true" /> : null}
    </button>
  );
}
