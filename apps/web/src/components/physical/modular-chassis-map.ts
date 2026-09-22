import type { PhysicalAsset, PhysicalCatalogEntry, PhysicalSlot } from '@gmj/shared';
import manifest from './huawei-modular-slot-maps-v1.json';
import {
  type FrontPanelBoxPx,
  type FrontPanelNormalizedBox,
  boxesOverlap,
  normalizedPortAnchor,
} from './front-panel-image-map';

/**
 * Chassis **modulares**: mapa de slots em coordenadas normalizadas `0..1`.
 *
 * A imagem do chassi é só aparência; a verdade de posição (hitbox do slot,
 * âncora do módulo) vive no mapa. O chassi não declara porta de serviço
 * inventada — conectores só aparecem quando existe placa instalada.
 *
 * Ordem de uso (nunca promove LOGICAL a exato automaticamente):
 *
 *     FRONT_EXACT → FRONT_APPROX → LOGICAL → renderer geométrico atual
 */

/** Como o mapa foi obtido — nunca inferido pelo desenho. */
export type ChassisMappingMode = 'FRONT_EXACT' | 'FRONT_APPROX' | 'LOGICAL';

/** Situação da imagem do chassi: gerada não é aprovada. */
export type ChassisImageStatus = 'APPROVED' | 'GENERATED' | 'AWAITING_APPROVED_IMAGE';

export interface ChassisSlotMap {
  /** Chave estável do slot no mapa (`service-1`, `lpu-3`, ...). */
  slotKey: string;
  /** Ordinal do slot — casa com `PhysicalSlot.index` do catálogo. */
  ordinal: number;
  role: string;
  bbox: FrontPanelNormalizedBox;
}

export interface ModularChassisMap {
  catalogKey: string;
  model: string;
  mappingMode: ChassisMappingMode;
  imageStatus: ChassisImageStatus;
  image?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  serviceSlotCount: number;
  slots: ChassisSlotMap[];
}

/** Renderer escolhido para um chassi modular. */
export type ChassisRenderMode = 'FRONT_EXACT' | 'FRONT_APPROX' | 'LOGICAL' | 'PANEL_LAYOUT';

interface Manifest {
  schemaVersion: string;
  coordinateSystem: string;
  chassis: ModularChassisMap[];
}

const MODULAR_MANIFEST = manifest as unknown as Manifest;

/** Todos os chassis declarados (com ou sem imagem). */
export const MODULAR_CHASSIS_MAPS: readonly ModularChassisMap[] = MODULAR_MANIFEST.chassis;

const chassisByKey = new Map<string, ModularChassisMap>(
  MODULAR_CHASSIS_MAPS.map((chassis) => [chassis.catalogKey, chassis]),
);

/** Mapa declarado do chassi (independente de ter imagem). */
export function modularChassisMap(catalogKey: string | null | undefined): ModularChassisMap | null {
  if (!catalogKey) return null;
  return chassisByKey.get(catalogKey) ?? null;
}

export function modularChassisMapForAsset(
  asset: Pick<PhysicalAsset, 'template'>,
): ModularChassisMap | null {
  return modularChassisMap(asset.template?.catalogKey);
}

/** `true` quando existe imagem utilizável para o chassi. */
export function hasModularChassisImage(catalogKey: string | null | undefined): boolean {
  return Boolean(modularChassisMap(catalogKey)?.image);
}

/**
 * Renderer do chassi, seguindo a prioridade combinada.
 *
 * - `FRONT_EXACT`: mapa declarado exato **e** imagem aprovada;
 * - `FRONT_APPROX`: existe imagem (mesmo gerada) com geometria aproximada/lógica;
 * - `LOGICAL`: existe mapa, sem imagem (só estrutura de slots);
 * - `PANEL_LAYOUT`: sem mapa — o renderer geométrico atual decide.
 */
export function chassisRenderMode(map: ModularChassisMap | null): ChassisRenderMode {
  if (!map) return 'PANEL_LAYOUT';
  if (!map.image) return 'LOGICAL';
  if (map.mappingMode === 'FRONT_EXACT' && map.imageStatus === 'APPROVED') return 'FRONT_EXACT';
  return 'FRONT_APPROX';
}

/** Proporção natural da imagem do chassi (fallback 3:1). */
export function chassisAspectRatio(map: ModularChassisMap): number {
  const width = map.naturalWidth ?? 0;
  const height = map.naturalHeight ?? 0;
  if (width > 0 && height > 0) return width / height;
  return 3;
}

/** Slot do mapa correspondente ao slot físico (casamento por ordinal). */
export function chassisSlotMapFor(
  map: ModularChassisMap,
  slot: Pick<PhysicalSlot, 'index'>,
): ChassisSlotMap | null {
  return map.slots.find((candidate) => candidate.ordinal === slot.index) ?? null;
}

export function chassisSlotMapByKey(
  map: ModularChassisMap,
  slotKey: string,
): ChassisSlotMap | null {
  return map.slots.find((candidate) => candidate.slotKey === slotKey) ?? null;
}

/** Centro do bbox do slot em pixels do canvas (hitbox = módulo = clique). */
export function chassisSlotBoxPx(
  map: ModularChassisMap,
  slot: Pick<PhysicalSlot, 'index'>,
  box: FrontPanelBoxPx,
): FrontPanelBoxPx | null {
  const mapped = chassisSlotMapFor(map, slot);
  if (!mapped) return null;
  return {
    left: box.left + mapped.bbox.x * box.width,
    top: box.top + mapped.bbox.y * box.height,
    width: mapped.bbox.width * box.width,
    height: mapped.bbox.height * box.height,
  };
}

/** Âncora genérica de um bbox normalizado dentro da caixa do chassi. */
export function chassisAnchorPx(
  bbox: FrontPanelNormalizedBox,
  box: FrontPanelBoxPx,
): { x: number; y: number } {
  const anchor = normalizedPortAnchor(bbox);
  return { x: box.left + anchor.x * box.width, y: box.top + anchor.y * box.height };
}

/**
 * Slots do mapa cobertos pelo catálogo do template (nenhum slot é inventado).
 */
export function mappedCatalogSlots(
  entry: Pick<PhysicalCatalogEntry, 'slots'>,
  map: ModularChassisMap,
): ChassisSlotMap[] {
  return entry.slots
    .map((slot) => chassisSlotMapFor(map, slot))
    .filter((slot): slot is ChassisSlotMap => slot !== null);
}

/** Pares de slots sobrepostos (deve ser vazio em mapa aprovado). */
export function overlappingChassisSlotPairs(map: ModularChassisMap): [string, string][] {
  const pairs: [string, string][] = [];
  for (let left = 0; left < map.slots.length; left += 1) {
    for (let right = left + 1; right < map.slots.length; right += 1) {
      const a = map.slots[left]!;
      const b = map.slots[right]!;
      if (boxesOverlap(a.bbox, b.bbox)) pairs.push([a.slotKey, b.slotKey]);
    }
  }
  return pairs;
}

/** Respiro entre a moldura do slot e o painel da placa instalada (px). */
export const MODULE_SLOT_INSET = { left: 3, top: 10, right: 3, bottom: 4 } as const;

/**
 * Caixa do painel da placa dentro do slot.
 *
 * É a **única** geometria do módulo: desenho das portas e âncora do cabo saem
 * daqui, então o cabo nunca nasce "perto" da porta — nasce na porta.
 */
export interface ModulePanelBox {
  left: number;
  top: number;
  scale: number;
  width: number;
  height: number;
}

export function modulePanelBoxInSlot(
  slotBox: FrontPanelBoxPx,
  layout: { width: number; gridHeight: number },
  inset: { left: number; top: number; right: number; bottom: number } = MODULE_SLOT_INSET,
): ModulePanelBox {
  const innerLeft = slotBox.left + inset.left;
  const innerTop = slotBox.top + inset.top;
  const innerWidth = Math.max(1, slotBox.width - inset.left - inset.right);
  const innerHeight = Math.max(1, slotBox.height - inset.top - inset.bottom);
  const scale = Math.min(
    innerWidth / Math.max(layout.width, 1),
    innerHeight / Math.max(layout.gridHeight, 1),
  );
  return {
    left: innerLeft,
    top: innerTop,
    scale,
    width: layout.width * scale,
    height: layout.gridHeight * scale,
  };
}

/** Âncora de uma porta da placa dentro do slot (mesma caixa do desenho). */
export function modulePortAnchorPx(
  moduleBox: ModulePanelBox,
  placed: { x: number; y: number; shape: { width: number; height: number } },
): { x: number; y: number } {
  return {
    x: moduleBox.left + (placed.x + placed.shape.width / 2) * moduleBox.scale,
    y: moduleBox.top + (placed.y + placed.shape.height / 2) * moduleBox.scale,
  };
}

/**
 * Validação do mapa do chassi. Um mapa sem imagem continua válido (serve de
 * estrutura lógica), mas nomes duplicados e bbox fora de `0..1` são erro.
 */
export function validateModularChassisMap(map: ModularChassisMap): string[] {
  const errors: string[] = [];

  if (map.slots.length !== map.serviceSlotCount) {
    errors.push(
      `${map.catalogKey}: esperado ${map.serviceSlotCount} slots, obtido ${map.slots.length}`,
    );
  }

  const keys = new Set<string>();
  const ordinals = new Set<number>();
  for (const slot of map.slots) {
    if (keys.has(slot.slotKey)) errors.push(`${map.catalogKey}: slot duplicado ${slot.slotKey}`);
    keys.add(slot.slotKey);
    if (ordinals.has(slot.ordinal)) {
      errors.push(`${map.catalogKey}: ordinal duplicado ${slot.ordinal}`);
    }
    ordinals.add(slot.ordinal);

    const b = slot.bbox;
    if (
      b.x < 0 ||
      b.y < 0 ||
      b.width <= 0 ||
      b.height <= 0 ||
      b.x + b.width > 1 ||
      b.y + b.height > 1
    ) {
      errors.push(`${map.catalogKey}: ${slot.slotKey} fora da área normalizada`);
    }
  }

  for (const [left, right] of overlappingChassisSlotPairs(map)) {
    errors.push(`${map.catalogKey}: overlap ${left} x ${right}`);
  }

  return errors;
}
