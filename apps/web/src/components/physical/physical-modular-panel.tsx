'use client';

import type { ReactNode } from 'react';
import type { FrontPanelBoxPx } from './front-panel-image-map';
import { type ModularChassisMap, chassisSlotMapFor } from './modular-chassis-map';

/** Visão de um slot do chassi para renderização (nada é inventado aqui). */
export interface ModularSlotView {
  slotId: string;
  ordinal: number;
  label: string;
  occupied: boolean;
  moduleName?: string | null;
  /** Imagem própria da placa, quando existir (senão usa o fallback geométrico). */
  moduleImage?: string | null;
}

interface Props {
  map: ModularChassisMap;
  slots: readonly ModularSlotView[];
  /** Tamanho em pixels do painel (a MESMA caixa usada pelos anchors). */
  panelSize: { width: number; height: number };
  /** Desenha bbox/ordinal dos slots (toggle "Mostrar slots" na preview). */
  showSlots?: boolean;
  /** Visão técnica: moldura reforçada e rótulo do slot sempre visível. */
  isTechnical?: boolean;
  /** Mostra o rótulo amigável do slot (`Slot 1 · Serviço/Uplink`). */
  showSlotLabels?: boolean;
  selectedSlotId?: string | null;
  onSelectSlot?: (slotId: string) => void;
  /** Conteúdo da placa quando ela não tem imagem própria. */
  renderModule?: (slot: ModularSlotView, slotBox: FrontPanelBoxPx) => ReactNode;
}

/**
 * Painel de chassi modular.
 *
 * O chassi **não** possui porta de serviço própria: a imagem (ou a moldura
 * lógica dos slots) é aparência, e cada slot é um hitbox posicionado pelo mapa
 * normalizado. A placa instalada é desenhada dentro do slot — com imagem
 * própria quando existir, senão pelo renderer geométrico do módulo.
 *
 * Vale para os quatro modos: imagem exata/aproximada (com `<img>`) e lógico
 * (somente slots), sempre sem inventar conectores.
 */
export function PhysicalModularPanel({
  map,
  slots,
  panelSize,
  showSlots = false,
  isTechnical = false,
  showSlotLabels = false,
  selectedSlotId = null,
  onSelectSlot,
  renderModule,
}: Props) {
  const slotBoxOf = (bbox: { x: number; y: number; width: number; height: number }): FrontPanelBoxPx => ({
    left: bbox.x * panelSize.width,
    top: bbox.y * panelSize.height,
    width: bbox.width * panelSize.width,
    height: bbox.height * panelSize.height,
  });

  return (
    <div
      className={`physical-modular-panel ${map.image ? 'has-image' : 'is-logical'} ${
        showSlots ? 'is-slots-visible' : ''
      } ${isTechnical ? 'is-technical' : ''}`}
      data-chassis-panel={map.catalogKey}
      data-mapping-mode={map.mappingMode}
      data-chassis-image-status={map.imageStatus}
      data-slot-count={map.slots.length}
    >
      {map.image ? (
        <img
          className="physical-modular-panel__image"
          src={map.image}
          width={map.naturalWidth}
          height={map.naturalHeight}
          alt={`Chassi ${map.model}`}
          draggable={false}
        />
      ) : null}

      {map.slots.map((mapped) => {
        const view = slots.find((slot) => slot.ordinal === mapped.ordinal) ?? null;
        const occupied = Boolean(view?.occupied);
        const box = slotBoxOf(mapped.bbox);
        const moduleTitle = occupied
          ? `${view?.label || `Slot ${mapped.ordinal}`} · ${view?.moduleName ?? 'placa instalada'}`
          : `${view?.label || `Slot ${mapped.ordinal}`} · vazio`;

        return (
          <div
            key={mapped.slotKey}
            className={[
              'physical-modular-panel__slot',
              occupied ? 'is-occupied' : 'is-empty',
              selectedSlotId && view && selectedSlotId === view.slotId ? 'is-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              left: `${mapped.bbox.x * 100}%`,
              top: `${mapped.bbox.y * 100}%`,
              width: `${mapped.bbox.width * 100}%`,
              height: `${mapped.bbox.height * 100}%`,
            }}
            data-slot-key={mapped.slotKey}
            data-slot-ordinal={mapped.ordinal}
            data-slot-id={view?.slotId ?? ''}
            data-slot-state={occupied ? 'OCCUPIED' : 'EMPTY'}
            title={moduleTitle}
            onClick={
              onSelectSlot && view
                ? (event) => {
                    event.stopPropagation();
                    onSelectSlot(view.slotId);
                  }
                : undefined
            }
          >
            {/* Slot limpo por padrão; bbox/ordinal só no modo de inspeção. */}
            {showSlotLabels && !showSlots ? (
              <em className="physical-modular-panel__slot-label" aria-hidden="true">
                {view?.label ?? `Slot ${mapped.ordinal}`}
              </em>
            ) : null}
            {showSlots ? (
              <em className="physical-modular-panel__ordinal" aria-hidden="true">
                {mapped.ordinal}
              </em>
            ) : null}
            {occupied && view?.moduleImage ? (
              <img
                className="physical-modular-panel__module-image"
                src={view.moduleImage}
                alt={view.moduleName ?? `Placa do slot ${mapped.ordinal}`}
                draggable={false}
              />
            ) : null}
            {occupied && !view?.moduleImage && renderModule && view ? renderModule(view, box) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Slot do mapa usado por um slot físico — reexport para os consumidores. */
export { chassisSlotMapFor };
