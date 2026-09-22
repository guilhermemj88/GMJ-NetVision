'use client';

import { useMemo, useState } from 'react';
import type { PhysicalCatalogEntry } from '@gmj/shared';
import { useQuery } from '@tanstack/react-query';
import { getPhysicalCatalog } from '@/lib/api';
import { PhysicalImagePanel } from './physical-image-panel';
import { PhysicalModularPanel } from './physical-modular-panel';
import { PhysicalPortShape } from './physical-port-shape';
import {
  type ModularChassisMap,
  chassisAspectRatio,
  chassisRenderMode,
  mappedCatalogSlots,
  modularChassisMap,
  overlappingChassisSlotPairs,
  validateModularChassisMap,
} from './modular-chassis-map';
import {
  frontPanelImageMap,
  frontPanelMapStatus,
  overlappingMapPairs,
  resolvedMapPorts,
  validateFrontPanelMap,
} from './front-panel-image-map';
import { buildPanelLayout, findPanelOverlaps, type PanelLayout } from './physical-panel-layout';
import {
  PANEL_LAYOUT_MODE_LABELS,
  layoutWarning,
  panelFidelity,
  panelLayoutMode,
  previewModule,
  previewModuleLayout,
  previewPorts,
  previewSlots,
  type PanelFidelity,
  type PanelLayoutMode,
} from './physical-panel-preview';

/** Escala fixa do preview (px por unidade de grade). */
const PREVIEW_SCALE = 6;
const PREVIEW_IDENTITY_HEIGHT = 26;
/** Largura da imagem no card (px): define a altura pela proporção natural. */
const PREVIEW_IMAGE_WIDTH = 268;

const FIDELITY_LABELS: Record<PanelFidelity, string> = {
  IMAGE: 'IMAGE PANEL',
  EXACT: 'EXACT',
  APPROX: 'APPROX',
  LOGICAL: 'LOGICAL',
};
interface PanelRender {
  layout: PanelLayout;
  overlaps: Set<string>;
  overlapPairs: number;
  scale: number;
  expected: number;
  rendered: number;
}

function renderPanel(
  entry: PhysicalCatalogEntry,
  moduleKey: string | null,
  scale = PREVIEW_SCALE,
): PanelRender {
  const catalogModule = moduleKey
    ? (entry.modules.find((module) => module.key === moduleKey) ?? null)
    : null;
  const layout = catalogModule
    ? previewModuleLayout(entry, catalogModule)
    : buildPanelLayout({
        ports: previewPorts(entry),
        slots: previewSlots(entry),
        modules: [],
        entry,
      });
  const overlaps = findPanelOverlaps(layout);
  return {
    layout,
    overlaps: overlaps.ids,
    overlapPairs: overlaps.pairs,
    scale,
    expected: catalogModule ? catalogModule.ports.length : entry.ports.length,
    rendered: layout.connectors.length,
  };
}

interface CardProps {
  entry: PhysicalCatalogEntry;
  /** Escala maior usada no modal de zoom. */
  zoom?: boolean;
  moduleKey?: string | null;
  /** Debug: desenha as hitboxes e as âncoras do painel por imagem. */
  debugHitboxes?: boolean;
  onOpen?: (catalogKey: string) => void;
}

/** Um card da galeria: identidade + selo de fidelidade + painel renderizado. */
export function PhysicalPanelPreviewCard({
  entry,
  zoom = false,
  moduleKey = null,
  debugHitboxes = false,
  onOpen,
}: CardProps) {
  const scale = zoom ? PREVIEW_SCALE * 1.8 : PREVIEW_SCALE;
  const render = useMemo(() => renderPanel(entry, moduleKey, scale), [entry, moduleKey, scale]);
  /** Seleção local da preview: nenhuma entidade é criada, nada é persistido. */
  const [selectedPortId, setSelectedPortId] = useState<string | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const ports = useMemo(
    () => (moduleKey ? previewModulePorts(entry, moduleKey) : previewPorts(entry)),
    [entry, moduleKey],
  );
  const mode = panelLayoutMode(entry);
  const fidelity = panelFidelity(mode);
  const warning = layoutWarning(entry);
  const mismatch = render.expected !== render.rendered;
  const map = frontPanelImageMap(entry.catalogKey);
  const awaitingImage =
    !map && frontPanelMapStatus(entry.catalogKey) === 'AWAITING_APPROVED_IMAGE'
      ? frontPanelMapStatus(entry.catalogKey)
      : null;
  const imageIssues = useMemo(() => (map ? validateFrontPanelMap(map) : []), [map]);
  const imageOverlaps = useMemo(() => (map ? overlappingMapPairs(map) : []), [map]);
  const resolved = useMemo(() => (map ? resolvedMapPorts(entry, map) : []), [entry, map]);
  const chassisMap = useMemo(() => modularChassisMap(entry.catalogKey), [entry.catalogKey]);
  const chassisIssues = useMemo(
    () => (chassisMap ? validateModularChassisMap(chassisMap) : []),
    [chassisMap],
  );
  const chassisSlotOverlaps = useMemo(
    () => (chassisMap ? overlappingChassisSlotPairs(chassisMap) : []),
    [chassisMap],
  );
  const chassisSlots = useMemo(
    () => (chassisMap ? mappedCatalogSlots(entry, chassisMap) : []),
    [chassisMap, entry],
  );
  const imageWidth = zoom ? PREVIEW_IMAGE_WIDTH * 2.2 : PREVIEW_IMAGE_WIDTH;

  return (
    <article
      className={`physical-preview-card ${zoom ? 'is-zoom' : ''} ${
        map || chassisMap ? 'is-image-panel' : ''
      }`}
      data-catalog-key={entry.catalogKey}
      data-layout-mode={mode}
      data-image-panel={map ? map.catalogKey : ''}
      data-chassis-panel={chassisMap ? chassisMap.catalogKey : ''}
    >
      <header className="physical-preview-card__head">
        <div>
          <strong>{entry.manufacturer}</strong>
          <span>{entry.model || entry.name}</span>
        </div>
        <div className="physical-preview-card__badges">
          <b className={`physical-preview-badge is-${fidelity.toLowerCase()}`}>
            {FIDELITY_LABELS[fidelity]}
          </b>
          <small>{entry.family || entry.category}</small>
        </div>
      </header>

      <dl className="physical-preview-card__meta">
        <div>
          <dt>catalogKey</dt>
          <dd>{entry.catalogKey}</dd>
        </div>
        <div>
          <dt>Altura</dt>
          <dd>{entry.heightU}U</dd>
        </div>
        <div>
          <dt>Layout</dt>
          <dd>{PANEL_LAYOUT_MODE_LABELS[mode]}</dd>
        </div>
        <div>
          <dt>{map ? 'Portas/hotspots' : 'Portas'}</dt>
          <dd className={mismatch || (map && imageIssues.length) ? 'is-warn' : ''}>
            {map ? `${resolved.length}/${map.ports.length}` : `${render.rendered}/${render.expected}`}
            {mismatch || (map && imageIssues.length) ? ' ⚠' : ''}
          </dd>
        </div>
        {chassisMap ? (
          <div>
            <dt>Service slots</dt>
            <dd className={chassisIssues.length ? 'is-warn' : ''}>
              {chassisMap.serviceSlotCount}
            </dd>
          </div>
        ) : null}
        {chassisMap ? (
          <div>
            <dt>Slots</dt>
            <dd className={chassisSlots.length !== chassisMap.serviceSlotCount ? 'is-warn' : ''}>
              {chassisSlots.length}/{chassisMap.serviceSlotCount}
              {chassisSlots.length !== chassisMap.serviceSlotCount ? ' ⚠' : ''}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Overlap</dt>
          <dd className={chassisMap ? (chassisSlotOverlaps.length ? 'is-error' : '') : map ? (imageOverlaps.length ? 'is-error' : '') : render.overlapPairs ? 'is-error' : ''}>
            {chassisMap ? chassisSlotOverlaps.length : map ? imageOverlaps.length : render.overlapPairs}
          </dd>
        </div>
      </dl>

      {awaitingImage ? (
        <p className="physical-preview-card__warning is-unconfirmed">
          AWAITING APPROVED IMAGE — este modelo aguarda imagem aprovada e continua no renderer geométrico
        </p>
      ) : null}

      {warning !== 'none' ? (
        <p className={`physical-preview-card__warning is-${warning}`}>
          {warning === 'unconfirmed'
            ? 'LAYOUT NÃO CONFIRMADO — painel desenhado pelo fallback semântico'
            : 'LAYOUT APROXIMADO — geometria organizada, não é o painel oficial'}
        </p>
      ) : null}

      {chassisMap && chassisMap.image ? (
        <div className="physical-preview-card__panel is-image is-chassis">
          {chassisIssues.length ? (
            <p className="physical-preview-card__warning is-error">{chassisIssues.join(' · ')}</p>
          ) : null}
          <div
            className="physical-preview-card__image"
            style={{
              width: imageWidth,
              height: imageWidth / chassisAspectRatio(chassisMap),
            }}
          >
            <PhysicalModularPanel
              map={chassisMap}
              slots={chassisSlotViews(entry, chassisMap)}
              panelSize={{ width: imageWidth, height: imageWidth / chassisAspectRatio(chassisMap) }}
              showSlots={debugHitboxes}
              selectedSlotId={selectedSlotId}
              onSelectSlot={setSelectedSlotId}
            />
          </div>
          <p className="physical-preview-card__hint">
            {chassisRenderMode(chassisMap)} · mappingMode {chassisMap.mappingMode} · imagem{' '}
            {chassisMap.imageStatus === 'APPROVED' ? 'aprovada' : 'gerada (não é a oficial)'}
          </p>
        </div>
      ) : map ? (
        <div className="physical-preview-card__panel is-image">
          {imageIssues.length ? (
            <p className="physical-preview-card__warning is-error">{imageIssues.join(' · ')}</p>
          ) : null}
          <div
            className="physical-preview-card__image"
            style={{ width: imageWidth, height: imageWidth / (map.naturalWidth! / map.naturalHeight!) }}
          >
            <PhysicalImagePanel
              map={map}
              ports={ports}
              debug={debugHitboxes}
              selectedPortId={selectedPortId}
              onSelectPort={setSelectedPortId}
            />
          </div>
        </div>
      ) : (
        <div
          className="physical-preview-card__panel"
          style={{
            height: PREVIEW_IDENTITY_HEIGHT + 16 + render.layout.gridHeight * render.scale,
          }}
        >
          <div
            className="physical-preview-card__surface"
            style={{
              width: render.layout.width * render.scale,
              height: render.layout.gridHeight * render.scale,
            }}
          >
            {render.layout.slots.map((slot) => (
              <div
                key={slot.slotId}
                className={`physical-slot ${slot.occupied ? 'is-occupied' : ''}`}
                style={{
                  left: slot.x * render.scale,
                  top: slot.y * render.scale,
                  width: slot.width * render.scale,
                  height: slot.height * render.scale,
                }}
                title={`${slot.label || `Slot ${slot.index}`} · vazio`}
              >
                <em>{slot.index}</em>
              </div>
            ))}
            {render.layout.connectors.map((placed) => {
              const port = ports.find((candidate) => candidate.id === placed.portId);
              if (!port) return null;
              return (
                <PhysicalPortShape
                  key={port.id}
                  port={port}
                  placed={placed}
                  scale={render.scale}
                  selected={selectedPortId === port.id}
                  inPath={false}
                  overlap={render.overlaps.has(port.id)}
                  onSelect={setSelectedPortId}
                />
              );
            })}
          </div>
        </div>
      )}

      <footer className="physical-preview-card__foot">
        <small>
          {entry.category}
          {map ? ` · ${map.ports.length} hotspots` : ''}
          {chassisMap ? ` · ${chassisMap.serviceSlotCount} slots` : ''}
        </small>
        {onOpen ? (
          <button type="button" onClick={() => onOpen(entry.catalogKey)}>
            Ampliar
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function previewModulePorts(entry: PhysicalCatalogEntry, moduleKey: string | null) {
  if (!moduleKey) return [];
  const module = entry.modules.find((candidate) => candidate.key === moduleKey);
  return module ? previewModule(entry, module).module.ports : [];
}

/**
 * Slots do chassi para o painel modular.
 *
 * Slots **vazios** por padrão: o catálogo não tem line card Huawei declarada,
 * e a preview não inventa placa nenhuma.
 */
function chassisSlotViews(entry: PhysicalCatalogEntry, map: ModularChassisMap) {
  return entry.slots
    .map((slot) => ({ slot, mapped: map.slots.find((item) => item.ordinal === slot.index) }))
    .filter((item) => item.mapped !== undefined)
    .map(({ slot, mapped }) => ({
      slotId: `preview-${entry.catalogKey}-slot-${slot.index}`,
      ordinal: slot.index,
      label: slot.label || `Slot ${mapped!.ordinal}`,
      occupied: false,
      moduleName: null,
      moduleImage: null,
    }));
}

interface FilterState {
  manufacturer: string;
  query: string;
  category: string;
  mode: string;
}

/** Galeria completa do catálogo, usando o MESMO renderer do módulo Físico. */
export function PhysicalCatalogPreview() {
  const catalogQuery = useQuery({ queryKey: ['physical-catalog'], queryFn: getPhysicalCatalog });
  const [filters, setFilters] = useState<FilterState>({
    manufacturer: '',
    query: '',
    category: '',
    mode: '',
  });
  const [zoomed, setZoomed] = useState<PhysicalCatalogEntry | null>(null);
  /** Porta selecionada no modal (apenas visualização). */
  const [zoomPortId, setZoomPortId] = useState<string | null>(null);
  /** Slot selecionado no modal (apenas visualização). */
  const [zoomSlotId, setZoomSlotId] = useState<string | null>(null);
  const [moduleByKey, setModuleByKey] = useState<Record<string, string>>({});
  const [debugHitboxes, setDebugHitboxes] = useState(false);

  const entries = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const manufacturers = useMemo(
    () => [...new Set(entries.map((entry) => entry.manufacturer))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const categories = useMemo(
    () => [...new Set(entries.map((entry) => entry.category))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );

  const filtered = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filters.manufacturer && entry.manufacturer !== filters.manufacturer) return false;
      if (filters.category && entry.category !== filters.category) return false;
      if (filters.mode && panelLayoutMode(entry) !== filters.mode) return false;
      if (!query) return true;
      return [entry.manufacturer, entry.model, entry.name, entry.catalogKey, entry.family]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [entries, filters]);

  const summary = useMemo(() => {
    let overlaps = 0;
    let mismatches = 0;
    let imagePanels = 0;
    let hotspots = 0;
    for (const entry of filtered) {
      const chassis = modularChassisMap(entry.catalogKey);
      if (chassis) {
        if (chassis.image) imagePanels += 1;
        hotspots += chassis.serviceSlotCount;
        if (overlappingChassisSlotPairs(chassis).length) overlaps += 1;
        continue;
      }
      const map = frontPanelImageMap(entry.catalogKey);
      if (map) {
        imagePanels += 1;
        hotspots += map.ports.length;
        if (overlappingMapPairs(map).length) overlaps += 1;
        continue;
      }
      const render = renderPanel(entry, moduleByKey[entry.catalogKey] ?? null);
      if (render.overlapPairs) overlaps += 1;
      if (render.expected !== render.rendered) mismatches += 1;
    }
    return { overlaps, mismatches, imagePanels, hotspots };
  }, [filtered, moduleByKey]);

  const zoomRender = zoomed
    ? renderPanel(zoomed, moduleByKey[zoomed.catalogKey] ?? null, PREVIEW_SCALE * 1.8)
    : null;
  const zoomMap = zoomed ? frontPanelImageMap(zoomed.catalogKey) : null;
  const zoomChassis = zoomed ? modularChassisMap(zoomed.catalogKey) : null;
  const zoomChassisWidth = zoomMap ? 0 : PREVIEW_IMAGE_WIDTH * 3;

  return (
    <main className="physical-preview">
      <header className="physical-preview__head">
        <div>
          <h1>Preview dos painéis físicos</h1>
          <p>
            Painéis por imagem aprovada + mapa de hotspots, e{' '}
            <code>buildPanelLayout</code>/<code>PhysicalPortShape</code> como fallback geométrico.
            Nenhum POP, rack ou equipamento é criado — o catálogo é apenas lido.
          </p>
        </div>
        <div className="physical-preview__stats">
          <span>
            <b>{filtered.length}</b> painéis
          </span>
          <span>
            <b>{summary.imagePanels}</b> com imagem
          </span>
          <span>
            <b>{summary.hotspots}</b> hotspots
          </span>
          <span className={summary.overlaps ? 'is-error' : ''}>
            <b>{summary.overlaps}</b> com overlap
          </span>
          <span className={summary.mismatches ? 'is-warn' : ''}>
            <b>{summary.mismatches}</b> com contagem divergente
          </span>
          <span>
            <b>{entries.length}</b> no catálogo
          </span>
        </div>
      </header>

      <section className="physical-preview__filters">
        <div className="physical-preview__chips">
          <button
            type="button"
            className={filters.manufacturer === '' ? 'is-active' : ''}
            onClick={() => setFilters((current) => ({ ...current, manufacturer: '' }))}
          >
            Todos
          </button>
          {manufacturers.map((manufacturer) => (
            <button
              key={manufacturer}
              type="button"
              className={filters.manufacturer === manufacturer ? 'is-active' : ''}
              onClick={() => setFilters((current) => ({ ...current, manufacturer }))}
            >
              {manufacturer}
            </button>
          ))}
        </div>
        <div className="physical-preview__fields">
          <label>
            Modelo / catalogKey
            <input
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({ ...current, query: event.target.value }))
              }
              placeholder="Ex.: S6730, F1A, CRS328, MX104"
            />
          </label>
          <label>
            Tipo
            <select
              value={filters.category}
              onChange={(event) =>
                setFilters((current) => ({ ...current, category: event.target.value }))
              }
            >
              <option value="">Todos</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label>
            Layout mode
            <select
              value={filters.mode}
              onChange={(event) =>
                setFilters((current) => ({ ...current, mode: event.target.value }))
              }
            >
              <option value="">Todos</option>
              {(Object.keys(PANEL_LAYOUT_MODE_LABELS) as PanelLayoutMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <label className="physical-preview__debug">
            <input
              type="checkbox"
              checked={debugHitboxes}
              onChange={(event) => setDebugHitboxes(event.target.checked)}
            />
            Mostrar slots/hitboxes
          </label>
        </div>
      </section>

      {catalogQuery.isLoading ? <p className="physical-preview__status">Carregando catálogo…</p> : null}
      {catalogQuery.isError ? (
        <p className="physical-preview__status is-error">
          Não foi possível carregar o catálogo físico.
        </p>
      ) : null}

      <section className="physical-preview__grid">
        {filtered.map((entry) => (
          <PhysicalPanelPreviewCard
            key={entry.catalogKey}
            entry={entry}
            moduleKey={moduleByKey[entry.catalogKey] ?? null}
            debugHitboxes={debugHitboxes}
            onOpen={(catalogKey) => {
              const target = entries.find((candidate) => candidate.catalogKey === catalogKey);
              if (target) {
                setZoomPortId(null);
                setZoomed(target);
              }
            }}
          />
        ))}
      </section>

      {zoomed && zoomRender ? (
        <div
          className="physical-preview__modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomed(null)}
        >
          <div className="physical-preview__modal-body" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>
                  {zoomed.manufacturer} {zoomed.model}
                </strong>
                <small>{zoomed.catalogKey}</small>
              </div>
              <button type="button" onClick={() => setZoomed(null)}>
                Fechar
              </button>
            </header>
            {zoomed.modules.length && !zoomMap ? (
              <label className="physical-preview__modal-module">
                Placa instalada (visualização)
                <select
                  value={moduleByKey[zoomed.catalogKey] ?? ''}
                  onChange={(event) =>
                    setModuleByKey((current) => ({
                      ...current,
                      [zoomed.catalogKey]: event.target.value,
                    }))
                  }
                >
                  <option value="">Somente o chassi</option>
                  {zoomed.modules.map((module) => (
                    <option key={module.key} value={module.key}>
                      {module.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {zoomChassis && zoomChassis.image ? (
              <div
                className="physical-preview__modal-panel is-image is-chassis"
                style={{ aspectRatio: `${zoomChassis.naturalWidth} / ${zoomChassis.naturalHeight}` }}
              >
                <PhysicalModularPanel
                  map={zoomChassis}
                  slots={chassisSlotViews(zoomed, zoomChassis)}
                  panelSize={{
                    width: zoomChassisWidth,
                    height: zoomChassisWidth / chassisAspectRatio(zoomChassis),
                  }}
                  showSlots={debugHitboxes}
                  selectedSlotId={zoomSlotId}
                  onSelectSlot={setZoomSlotId}
                />
              </div>
            ) : zoomMap ? (
              <div
                className="physical-preview__modal-panel is-image"
                style={{ aspectRatio: `${zoomMap.naturalWidth} / ${zoomMap.naturalHeight}` }}
              >
                <PhysicalImagePanel
                  map={zoomMap}
                  ports={previewPorts(zoomed)}
                  debug={debugHitboxes}
                  selectedPortId={zoomPortId}
                  onSelectPort={setZoomPortId}
                />
              </div>
            ) : (
              <div
                className="physical-preview__modal-panel"
                style={{
                  width: zoomRender.layout.width * zoomRender.scale + 24,
                  height: zoomRender.layout.gridHeight * zoomRender.scale + 40,
                }}
              >
                {zoomRender.layout.connectors.map((placed) => {
                  const port =
                    previewPorts(zoomed).find((candidate) => candidate.id === placed.portId) ??
                    previewModulePorts(zoomed, moduleByKey[zoomed.catalogKey] ?? null).find(
                      (candidate) => candidate.id === placed.portId,
                    );
                  if (!port) return null;
                  return (
                    <PhysicalPortShape
                      key={port.id}
                      port={port}
                      placed={placed}
                      scale={zoomRender.scale}
                      selected={zoomPortId === port.id}
                      inPath={false}
                      overlap={zoomRender.overlaps.has(port.id)}
                      onSelect={setZoomPortId}
                    />
                  );
                })}
                {zoomRender.layout.slots.map((slot) => (
                  <div
                    key={slot.slotId}
                    className="physical-slot"
                    style={{
                      left: slot.x * zoomRender.scale,
                      top: slot.y * zoomRender.scale,
                      width: slot.width * zoomRender.scale,
                      height: slot.height * zoomRender.scale,
                    }}
                  >
                    <em>{slot.index}</em>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}
