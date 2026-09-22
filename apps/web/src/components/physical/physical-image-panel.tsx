'use client';

import type { PhysicalPort } from '@gmj/shared';
import { PORT_STATE_LABELS } from './physical-catalog';
import type { FrontPanelImageMap, FrontPanelPortMap } from './front-panel-image-map';
import { normalizedPortAnchor, resolveMappedPhysicalPort } from './front-panel-image-map';

const OPER_STATUS_LABELS: Record<string, string> = {
  UP: 'UP',
  DOWN: 'DOWN',
  DISABLED: 'DISABLED',
  WARNING: 'WARNING',
  UNKNOWN: 'UNKNOWN',
};

interface Props {
  map: FrontPanelImageMap;
  /**
   * Portas já materializadas do equipamento (as mesmas `PhysicalPort` do módulo
   * Físico). A imagem apenas aponta para elas — nada é criado aqui.
   */
  ports: readonly PhysicalPort[];
  selectedPortId?: string | null;
  /** Portas que participam do caminho selecionado (destaque). */
  pathPortIds?: ReadonlySet<string> | null;
  /** Debug visual: desenha bounding boxes e âncoras para conferência. */
  debug?: boolean;
  /** Ausente = somente leitura (preview do catálogo). */
  onSelectPort?: (id: string) => void;
}

function portTitle(port: PhysicalPort | null, mapped: FrontPanelPortMap): string {
  if (!port) return `${mapped.portName} · porta física não encontrada no template`;
  return [
    port.name,
    port.mappedInterface?.name ?? 'sem interface mapeada',
    PORT_STATE_LABELS[port.state],
    port.operStatus ? (OPER_STATUS_LABELS[port.operStatus] ?? port.operStatus) : 'sem operStatus',
    port.lldp ? `LLDP ${port.lldp.remoteHostname}/${port.lldp.remotePortName}` : null,
    port.connectionId ? 'cabo conectado' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Painel frontal por imagem.
 *
 * A imagem é **somente aparência**: cada conector é um hitbox invisível posicionado
 * pelo bbox normalizado do mapa. O clique seleciona a `PhysicalPort` real, o
 * tooltip mostra a interface já mapeada pelo sync e a âncora do cabo é o centro
 * do MESMO bbox (visual = hitbox = ponto de clique = âncora do cabo).
 */
export function PhysicalImagePanel({
  map,
  ports,
  selectedPortId = null,
  pathPortIds = null,
  debug = false,
  onSelectPort,
}: Props) {
  if (!map.image) return null;

  return (
    <div
      className={`physical-image-panel ${debug ? 'is-debug' : ''}`}
      data-image-panel={map.catalogKey}
      data-image-panel-status={map.status}
      data-hotspots={map.ports.length}
    >
      <img
        className="physical-image-panel__image"
        src={map.image}
        width={map.naturalWidth}
        height={map.naturalHeight}
        alt={`Painel frontal do ${map.model}`}
        draggable={false}
      />

      {map.ports.map((mapped) => {
        const port = resolveMappedPhysicalPort(ports, mapped);
        const bbox = mapped.bbox;
        const anchor = normalizedPortAnchor(bbox);
        const state = port?.state ?? 'FREE';
        const oper = port?.operStatus ?? null;
        const selected = Boolean(port && selectedPortId === port.id);
        const inPath = Boolean(port && pathPortIds?.has(port.id));
        return (
          <button
            key={mapped.portName}
            type="button"
            className={[
              'physical-image-panel__hitbox',
              `state-${state.toLowerCase()}`,
              oper ? `is-oper-${oper.toLowerCase()}` : '',
              selected ? 'is-selected' : '',
              inPath ? 'is-path' : '',
              port ? '' : 'is-unresolved',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              left: `${bbox.x * 100}%`,
              top: `${bbox.y * 100}%`,
              width: `${bbox.width * 100}%`,
              height: `${bbox.height * 100}%`,
            }}
            data-port-name={mapped.portName}
            data-port-id={port?.id ?? ''}
            data-connector={mapped.connector}
            data-anchor-x={anchor.x}
            data-anchor-y={anchor.y}
            data-state={state}
            data-oper-status={oper ?? 'UNKNOWN'}
            title={portTitle(port, mapped)}
            aria-label={`Porta ${mapped.portName}`}
            onClick={
              onSelectPort
                ? (event) => {
                    event.stopPropagation();
                    if (port) onSelectPort(port.id);
                  }
                : undefined
            }
          >
            {/* Sem debug o DOM fica limpo: só a imagem e os hitboxes invisíveis. */}
            {debug ? (
              <>
                <span className="physical-image-panel__anchor" aria-hidden="true" />
                {/* rótulo só quando cabe: nas fileiras densas ele poluiria a imagem */}
                {bbox.width >= 0.03 ? (
                  <em className="physical-image-panel__tag">{mapped.portName}</em>
                ) : null}
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
