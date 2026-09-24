'use client';

import { useMemo } from 'react';
import type {
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalCatalogModule,
  PhysicalConnection,
  PhysicalConnectionEndpoint,
  PhysicalPath,
  PhysicalRack,
} from '@gmj/shared';
import type { PhysicalConnectionMode, PhysicalSelection, PhysicalVisualMode } from './physical-types';
import {
  IMAGE_PANEL_MAX_HEIGHT,
  buildModulePanelLayout,
  buildPanelLayout,
  calculateAssetDisplayHeight,
  connectorAnchor,
  type PanelLayout,
} from './physical-panel-layout';
import { PhysicalPortShape } from './physical-port-shape';
import { friendlySlotLabel } from './physical-catalog';
import {
  type FrontPanelBoxPx,
  type FrontPanelImageMap,
  frontPanelAnchorPx,
  frontPanelAspectRatio,
  frontPanelImageMapForAsset,
  frontPanelPortMapFor,
} from './front-panel-image-map';
import { PhysicalImagePanel } from './physical-image-panel';
import { PhysicalModularPanel, type ModularSlotView, type SlotFitView } from './physical-modular-panel';
import {
  type ModularChassisMap,
  type ModulePanelPlacement,
  chassisAspectRatio,
  chassisRenderMode,
  chassisSlotBoxPx,
  chassisSlotMapFor,
  moduleImageBoxInSlot,
  modulePanelPlacementInSlot,
  modulePortAnchorPx,
  modularChassisMapForAsset,
  slotOrientation,
} from './modular-chassis-map';
import {
  type ModuleFrontPanelMap,
  moduleFrontPanelAspectRatio,
  moduleFrontPanelImageMap,
  moduleFrontPanelMapFor,
} from './module-front-panel-map';
import { RACK_GEOMETRY, buildRackGeometry, panelScale } from './physical-rack-geometry';
import { physicalPortNameView } from './physical-port-name';
import {
  TECHNICAL_BAND_GAP,
  TECHNICAL_BAND_TOP,
  assetUsesTechnicalRenderer,
  slotRoleAccent,
  technicalChassisDisplayHeight,
  technicalChassisMap,
  technicalGroupBays,
  technicalModuleLeds,
  technicalPanelCaptions,
  technicalPanelDisplayHeight,
  technicalSlotSummary,
} from './physical-technical';

/** Altura do cabeçalho de identidade dentro da faceplate (px). */
const IDENTITY_HEIGHT = 30;
/** Respiro vertical do painel dentro do equipamento. */
const PANEL_PADDING = 8;

/** Painel de um equipamento: imagem aprovada, chassi modular ou grade geométrica. */
type AssetPanel =
  | { kind: 'layout'; layout: PanelLayout; displayHeight: number }
  | { kind: 'image'; map: FrontPanelImageMap; displayHeight: number }
  | { kind: 'modular'; map: ModularChassisMap; displayHeight: number };

/**
 * Geometria da placa instalada dentro de um slot.
 *
 * `box` é absoluta (âncora do cabo) e `offset` é relativa ao slot (DOM);
 * quando a placa tem painel por imagem, `map` manda no desenho e nos hotspots,
 * senão vale o renderer geométrico (`layout` + `scale`).
 */
interface ModuleGeometry {
  module: PhysicalAsset['modules'][number];
  map: ModuleFrontPanelMap | null;
  layout: ReturnType<typeof buildModulePanelLayout> | null;
  scale: number;
  /** Escala do eixo vertical (placa vertical esticada até o limite). */
  scaleY: number;
  box: FrontPanelBoxPx;
  offset: { left: number; top: number };
  /** 90 quando a placa é girada para caber num slot vertical (visão técnica). */
  rotation: 0 | 90;
  /** Tamanho natural do contêiner DOM antes da rotação. */
  board: { width: number; height: number };
  /** Folga da placa dentro do slot (px por eixo) — ejetores só onde cabe. */
  slack: { x: number; y: number };
}

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
  /** Ponta fora deste rack: vira um endpoint clicável na cable-lane. */
  remote?: {
    endpoint: PhysicalConnectionEndpoint;
    external: boolean;
    portY: number;
  };
}

interface Props {
  rack: PhysicalRack;
  connections: PhysicalConnection[];
  mode: PhysicalConnectionMode;
  selection: PhysicalSelection;
  path: PhysicalPath | null;
  /** Modo de visualização: `REAL` (padrão) ou `TECHNICAL` (protótipo). */
  visualMode?: PhysicalVisualMode;
  /** Catálogo atual: fonte da verdade da geometria do painel. */
  catalog?: readonly PhysicalCatalogEntry[];
  /** LAB/DEV: desenha as âncoras reais das portas (encaixe do cabo). */
  showAnchors?: boolean;
  /** LAB/DEV: desenha a bbox + ordinal de cada slot. */
  showSlots?: boolean;
  /** LAB/DEV: destaca a bbox de cada slot. */
  showBbox?: boolean;
  /** LAB/DEV: mostra os moduleKeys compatíveis de cada slot. */
  showModuleKeys?: boolean;
  /**
   * LAB/DEV: realce de encaixe por slot para o módulo armado na bancada.
   * O LAB decide (dados do catálogo); o canvas só desenha o resultado.
   */
  slotFit?: ((slotId: string) => SlotFitView | null) | undefined;
  /** LAB/DEV: clique no slot (bancada usa para encaixar o módulo armado). */
  onSelectSlot?: ((slotId: string) => void) | undefined;
  /** LAB/DEV: mostra o botão de remover placa no slot ocupado. */
  onRemoveModule?: ((slotId: string) => void) | undefined;
  onSelectAsset: (id: string) => void;
  onSelectPort: (id: string) => void;
  onSelectConnection: (id: string) => void;
  /** Leva o operador até o site/rack da ponta remota e seleciona a porta. */
  onNavigateToPort?: (siteId: string, rackId: string, portId: string) => void;
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
  visualMode = 'REAL',
  catalog = [],
  showAnchors = false,
  showSlots = false,
  showBbox = false,
  showModuleKeys = false,
  slotFit,
  onSelectSlot,
  onRemoveModule,
  onSelectAsset,
  onSelectPort,
  onSelectConnection,
  onNavigateToPort,
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
   *
   * No modo `TECHNICAL`, os modelos com desenho técnico declarado ignoram a
   * imagem (front panel e chassi modular) e usam o renderer esquemático; os
   * demais equipamentos seguem exatamente o desenho real.
   */
  const panels = useMemo(() => {
    const result = new Map<string, AssetPanel>();
    for (const asset of rack.assets) {
      const entry = asset.template?.catalogKey
        ? (catalogByKey.get(asset.template.catalogKey) ?? null)
        : null;
      const technical = assetUsesTechnicalRenderer(asset.template?.catalogKey ?? null, visualMode);
      const isTechnicalMode = visualMode === 'TECHNICAL';
      // Visão técnica **não usa fotografia**: nem painel frontal nem chassi —
      // o corpo do equipamento é sempre o desenho escuro (sem fundo claro).
      const imageMap = isTechnicalMode ? null : frontPanelImageMapForAsset(asset);
      if (imageMap) {
        const imageHeight = panelWidthPx / frontPanelAspectRatio(imageMap);
        result.set(asset.id, {
          kind: 'image',
          map: imageMap,
          displayHeight: Math.min(
            IMAGE_PANEL_MAX_HEIGHT,
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
        // Visão técnica: grupos empilhados em bandas com respiro (rótulo do grupo
        // embaixo). Só aparência — portas, conectores e contagem não mudam.
        ...(technical
          ? { bandGapY: TECHNICAL_BAND_GAP, bandTopY: TECHNICAL_BAND_TOP }
          : {}),
      });
      // Chassi modular com mapa declarado: os slots vêm do mapa (imagem quando
      // existir; senão só a moldura lógica). Sem mapa, o renderer de hoje decide.
      const chassisMap = modularChassisMapForAsset(asset);
      if (chassisMap && chassisRenderMode(chassisMap) !== 'PANEL_LAYOUT') {
        const effectiveMap = isTechnicalMode ? technicalChassisMap(chassisMap) : chassisMap;
        const geometric = calculateAssetDisplayHeight(layout, asset.heightU, base);
        const imageHeight = effectiveMap.image ? panelWidthPx / chassisAspectRatio(effectiveMap) : 0;
        result.set(asset.id, {
          kind: 'modular',
          map: effectiveMap,
          displayHeight: technical
            ? technicalChassisDisplayHeight({
                slotCount: effectiveMap.slots.length,
                heightU: asset.heightU,
                baseUnitHeight: base,
                chromePx: IDENTITY_HEIGHT + PANEL_PADDING * 2,
                maxHeightPx: IMAGE_PANEL_MAX_HEIGHT,
              })
            : effectiveMap.image
              ? Math.min(
                  IMAGE_PANEL_MAX_HEIGHT,
                  Math.max(
                    Math.max(1, asset.heightU) * base,
                    IDENTITY_HEIGHT + PANEL_PADDING * 2 + Math.round(imageHeight),
                  ),
                )
              : geometric,
        });
        continue;
      }
      result.set(asset.id, {
        kind: 'layout',
        layout,
        displayHeight: technical
          ? technicalPanelDisplayHeight({
              gridHeight: layout.gridHeight,
              heightU: asset.heightU,
              baseUnitHeight: base,
              chromePx: IDENTITY_HEIGHT + PANEL_PADDING * 2,
              maxHeightPx: IMAGE_PANEL_MAX_HEIGHT,
            })
          : calculateAssetDisplayHeight(layout, asset.heightU, base),
      });
    }
    return result;
  }, [base, catalogByKey, panelWidthPx, rack.assets, visualMode]);

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

  /** `true` quando o equipamento usa o desenho técnico no modo atual. */
  function technicalOf(asset: PhysicalAsset): boolean {
    return assetUsesTechnicalRenderer(asset.template?.catalogKey ?? null, visualMode);
  }

  /** Caixa da imagem do equipamento (proporção preservada) — âncora inclusa. */
  function imageBoxOf(asset: PhysicalAsset): FrontPanelBoxPx | null {
    const box = panelBoxOf(asset);
    const panel = panels.get(asset.id);
    if (!box || !panel || panel.kind !== 'image') return null;
    return imageBoxIn(box, frontPanelAspectRatio(panel.map));
  }

  /**
   * Caixa do painel do chassi modular: proporção da imagem quando existir,
   * senão a própria área do painel (moldura lógica dos slots).
   */
  function modularBoxOf(asset: PhysicalAsset): FrontPanelBoxPx | null {
    const box = panelBoxOf(asset);
    const panel = panels.get(asset.id);
    if (!box || !panel || panel.kind !== 'modular') return null;
    return panel.map.image ? imageBoxIn(box, chassisAspectRatio(panel.map)) : box;
  }

  /** Caixa da placa instalada dentro do slot (desenho + âncora usam a mesma). */
  function moduleBoxOf(asset: PhysicalAsset, slotId: string): ModuleGeometry | null {
    const panel = panels.get(asset.id);
    if (panel?.kind !== 'modular') return null;
    const chassisBox = modularBoxOf(asset);
    const module = asset.modules.find((item) => item.slotId === slotId) ?? null;
    const slot = asset.slots.find((item) => item.id === slotId) ?? null;
    if (!chassisBox || !module || !slot) return null;
    const slotBox = chassisSlotBoxPx(panel.map, slot, chassisBox);
    if (!slotBox) return null;
    const catalogModule = catalogModuleOf(asset, module.moduleTemplateId);
    // Visão técnica: a placa é desenhada pelo renderer geométrico (sem imagem).
    const map = technicalOf(asset)
      ? null
      : moduleFrontPanelMapFor({
          moduleKey: catalogModule?.key ?? null,
          partNumber: catalogModule?.partNumber ?? null,
          model: module.model,
          name: module.name,
        });
    if (map) {
      // A imagem da placa manda no desenho e nos hotspots.
      const placed = moduleImageBoxInSlot(slotBox, moduleFrontPanelAspectRatio(map));
      return {
        module,
        map,
        layout: null,
        scale: 1,
        scaleY: 1,
        box: placed.box,
        offset: placed.offset,
        rotation: 0,
        board: { width: placed.box.width, height: placed.box.height },
        slack: { x: Math.max(0, slotBox.width - placed.box.width), y: Math.max(0, slotBox.height - placed.box.height) },
      };
    }
    const layout = buildModulePanelLayout({ module, catalogModule });
    // Orientação vem do bbox do slot no mapa (nunca da imagem). A rotação da
    // placa só existe na visão técnica: o modo real mantém o desenho atual.
    const mapped = chassisSlotMapFor(panel.map, slot);
    const vertical =
      technicalOf(asset) && mapped ? slotOrientation(mapped.bbox) === 'VERTICAL' : false;
    const placement: ModulePanelPlacement = modulePanelPlacementInSlot(
      slotBox,
      layout,
      vertical ? 'VERTICAL' : 'HORIZONTAL',
    );
    return {
      module,
      map: null,
      layout,
      scale: placement.scale,
      scaleY: placement.scaleY ?? placement.scale,
      box: placement,
      offset: placement.offset,
      rotation: placement.rotation ?? 0,
      board: placement.board,
      slack: {
        x: Math.max(0, slotBox.width - placement.width),
        y: Math.max(0, slotBox.height - placement.height),
      },
    };
  }

  /** Slots do chassi prontos para o painel modular (nada é inventado). */
  function modularSlotsOf(asset: PhysicalAsset, map: ModularChassisMap): ModularSlotView[] {
    const entry = asset.template?.catalogKey
      ? (catalogByKey.get(asset.template.catalogKey) ?? null)
      : null;
    return asset.slots.map((slot) => {
      const module = slot.module ?? null;
      const catalogMap = chassisSlotMapFor(map, slot);
      const catalogSlot = entry?.slots.find((item) => item.index === slot.index) ?? null;
      const role = catalogSlot?.slotRole ?? catalogMap?.role ?? null;
      const compatibleModuleKeys = entry && catalogSlot ? catalogSlot.moduleKeys : [];
      const compatibleModules =
        entry && catalogSlot && catalogSlot.moduleKeys.length > 0
          ? entry.modules
              .filter((candidate) => catalogSlot.moduleKeys.includes(candidate.key))
              .map((candidate) => candidate.partNumber ?? candidate.model ?? candidate.name)
          : [];
      return {
        slotId: slot.id,
        ordinal: slot.index,
        label: friendlySlotLabel(slot.index, role, slot.label),
        occupied: module !== null,
        moduleName: module ? module.model || module.name : null,
        moduleImage: null,
        compatibleModules,
        compatibleModuleKeys,
        role,
      };
    });
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
    if (panel?.kind === 'modular') {
      // Porta de placa: o anchor vive dentro do slot, na mesma caixa do desenho.
      const module = asset.modules.find((item) => item.ports.some((port) => port.id === portId));
      const port = module?.ports.find((item) => item.id === portId);
      const geometry = module ? moduleBoxOf(asset, module.slotId) : null;
      if (port && geometry) {
        if (geometry.map) {
          // Placa com painel por imagem: âncora = centro do hotspot da porta.
          const imageMap = moduleFrontPanelImageMap(geometry.map);
          const mapped = frontPanelPortMapFor(imageMap, port);
          const anchor = mapped
            ? frontPanelAnchorPx(imageMap, mapped.portName, geometry.box)
            : null;
          if (anchor) return anchor;
        }
        const layout =
          geometry.layout ??
          buildModulePanelLayout({
            module: geometry.module,
            catalogModule: catalogModuleOf(asset, geometry.module.moduleTemplateId),
          });
        const placed = layout.connectors.find((item) => item.portId === port.id);
        if (placed) return modulePortAnchorPx({ ...geometry.box, scale: geometry.scale }, placed);
      }
      // Chassi modular não tem porta própria: nada de inventar conector.
      return null;
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

  const pathConnectionIds = useMemo(
    () =>
      new Set(
        path?.steps.flatMap((step) => (step.kind === 'CABLE' ? [step.connectionId] : [])) ?? [],
      ),
    [path],
  );
  const selectedConnectionId = selection?.kind === 'connection' ? selection.id : null;
  const connectedIds = useMemo(() => {
    const ids = new Set<string>(pathConnectionIds);
    if (selection?.kind === 'connection') ids.add(selection.id);
    if (selection?.kind === 'port') {
      const selectedPort = rack.assets
        .flatMap((asset) => asset.ports)
        .find((port) => port.id === selection.id);
      if (selectedPort?.connectionId) ids.add(selectedPort.connectionId);
    }
    return ids;
  }, [pathConnectionIds, rack.assets, selection]);
  const related = (connection: PhysicalConnection) => {
    if (selection?.kind === 'asset') {
      return connection.a.assetId === selection.id || connection.b.assetId === selection.id;
    }
    if (selection?.kind === 'port' || selection?.kind === 'connection') {
      return connectedIds.has(connection.id);
    }
    return false;
  };

  /** Cabo do qual a porta selecionada é ponta: ganha o destaque máximo. */
  const selectedPortConnectionId =
    selection?.kind === 'port'
      ? (rack.assets
          .flatMap((asset) => asset.ports)
          .find((port) => port.id === selection.id)?.connectionId ?? null)
      : null;

  /** Portas das duas pontas do cabo selecionado (destaque porta ↔ porta). */
  const relatedPortIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selection) return ids;
    if (selection.kind === 'asset') return ids;
    const wanted = new Set<string>(
      selection.kind === 'connection' ? [selection.id] : connectedIds,
    );
    for (const connection of connections) {
      if (!wanted.has(connection.id)) continue;
      ids.add(connection.a.portId);
      ids.add(connection.b.portId);
    }
    // A porta selecionada já tem `is-selected`; `is-related` marca só a ponta par.
    if (selection.kind === 'port') ids.delete(selection.id);
    return ids;
  }, [connectedIds, connections, selection]);

  const laneX = geometry.rackLeft + geometry.rackWidth + 26;
  let exitSlot = 0;
  const cables: CablePath[] = connections.flatMap((connection) => {
    const aInRack = connection.a.rackId === rack.id;
    const bInRack = connection.b.rackId === rack.id;
    if (!aInRack && !bInRack) return [];
    const isRelated = related(connection);
    if (mode === 'hidden' || (mode === 'selected' && !isRelated)) return [];
    const selected =
      connection.id === selectedConnectionId ||
      connection.id === selectedPortConnectionId ||
      pathConnectionIds.has(connection.id);
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
    const remote = aInRack ? connection.b : connection.a;
    const external = remote.siteId !== local.siteId;
    const lane = laneX + (exitSlot % 3) * 18;
    exitSlot += 1;
    return [
      {
        connection,
        d: `M ${point.x} ${point.y} H ${lane} V ${point.y} H ${geometry.width - 12}`,
        selected,
        related: isRelated,
        remote: { endpoint: remote, external, portY: point.y },
      },
    ];
  });

  /** Endpoints remotos na cable-lane, empilhados sem sobreposição. */
  const remoteEndpoints = useMemo(() => {
    const rows = cables
      .filter((cable) => cable.remote)
      .map((cable) => ({
        connection: cable.connection,
        endpoint: cable.remote!.endpoint,
        external: cable.remote!.external,
        portY: cable.remote!.portY,
      }))
      .sort((left, right) => left.portY - right.portY);
    let lastBottom = -Infinity;
    return rows.map((row) => {
      const top = Math.max(0, Math.min(row.portY - 24, lastBottom + 26));
      lastBottom = top + 62;
      return { ...row, y: Math.min(top, geometry.height - 78) };
    });
  }, [cables, geometry.height]);

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
      <div
        className={`physical-canvas ${visualMode === 'TECHNICAL' ? 'is-technical' : ''}`}
        style={{ width: geometry.width, height: geometry.height }}
      >
        <div
          className="physical-rack-frame"
          style={{
            left: geometry.rackLeft,
            width: geometry.rackWidth,
            height: geometry.height - 40,
          }}
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
            </g>
          ))}
        </svg>

        {/* LAB/DEV: âncoras reais das portas (mesma função que ancora o cabo). */}
        {showAnchors ? (
          <svg
            className="physical-anchor-layer"
            width={geometry.width}
            height={geometry.height}
            aria-hidden="true"
          >
            {rack.assets.flatMap((asset) =>
              asset.ports.map((port) => {
                const anchor = portAnchor(asset.id, port.id);
                if (!anchor) return null;
                return (
                  <circle
                    key={port.id}
                    className="physical-anchor-dot"
                    data-anchor-port={port.id}
                    cx={anchor.x}
                    cy={anchor.y}
                    r={2.6}
                  />
                );
              }),
            )}
          </svg>
        ) : null}

        {remoteEndpoints.map((row) => (
          <div
            key={row.connection.id}
            className={[
              'physical-cable-endpoint',
              row.external ? 'is-external' : '',
              row.connection.id === selectedConnectionId ? 'is-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ left: laneX + 92, top: row.y }}
            role="button"
            tabIndex={0}
            title={`${row.external ? 'Fibra externa' : 'Outro rack'} · ${row.endpoint.siteName} / ${
              row.endpoint.rackName
            } / ${row.endpoint.assetName} / ${row.endpoint.portName}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelectConnection(row.connection.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectConnection(row.connection.id);
              }
            }}
          >
            <strong>{row.external ? 'FIBRA EXTERNA' : row.endpoint.rackName}</strong>
            <span>{row.endpoint.assetName}</span>
            <small>{row.endpoint.portName}</small>
            {onNavigateToPort ? (
              <button
                type="button"
                className="physical-cable-endpoint__go"
                onClick={(event) => {
                  event.stopPropagation();
                  onNavigateToPort(row.endpoint.siteId, row.endpoint.rackId, row.endpoint.portId);
                }}
              >
                Ir para a ponta →
              </button>
            ) : null}
          </div>
        ))}

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
          const technical = technicalOf(asset);
          const templateEntry = asset.template?.catalogKey
            ? (catalogByKey.get(asset.template.catalogKey) ?? null)
            : null;
          /** Resumo do chassi (aparência técnica): papéis declarados, catálogo → mapa. */
          const slotSummary = technical
            ? technicalSlotSummary(
                templateEntry && templateEntry.slots.length > 0
                  ? templateEntry.slots.map((item) => item.slotRole)
                  : panel.kind === 'modular'
                    ? panel.map.slots.map((slot) => slot.role)
                    : [],
              )
            : null;
          /** Painel FIXO na visão técnica: baías dos grupos reais + folgas. */
          const fixedBays = technical && layoutPanel
            ? technicalGroupBays(layoutPanel.layout, {
                // nome real reportado pelo equipamento tem prioridade sobre o
                // nome declarado no catálogo (nunca é inventado por posição)
                interfaceNameOf: (portId) =>
                  asset.ports.find((candidate) => candidate.id === portId)?.mappedInterface
                    ?.name ?? null,
              })
            : [];
          const boardWidth = layoutPanel ? layoutPanel.layout.width * scale : 0;
          const boardHeight = layoutPanel ? layoutPanel.layout.gridHeight * scale : 0;
          const freeHeight = layoutPanel ? Math.max(0, box.height - boardHeight) : 0;
          const freeWidth = layoutPanel ? Math.max(0, box.width - boardWidth) : 0;
          const portNode = (portId: string) => {
            const port = asset.ports.find((candidate) => candidate.id === portId);
            const placed = layoutPanel?.layout.connectors.find((item) => item.portId === portId);
            if (!port || !placed) return null;
            /** Identidade apresentada: interface CLI > catálogo > nome persistido. */
            const naming = physicalPortNameView(port, placed.catalogPort);
            return (
              <PhysicalPortShape
                key={port.id}
                port={port}
                placed={placed}
                scale={scale}
                selected={selection?.kind === 'port' && selection.id === port.id}
                inPath={pathPortIds.has(port.id)}
                related={relatedPortIds.has(port.id)}
                label={technical ? naming.compactLabel : null}
                displayName={naming.displayName}
                panelLabel={naming.panelLabel}
                onSelect={onSelectPort}
              />
            );
          };
          /** Legendas dos grupos (`10GE × 28`) desenhadas só na visão técnica. */
          const captions = (
            layout: PanelLayout,
            offset: { left: number; top: number },
            layoutScale: number,
            layoutScaleY = layoutScale,
          ) =>
            technical
              ? technicalPanelCaptions(layout).map((caption) => (
                  <span
                    key={caption.key}
                    className="physical-panel-caption"
                    style={{
                      left: Math.round(offset.left + caption.x * layoutScale),
                      top: Math.round(offset.top + caption.y * layoutScaleY),
                    }}
                  >
                    {caption.label}
                  </span>
                ))
              : null;
          /** Imagem + hitboxes: caixa com a proporção original, centralizada. */
          const imageBox = panel.kind === 'image' ? imageBoxOf(asset) : null;
          /** Chassi modular: caixa da imagem (ou do painel lógico) + slots. */
          const modularBox = panel.kind === 'modular' ? modularBoxOf(asset) : null;
          const selectedModuleSlotId =
            selection?.kind === 'port'
              ? (asset.modules.find((item) => item.ports.some((port) => port.id === selection.id))
                  ?.slotId ?? null)
              : null;

          return (
            <article
              key={asset.id}
              data-asset-id={asset.id}
              data-visual={technical ? 'TECHNICAL' : 'REAL'}
              className={`physical-faceplate physical-faceplate--${asset.kind.toLowerCase()} ${
                active ? 'is-selected' : ''
              } ${dimmed ? 'is-dimmed' : ''} ${asset.slots.length ? 'is-modular' : ''} ${
                technical ? 'is-technical' : ''
              }`}
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
                  {technical ? (
                    <span className="physical-technical-brand">
                      <i />
                      HUAWEI
                    </span>
                  ) : null}
                  {technical && templateEntry?.family ? ` ${templateEntry.family} · ` : ' '}
                  {asset.template?.model ||
                    asset.template?.name ||
                    asset.device?.model ||
                    asset.kind}
                  {technical ? ' ' : ' · '}U{placement.startU}
                  {uEnd > placement.startU ? `–U${uEnd}` : ''}
                  {technical ? '' : ` · ${placement.heightU}U`}
                </small>
                {technical ? (
                  <>
                    <span className="physical-technical-leds" aria-hidden="true">
                      <span>
                        <i className="led-on" />PWR
                      </span>
                      <span>
                        <i className="led-off" />ALM
                      </span>
                      <span>
                        <i className="led-act" />ACT
                      </span>
                    </span>
                    <span className="physical-technical-u">{placement.heightU}U</span>
                  </>
                ) : null}
              </div>
              {slotSummary ? (
                <span className="physical-technical-summary" aria-hidden="true">
                  {slotSummary}
                </span>
              ) : null}

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
                      relatedPortIds={relatedPortIds}
                      onSelectPort={onSelectPort}
                    />
                  </div>
                ) : null}
                {layoutPanel ? captions(layoutPanel.layout, { left: 0, top: 0 }, scale) : null}
                {panel.kind === 'modular' && modularBox ? (
                  <div
                    className="physical-modular-panel-area"
                    style={{
                      left: modularBox.left - box.left,
                      top: modularBox.top - box.top,
                      width: modularBox.width,
                      height: modularBox.height,
                    }}
                  >
                    <PhysicalModularPanel
                      map={panel.map}
                      slots={modularSlotsOf(asset, panel.map)}
                      panelSize={{ width: modularBox.width, height: modularBox.height }}
                      isTechnical={technical}
                      showSlotLabels={technical}
                      showSlots={showSlots}
                      showBbox={showBbox}
                      showModuleKeys={showModuleKeys}
                      slotFit={slotFit}
                      onRemoveModule={onRemoveModule}
                      selectedSlotId={selectedModuleSlotId}
                      onSelectSlot={(slotId) => {
                        if (onSelectSlot) onSelectSlot(slotId);
                        else onSelectAsset(asset.id);
                      }}
                      renderModule={(slot) => {
                        const geometry = moduleBoxOf(asset, slot.slotId);
                        if (!geometry) return null;
                        const { module, map, offset, rotation, board } = geometry;
                        const isVertical = rotation === 90;
                        const panelStyle = {
                          position: 'absolute' as const,
                          // o slot é posicionado em % do painel: o painel da
                          // placa fica sempre no mesmo respiro interno
                          left: offset.left,
                          top: offset.top,
                          width: board.width,
                          height: board.height,
                          // placa vertical: gira no eixo do slot; a âncora do
                          // cabo usa a MESMA transformação (modulePortAnchorPx)
                          ...(isVertical
                            ? { transform: 'rotate(90deg)', transformOrigin: '0 0' }
                            : {}),
                        };
                        const moduleClass = `physical-modular-panel__module-panel${
                          isVertical ? ' is-vertical-module' : ''
                        }`;
                        // Categoria visual do módulo = papel do slot (taxonomia já existente).
                        const moduleCategory = slotRoleAccent(slot.role);
                        const moduleSlack = geometry.slack;
                        const ejectorPx = isVertical
                          ? Math.min(9, Math.floor(moduleSlack.y / 2))
                          : Math.min(9, Math.floor(moduleSlack.x / 2));
                        const moduleCode =
                          catalogModuleOf(asset, module.moduleTemplateId)?.partNumber ??
                          module.model ??
                          module.name;
                        if (map) {
                          // Placa com painel por imagem: a imagem e os hotspots
                          // saem da MESMA caixa (visual = hitbox = âncora).
                          return (
                            <div
                              className={moduleClass}
                              data-module-rotation={rotation}
                              style={panelStyle}
                            >
                              <PhysicalImagePanel
                                map={moduleFrontPanelImageMap(map)}
                                ports={module.ports}
                                selectedPortId={selection?.kind === 'port' ? selection.id : null}
                                pathPortIds={pathPortIds}
                                relatedPortIds={relatedPortIds}
                                onSelectPort={onSelectPort}
                              />
                            </div>
                          );
                        }
                        const moduleLayout =
                          geometry.layout ??
                          buildModulePanelLayout({
                            module,
                            catalogModule: catalogModuleOf(asset, module.moduleTemplateId),
                          });
                        const moduleCatalog = catalogModuleOf(asset, module.moduleTemplateId);
                        // caso B: placa sem mapa frontal próprio (nem por módulo
                        // do catálogo nem por modelo) — nota honesta, sem inventar
                        const moduleFrontMap = moduleFrontPanelMapFor({
                          moduleKey: moduleCatalog?.key ?? null,
                          partNumber: moduleCatalog?.partNumber ?? null,
                          model: module.model,
                          name: module.name,
                        });
                        return (
                          <div
                            className={moduleClass}
                            data-module-rotation={rotation}
                            style={panelStyle}
                          >
                            {technical ? (
                              <div
                                className={`physical-module-shell ${
                                  isVertical ? 'is-vertical' : 'is-horizontal'
                                }`}
                                data-module-category={moduleCategory}
                                data-module-code={moduleCode}
                                data-module-chrome={moduleSlack.x >= 64 ? 'columns' : 'chips'}
                                aria-hidden="true"
                              >
                                {ejectorPx > 2 ? (
                                  <>
                                    <span
                                      className="physical-module-shell__ejector is-start"
                                      style={isVertical ? { height: ejectorPx } : { width: ejectorPx }}
                                    />
                                    <span
                                      className="physical-module-shell__ejector is-end"
                                      style={isVertical ? { height: ejectorPx } : { width: ejectorPx }}
                                    />
                                  </>
                                ) : null}
                                <span className="physical-module-shell__label">
                                  <span className="physical-module-shell__code">{moduleCode}</span>
                                  <span className="physical-module-shell__caption">{module.name}</span>
                                </span>
                                <span className="physical-module-shell__leds">
                                  {technicalModuleLeds(moduleCategory).map((led) => (
                                    <span key={led.label}>
                                      <i className={`led-${led.tone}`} />
                                      {led.label}
                                    </span>
                                  ))}
                                </span>
                              </div>
                            ) : null}
                            {technical && !moduleFrontMap ? (
                              <em className="physical-modular-panel__module-note" aria-hidden="true">
                                Mapa frontal não disponível
                              </em>
                            ) : null}
                            {captions(moduleLayout, offset, geometry.scale, geometry.scaleY)}
                            {moduleLayout.connectors.map((placed) => {
                              const port = module.ports.find(
                                (candidate) => candidate.id === placed.portId,
                              );
                              if (!port) return null;
                              const naming = physicalPortNameView(port, placed.catalogPort);
                              return (
                                <PhysicalPortShape
                                  key={port.id}
                                  port={port}
                                  placed={placed}
                                  scale={geometry.scale}
                                  scaleY={geometry.scaleY}
                                  selected={selection?.kind === 'port' && selection.id === port.id}
                                  inPath={pathPortIds.has(port.id)}
                                  related={relatedPortIds.has(port.id)}
                                  label={technical ? naming.compactLabel : null}
                                  displayName={naming.displayName}
                                  panelLabel={naming.panelLabel}
                                  onSelect={onSelectPort}
                                />
                              );
                            })}
                          </div>
                        );
                      }}
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
                                    const moduleNaming = physicalPortNameView(port, placed.catalogPort);
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
                                        related={relatedPortIds.has(port.id)}
                                        label={technical ? moduleNaming.compactLabel : null}
                                        displayName={moduleNaming.displayName}
                                        panelLabel={moduleNaming.panelLabel}
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
                {/* Visão técnica do painel fixo: moldura, baías por grupo (com
                    papel + faixa de numeração declarados) e rodapé de marca.
                    Só aparência — as portas continuam as mesmas, desenhadas
                    pelo PhysicalPortShape na MESMA escala. */}
                {technical && layoutPanel ? (
                  <>
                    <div className="physical-fixed-frame" aria-hidden="true" />
                    {fixedBays.map((bay) => (
                      <div
                        key={bay.key}
                        className={`physical-fixed-bay role-${bay.role}`}
                        data-bay-key={bay.key}
                        data-bay-role={bay.role}
                        style={{
                          left: Math.round(bay.x * scale),
                          top: Math.round(bay.y * scale),
                          width: Math.round(bay.width * scale),
                          height: Math.round(bay.height * scale),
                        }}
                        aria-hidden="true"
                      >
                        <span className="physical-fixed-bay__label">
                          {bay.label}
                          {bay.range ? <b>{bay.range}</b> : null}
                        </span>
                        {bay.interfaceRange ? (
                          <em className="physical-fixed-bay__interface">{bay.interfaceRange}</em>
                        ) : null}
                      </div>
                    ))}
                    {freeHeight >= 34 ? (
                      <div
                        className="physical-fixed-vent"
                        style={{
                          left: 5,
                          top: Math.round(boardHeight + 8),
                          width: Math.max(1, box.width - 10),
                          height: Math.max(6, Math.round(freeHeight - 34)),
                        }}
                        aria-hidden="true"
                      />
                    ) : null}
                    {freeHeight >= 30 ? (
                      <div
                        className="physical-fixed-footer"
                        style={{
                          left: 5,
                          top: Math.round(box.height - 18),
                          width: Math.max(1, box.width - 10),
                        }}
                        aria-hidden="true"
                      >
                        <span className="physical-technical-brand">
                          <i />
                          HUAWEI
                        </span>
                        <b>{asset.template?.model || asset.template?.name || asset.kind}</b>
                        <span className="physical-technical-leds">
                          <span>
                            <i className="led-on" />PWR
                          </span>
                          <span>
                            <i className="led-off" />ALM
                          </span>
                          <span>
                            <i className="led-act" />ACT
                          </span>
                        </span>
                        <span className="physical-fixed-footer__summary">
                          {fixedBays.map((bay) => `${bay.label} ${bay.count}×`).join(' · ')}
                        </span>
                      </div>
                    ) : null}
                    {freeWidth >= 24 ? (
                      <>
                        <span
                          className="physical-fixed-screw is-left"
                          style={{ left: 2 }}
                          aria-hidden="true"
                        />
                        <span
                          className="physical-fixed-screw is-right"
                          style={{ right: 2 }}
                          aria-hidden="true"
                        />
                      </>
                    ) : null}
                  </>
                ) : null}
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
