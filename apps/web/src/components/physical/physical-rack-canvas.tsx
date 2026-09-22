'use client';

import { useMemo } from 'react';
import type {
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalCatalogModule,
  PhysicalConnection,
  PhysicalPath,
  PhysicalRack,
} from '@gmj/shared';
import type { PhysicalConnectionMode, PhysicalSelection } from './physical-types';
import {
  PANEL_MAX_HEIGHT,
  buildModulePanelLayout,
  buildPanelLayout,
  calculateAssetDisplayHeight,
  connectorAnchor,
  type PanelLayout,
} from './physical-panel-layout';
import { PhysicalPortShape } from './physical-port-shape';
import {
  type FrontPanelBoxPx,
  type FrontPanelImageMap,
  frontPanelAnchorPx,
  frontPanelAspectRatio,
  frontPanelImageMapForAsset,
  frontPanelPortMapFor,
} from './front-panel-image-map';
import { PhysicalImagePanel } from './physical-image-panel';
import { RACK_GEOMETRY, buildRackGeometry, panelScale } from './physical-rack-geometry';

/** Altura do cabeçalho de identidade dentro da faceplate (px). */
const IDENTITY_HEIGHT = 30;
/** Respiro vertical do painel dentro do equipamento. */
const PANEL_PADDING = 8;

/** Painel de um equipamento: imagem aprovada ou grade geométrica (fallback). */
type AssetPanel =
  | { kind: 'layout'; layout: PanelLayout; displayHeight: number }
  | { kind: 'image'; map: FrontPanelImageMap; displayHeight: number };

/** Largura útil do painel dentro do rack (px) — constante do desenho. */
function panelWidth(): number {
  return RACK_GEOMETRY.rackWidth - RACK_GEOMETRY.frameInset * 2;
}

/**
 * Caixa da imagem dentro da área do painel, preservando a proporção original.
 *
 * É a **única** geometria do painel por imagem: imagem, hitboxes, tooltip e
 * âncora do cabo derivam desta caixa (visual = hitbox = clique = cabo).
 */
function imageBoxIn(box: FrontPanelBoxPx, aspect: number): FrontPanelBoxPx {
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

interface CablePath {
  connection: PhysicalConnection;
  d: string;
  selected: boolean;
  related: boolean;
  exitLabel?: string;
  labelX?: number;
  labelY?: number;
}

interface Props {
  rack: PhysicalRack;
  connections: PhysicalConnection[];
  mode: PhysicalConnectionMode;
  selection: PhysicalSelection;
  path: PhysicalPath | null;
  /** Catálogo atual: fonte da verdade da geometria do painel. */
  catalog?: readonly PhysicalCatalogEntry[];
  onSelectAsset: (id: string) => void;
  onSelectPort: (id: string) => void;
  onSelectConnection: (id: string) => void;
  onClear: () => void;
}

/**
 * Visão frontal semântica do rack.
 *
 * A ocupação física (`startU`/`heightU`) nunca muda: uma unidade pode ficar
 * visualmente mais alta para mostrar todas as portas do painel, mas a régua
 * continua identificando a U. Todas as portas declaradas no catálogo são
 * desenhadas, com tamanho proporcional ao conector (SFP < QSFP < QSFP-DD) e o
 * cabo ancorado na porta desenhada.
 */
export function PhysicalRackCanvas({
  rack,
  connections,
  mode,
  selection,
  path,
  catalog = [],
  onSelectAsset,
  onSelectPort,
  onSelectConnection,
  onClear,
}: Props) {
  const base = RACK_GEOMETRY.baseUnitHeight;
  const catalogByKey = useMemo(() => {
    const map = new Map<string, PhysicalCatalogEntry>();
    for (const entry of catalog) map.set(entry.catalogKey, entry);
    return map;
  }, [catalog]);

  /** Largura útil do painel dentro do rack (px): define imagem e escala. */
  const panelWidthPx = panelWidth();

  /**
   * Painel de cada equipamento: grade normalizada (`panelLayout`) **ou** mapa
   * de imagem aprovado, sempre com a altura visual calculada. A ocupação
   * física (`startU`/`heightU`) não muda em nenhum dos casos.
   */
  const panels = useMemo(() => {
    const result = new Map<string, AssetPanel>();
    for (const asset of rack.assets) {
      const entry = asset.template?.catalogKey
        ? (catalogByKey.get(asset.template.catalogKey) ?? null)
        : null;
      const imageMap = frontPanelImageMapForAsset(asset);
      if (imageMap) {
        const imageHeight = panelWidthPx / frontPanelAspectRatio(imageMap);
        result.set(asset.id, {
          kind: 'image',
          map: imageMap,
          displayHeight: Math.min(
            PANEL_MAX_HEIGHT,
            Math.max(
              Math.max(1, asset.heightU) * base,
              IDENTITY_HEIGHT + PANEL_PADDING * 2 + Math.round(imageHeight),
            ),
          ),
        });
        continue;
      }
      const layout = buildPanelLayout({
        ports: asset.ports,
        slots: asset.slots,
        modules: asset.modules,
        entry,
      });
      result.set(asset.id, {
        kind: 'layout',
        layout,
        displayHeight: calculateAssetDisplayHeight(layout, asset.heightU, base),
      });
    }
    return result;
  }, [base, catalogByKey, panelWidthPx, rack.assets]);

  const displayHeights = useMemo(
    () => new Map([...panels].map(([assetId, panel]) => [assetId, panel.displayHeight])),
    [panels],
  );
  const geometry = useMemo(() => buildRackGeometry(rack, displayHeights), [displayHeights, rack]);

  function catalogModuleOf(
    asset: PhysicalAsset,
    moduleTemplateId: string | null,
  ): PhysicalCatalogModule | null {
    if (!asset.template?.catalogKey) return null;
    const entry = catalogByKey.get(asset.template.catalogKey);
    if (!entry) return null;
    const templateModule = asset.template.modules.find((item) => item.id === moduleTemplateId);
    if (!templateModule?.catalogKey) return null;
    return entry.modules.find((item) => item.key === templateModule.catalogKey) ?? null;
  }

  /**
   * Caixa do painel do equipamento (px no canvas).
   *
   * É a MESMA caixa usada para desenhar (imagem ou grade), para posicionar os
   * hitboxes e para ancorar os cabos — nenhuma geometria paralela.
   */
  function panelBoxOf(asset: PhysicalAsset): FrontPanelBoxPx | null {
    const placement = geometry.assets.get(asset.id);
    const panel = panels.get(asset.id);
    if (!placement || !panel) return null;
    return {
      left: geometry.rackLeft + RACK_GEOMETRY.frameInset,
      top: placement.top + IDENTITY_HEIGHT + PANEL_PADDING,
      width: geometry.rackWidth - RACK_GEOMETRY.frameInset * 2,
      height: Math.max(24, placement.height - IDENTITY_HEIGHT - PANEL_PADDING),
    };
  }

  /** Escala e offsets (px) do painel geométrico de um equipamento. */
  function panelViewport(asset: PhysicalAsset) {
    const box = panelBoxOf(asset);
    const panel = panels.get(asset.id);
    if (!box || !panel || panel.kind !== 'layout') return null;
    const scale = Math.min(
      panelScale(panel.layout.width, box.width),
      box.height / Math.max(panel.layout.gridHeight, 1),
    );
    return { panel, scale, offsetX: box.left, offsetY: box.top };
  }

  /** Caixa da imagem do equipamento (proporção preservada) — âncora inclusa. */
  function imageBoxOf(asset: PhysicalAsset): FrontPanelBoxPx | null {
    const box = panelBoxOf(asset);
    const panel = panels.get(asset.id);
    if (!box || !panel || panel.kind !== 'image') return null;
    return imageBoxIn(box, frontPanelAspectRatio(panel.map));
  }

  /** Anchor do cabo: sempre o centro do conector realmente desenhado. */
  function portAnchor(assetId: string, portId: string): { x: number; y: number } | null {
    const asset = rack.assets.find((candidate) => candidate.id === assetId);
    if (!asset) return null;
    const panel = panels.get(assetId);
    if (panel?.kind === 'image') {
      // Centro do mesmo bbox do hotspot: visual = hitbox = clique = cabo.
      const imageBox = imageBoxOf(asset);
      const port = asset.ports.find((candidate) => candidate.id === portId);
      const mapped = port ? frontPanelPortMapFor(panel.map, port) : null;
      if (imageBox && mapped) {
        const anchor = frontPanelAnchorPx(panel.map, mapped.portName, imageBox);
        if (anchor) return anchor;
      }
      // Porta fora do mapa (ex.: console/MGMT não recortado): cai no geométrico.
    }
    const viewport = panelViewport(asset);
    if (!viewport) return null;
    const placed = viewport.panel.layout.connectors.find((item) => item.portId === portId);
    if (placed) {
      return connectorAnchor(placed, {
        scale: viewport.scale,
        offsetX: viewport.offsetX,
        offsetY: viewport.offsetY,
      });
    }
    // Porta de placa instalada: o anchor vive dentro do slot correspondente.
    const module = asset.modules.find((item) => item.ports.some((port) => port.id === portId));
    const slot = module ? asset.slots.find((item) => item.id === module.slotId) : undefined;
    const placedSlot = slot
      ? viewport.panel.layout.slots.find((item) => item.slotId === slot.id)
      : undefined;
    const port = module?.ports.find((item) => item.id === portId);
    if (!module || !placedSlot || !port) return null;
    const moduleLayout = buildModulePanelLayout({
      module,
      catalogModule: catalogModuleOf(asset, module.moduleTemplateId),
    });
    const slotWidthPx = placedSlot.width * viewport.scale;
    const moduleScale = Math.min(viewport.scale, slotWidthPx / Math.max(moduleLayout.width, 1));
    const moduleAnchor = moduleLayout.connectors.find((item) => item.portId === port.id);
    if (!moduleAnchor) return null;
    return {
      x: viewport.offsetX + (placedSlot.x + 0.4) * viewport.scale + moduleAnchor.x * moduleScale,
      y: viewport.offsetY + (placedSlot.y + 1.2) * viewport.scale + moduleAnchor.y * moduleScale,
    };
  }

  const pathConnectionIds = new Set(
    path?.steps.flatMap((step) => (step.kind === 'CABLE' ? [step.connectionId] : [])) ?? [],
  );
  const selectedConnectionId = selection?.kind === 'connection' ? selection.id : null;
  const related = (connection: PhysicalConnection) => {
    if (selection?.kind === 'asset') {
      return connection.a.assetId === selection.id || connection.b.assetId === selection.id;
    }
    if (selection?.kind === 'port') return pathConnectionIds.has(connection.id);
    if (selection?.kind === 'connection') return connection.id === selection.id;
    return false;
  };

  const laneX = geometry.rackLeft + geometry.rackWidth + 26;
  let exitSlot = 0;
  const cables: CablePath[] = connections.flatMap((connection) => {
    const aInRack = connection.a.rackId === rack.id;
    const bInRack = connection.b.rackId === rack.id;
    if (!aInRack && !bInRack) return [];
    const isRelated = related(connection);
    if (mode === 'hidden' || (mode === 'selected' && !isRelated)) return [];
    const selected = connection.id === selectedConnectionId || pathConnectionIds.has(connection.id);
    if (aInRack && bInRack) {
      const a = portAnchor(connection.a.assetId, connection.a.portId);
      const b = portAnchor(connection.b.assetId, connection.b.portId);
      if (!a || !b) return [];
      const lane = laneX + (exitSlot % 4) * 16;
      exitSlot += 1;
      return [
        {
          connection,
          d: `M ${a.x} ${a.y} H ${lane} V ${b.y} H ${b.x}`,
          selected,
          related: isRelated,
        },
      ];
    }
    const local = aInRack ? connection.a : connection.b;
    const point = portAnchor(local.assetId, local.portId);
    if (!point) return [];
    const y = 22 + exitSlot * 24;
    const lane = laneX + (exitSlot % 4) * 16;
    exitSlot += 1;
    const remote = aInRack ? connection.b : connection.a;
    return [
      {
        connection,
        d: `M ${point.x} ${point.y} H ${lane} V ${y} H ${geometry.width - 12}`,
        selected,
        related: isRelated,
        exitLabel: `→ ${remote.siteName} / ${remote.rackName} / ${remote.assetName}`,
        labelX: laneX + 6,
        labelY: y - 6,
      },
    ];
  });

  const activeAssetIds = new Set<string>();
  if (selection?.kind === 'asset') activeAssetIds.add(selection.id);
  if (selection?.kind === 'port') {
    for (const asset of rack.assets) {
      if (asset.ports.some((port) => port.id === selection.id)) activeAssetIds.add(asset.id);
    }
  }
  for (const cable of cables.filter((item) => item.related)) {
    activeAssetIds.add(cable.connection.a.assetId);
    activeAssetIds.add(cable.connection.b.assetId);
  }

  return (
    <div className="physical-canvas-scroll" onClick={onClear}>
      <div className="physical-canvas" style={{ width: geometry.width, height: geometry.height }}>
        <div
          className="physical-rack-frame"
          style={{ left: geometry.rackLeft, width: geometry.rackWidth, height: geometry.height - 40 }}
        >
          {geometry.units.map((unit) => (
            <div
              key={unit.unit}
              className={`physical-u-row ${unit.unit % 5 === 0 ? 'is-major' : ''} ${
                unit.height > base ? 'is-expanded' : ''
              }`}
              style={{ top: unit.top, height: unit.height }}
            >
              <span>{String(unit.unit).padStart(2, '0')}</span>
              <span>{unit.unit % 5 === 0 ? String(unit.unit).padStart(2, '0') : ''}</span>
            </div>
          ))}
          <div className="physical-rail physical-rail--left" />
          <div className="physical-rail physical-rail--right" />
        </div>

        <div
          className="physical-cable-lane"
          style={{ left: laneX - 10, height: geometry.height - 40 }}
          aria-hidden="true"
        >
          <span>CABLE LANE</span>
        </div>

        <svg
          className="physical-cables"
          width={geometry.width}
          height={geometry.height}
          aria-label="Conexões físicas"
        >
          {cables.map((cable) => (
            <g key={cable.connection.id}>
              <path
                d={cable.d}
                className={`physical-cable-hit ${cable.selected ? 'is-selected' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectConnection(cable.connection.id);
                }}
              />
              <path
                d={cable.d}
                className={`physical-cable physical-cable--${cable.connection.medium.toLowerCase()} ${
                  cable.selected ? 'is-selected' : cable.related ? 'is-related' : 'is-dim'
                }`}
              />
              {cable.exitLabel ? (
                <text x={cable.labelX} y={cable.labelY} className="physical-cable-label">
                  {cable.exitLabel}
                </text>
              ) : null}
            </g>
          ))}
        </svg>

        {rack.assets.map((asset) => {
          const placement = geometry.assets.get(asset.id);
          const panel = panels.get(asset.id);
          const box = panelBoxOf(asset);
          if (!placement || !panel || !box) return null;
          const layoutPanel = panel.kind === 'layout' ? panel : null;
          const viewport = layoutPanel ? panelViewport(asset) : null;
          const scale = viewport?.scale ?? 1;
          const active = activeAssetIds.has(asset.id);
          const dimmed = Boolean(selection && activeAssetIds.size && !active);
          const uEnd = placement.startU + placement.heightU - 1;
          const pathPortIds = new Set(
            path?.steps.flatMap((step) => (step.kind === 'PORT' ? [step.portId] : [])) ?? [],
          );
          const portNode = (portId: string) => {
            const port = asset.ports.find((candidate) => candidate.id === portId);
            const placed = layoutPanel?.layout.connectors.find((item) => item.portId === portId);
            if (!port || !placed) return null;
            return (
              <PhysicalPortShape
                key={port.id}
                port={port}
                placed={placed}
                scale={scale}
                selected={selection?.kind === 'port' && selection.id === port.id}
                inPath={pathPortIds.has(port.id)}
                onSelect={onSelectPort}
              />
            );
          };
          /** Imagem + hitboxes: caixa com a proporção original, centralizada. */
          const imageBox = panel.kind === 'image' ? imageBoxOf(asset) : null;

          return (
            <article
              key={asset.id}
              data-asset-id={asset.id}
              className={`physical-faceplate physical-faceplate--${asset.kind.toLowerCase()} ${
                active ? 'is-selected' : ''
              } ${dimmed ? 'is-dimmed' : ''} ${asset.slots.length ? 'is-modular' : ''}`}
              style={{
                left: geometry.rackLeft,
                top: placement.top + 1,
                width: geometry.rackWidth,
                height: placement.height - 2,
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectAsset(asset.id);
              }}
            >
              <span className="physical-faceplate__kind" />
              <div className="physical-faceplate__identity">
                <strong>{asset.name}</strong>
                <small>
                  {asset.template?.model || asset.template?.name || asset.device?.model || asset.kind}
                  {' · '}U{placement.startU}
                  {uEnd > placement.startU ? `–U${uEnd}` : ''} · {placement.heightU}U
                </small>
              </div>

              <div
                className="physical-faceplate__panel"
                style={{
                  left: RACK_GEOMETRY.frameInset,
                  top: IDENTITY_HEIGHT + PANEL_PADDING - 1,
                  width: box.width,
                  // -1 compensa o `top: placement.top + 1` do artigo: o painel
                  // começa exatamente onde o anchor do cabo assume
                  height: box.height,
                }}
                aria-label={`Painel de ${asset.name}`}
              >
                {panel.kind === 'image' && imageBox ? (
                  <div
                    className="physical-image-panel-slot"
                    style={{
                      left: imageBox.left - box.left,
                      top: imageBox.top - box.top,
                      width: imageBox.width,
                      height: imageBox.height,
                    }}
                  >
                    <PhysicalImagePanel
                      map={panel.map}
                      ports={asset.ports}
                      selectedPortId={selection?.kind === 'port' ? selection.id : null}
                      pathPortIds={pathPortIds}
                      onSelectPort={onSelectPort}
                    />
                  </div>
                ) : null}
                {layoutPanel
                  ? layoutPanel.layout.slots.map((slot) => {
                      const slotModel = asset.slots.find((item) => item.id === slot.slotId);
                      const module = slotModel?.module ?? null;
                      const moduleLayout = module
                        ? buildModulePanelLayout({
                            module,
                            catalogModule: catalogModuleOf(asset, module.moduleTemplateId),
                          })
                        : null;
                      const slotWidthPx = slot.width * scale;
                      const slotHeightPx = slot.height * scale;
                      const moduleScale = moduleLayout
                        ? Math.min(scale, slotWidthPx / Math.max(moduleLayout.width, 1))
                        : scale;
                      return (
                        <div
                          key={slot.slotId}
                          className={`physical-slot ${slot.occupied ? 'is-occupied' : ''}`}
                          style={{
                            left: Math.round(slot.x * scale),
                            top: Math.round(slot.y * scale),
                            width: Math.round(slotWidthPx),
                            height: Math.round(slotHeightPx),
                          }}
                          title={
                            module
                              ? `${slot.label || `Slot ${slot.index}`} · ${module.name}`
                              : `${slot.label || `Slot ${slot.index}`} · vazio`
                          }
                        >
                          <em>{slot.index}</em>
                          {module ? (
                            <>
                              <small>{module.model || module.name}</small>
                              {moduleLayout ? (
                                <div className="physical-slot__panel">
                                  {moduleLayout.connectors.map((placed) => {
                                    const port = module.ports.find(
                                      (candidate) => candidate.id === placed.portId,
                                    );
                                    if (!port) return null;
                                    return (
                                      <PhysicalPortShape
                                        key={port.id}
                                        port={port}
                                        placed={placed}
                                        scale={moduleScale}
                                        selected={
                                          selection?.kind === 'port' && selection.id === port.id
                                        }
                                        inPath={pathPortIds.has(port.id)}
                                        onSelect={onSelectPort}
                                      />
                                    );
                                  })}
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      );
                    })
                  : null}
                {layoutPanel
                  ? layoutPanel.layout.connectors.map((placed) => portNode(placed.portId))
                  : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
