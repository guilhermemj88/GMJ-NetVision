'use client';

import { useMemo, useState } from 'react';
import { PhysicalImagePanel } from './physical-image-panel';
import { connectorTally } from './front-panel-image-map';
import { moduleImageBoxInSlot } from './modular-chassis-map';
import {
  type ModuleFrontPanelMap,
  moduleFrontPanelAspectRatio,
  moduleFrontPanelImageMap,
  overlappingModulePortPairs,
  validateModuleFrontPanelMap,
} from './module-front-panel-map';

/** Largura (px) do painel desenhado no card. */
const MODULE_IMAGE_WIDTH = 360;
/** Slot genérico usado só para demonstrar o encaixe (não é compatibilidade). */
const DEMO_SLOT = { width: 360, height: 96 };

interface Props {
  map: ModuleFrontPanelMap;
  /** Toggle global "Mostrar slots/hitboxes" da preview. */
  debugHitboxes: boolean;
}

/**
 * Card de uma **placa** com painel frontal por imagem.
 *
 * O mapa é declarado (imagem + hotspots normalizados) mesmo sem template de
 * módulo no catálogo: por isso as portas aparecem como *não resolvidas* até
 * existir o `PhysicalPort` correspondente. A imagem da placa **não** afirma
 * compatibilidade com nenhum chassi — o encaixe é só demonstração de desenho.
 */
export function PhysicalModuleMapCard({ map, debugHitboxes }: Props) {
  const [showFit, setShowFit] = useState(false);

  const issues = useMemo(() => validateModuleFrontPanelMap(map), [map]);
  const overlaps = useMemo(() => overlappingModulePortPairs(map), [map]);
  const tally = useMemo(() => [...connectorTally(map).entries()], [map]);

  const aspect = moduleFrontPanelAspectRatio(map);
  const panelHeight = MODULE_IMAGE_WIDTH / aspect;
  const imageMap = moduleFrontPanelImageMap(map);
  const fit = moduleImageBoxInSlot(
    { left: 0, top: 0, width: DEMO_SLOT.width, height: DEMO_SLOT.height },
    aspect,
  );

  return (
    <article className="physical-preview-card is-image-panel" data-module-card={map.moduleKey}>
      <header className="physical-preview-card__head">
        <div>
          <b>{map.label}</b>
          <small>
            {map.partNumber ? `${map.partNumber} · ` : ''}
            {map.family}
          </small>
        </div>
      </header>

      <dl className="physical-preview-card__meta">
        <div>
          <dt>moduleKey</dt>
          <dd>{map.moduleKey}</dd>
        </div>
        <div>
          <dt>Portas/hotspots</dt>
          <dd className={issues.length ? 'is-warn' : ''}>
            {map.ports.length}/{map.expectedPortCount}
            {issues.length ? ' ⚠' : ''}
          </dd>
        </div>
        <div>
          <dt>Layout</dt>
          <dd>{`IMAGE · ${map.mappingMode}`}</dd>
        </div>
        <div>
          <dt>Overlap</dt>
          <dd className={overlaps.length ? 'is-error' : ''}>{overlaps.length}</dd>
        </div>
        <div>
          <dt>Conectores</dt>
          <dd>{tally.length ? tally.map(([key, count]) => `${key} ${count}`).join(' · ') : '—'}</dd>
        </div>
      </dl>

      {issues.length ? (
        <p className="physical-preview-card__warning is-error">{issues.join(' · ')}</p>
      ) : null}

      <div className="physical-preview-card__panel is-image">
        <div
          className="physical-preview-card__image"
          style={{ width: MODULE_IMAGE_WIDTH, height: panelHeight }}
        >
          <PhysicalImagePanel map={imageMap} ports={[]} debug={debugHitboxes} />
        </div>
        <p className="physical-preview-card__hint">
          {map.ports.length} hotspots · imagem{' '}
          {map.imageStatus === 'APPROVED' ? 'aprovada' : 'gerada (não é a foto oficial)'} · sem
          template de módulo no catálogo (hotspots não resolvidos)
        </p>
      </div>

      <label className="physical-preview-card__fit-toggle">
        <input
          type="checkbox"
          checked={showFit}
          onChange={(event) => setShowFit(event.target.checked)}
        />
        Encaixe no slot (demonstração)
      </label>

      {showFit ? (
        <div
          className="physical-preview-card__demo-slot"
          style={{ width: DEMO_SLOT.width, height: DEMO_SLOT.height }}
          data-demo-slot="1"
        >
          <div
            className="physical-preview-card__demo-module"
            style={{
              left: fit.offset.left,
              top: fit.offset.top,
              width: fit.box.width,
              height: fit.box.height,
            }}
          >
            <img src={map.image} alt={`Placa ${map.label} no slot`} draggable={false} />
          </div>
        </div>
      ) : null}

      {map.note ? <p className="physical-preview-card__note">{map.note}</p> : null}
    </article>
  );
}
