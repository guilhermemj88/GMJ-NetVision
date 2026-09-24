'use client';

import type { PhysicalPort } from '@gmj/shared';
import { PORT_STATE_LABELS } from './physical-catalog';
import type { PlacedConnector } from './physical-panel-layout';

interface Props {
  port: PhysicalPort;
  placed: PlacedConnector;
  /** px por unidade de grade do painel (eixo horizontal) */
  scale: number;
  /** px por unidade de grade no eixo vertical (padrão: o mesmo de `scale`). */
  scaleY?: number;
  selected: boolean;
  inPath: boolean;
  /** A outra ponta do cabo desta porta está selecionada: destaque do par. */
  related?: boolean;
  /**
   * Rótulo curto desenhado dentro do conector (visão técnica). Só aparece
   * quando o conector tem largura suficiente para o texto não colidir.
   */
  label?: string | null;
  /**
   * Nome apresentado ao usuário (interface CLI quando existir). Nunca cai para
   * o rótulo do cage: quando não há interface, continua o nome persistido.
   */
  displayName?: string;
  /** Rótulo físico do painel/cage quando difere do nome apresentado (`QSFP28-1`). */
  panelLabel?: string | null;
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
  scaleY,
  selected,
  inPath,
  related = false,
  label = null,
  displayName,
  panelLabel = null,
  overlap = false,
  onSelect,
}: Props) {
  const yScale = scaleY ?? scale;
  const width = Math.max(7, Math.round(placed.shape.width * scale));
  const height = Math.max(7, Math.round(placed.shape.height * yScale));
  // Rótulo só cabe a partir de ~11px: abaixo disso o texto colidiria com o vizinho.
  const visibleLabel = label && width >= 11 ? label : null;
  /** Identidade apresentada: interface CLI > catálogo > nome persistido. */
  const primary = displayName?.trim() || port.name;
  const connector = placed.shape.label;
  const title = [
    primary,
    `Conector ${connector}`,
    panelLabel ? `Painel físico ${panelLabel}` : null,
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
        related ? 'is-related' : '',
        overlap ? 'is-overlap' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: placed.x * scale,
        top: placed.y * yScale,
        width,
        height,
      }}
      title={title}
      aria-label={`Porta ${primary} (conector ${connector})`}
      data-port-name={port.name}
      data-port-display-name={primary}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(port.id);
      }}
    >
      <span />
      {visibleLabel ? (
        <em className="physical-port__label" aria-hidden="true">
          {visibleLabel}
        </em>
      ) : null}
      {port.lldp ? <i className="physical-port__lldp" aria-hidden="true" /> : null}
    </button>
  );
}
