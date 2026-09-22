import manifest from './olt-module-front-panel-maps-v1.json';
import {
  type FrontPanelImageMap,
  type FrontPanelImageStatus,
  type FrontPanelNormalizedBox,
  type FrontPanelPortMap,
  boxesOverlap,
} from './front-panel-image-map';

/**
 * Painel frontal por imagem das **placas/módulos** instalados em slots de
 * chassis modular (OLTs Huawei).
 *
 * Mesmo princípio do painel por imagem de um equipamento fixo: a imagem é só
 * aparência e a verdade de posição (hitbox, clique, âncora do cabo) vive no
 * mapa normalizado `0..1`, apontando para o nome **estável** da porta do
 * catálogo (`GPON-1`, `XGSPON-7`, `10GE-2`, `GE-1`…).
 *
 * Nenhum template de módulo é inventado aqui: enquanto o catálogo não declarar
 * o módulo, o mapa serve de estrutura visual (e a preview mostra os hotspots
 * como declarados, sem correspondência).
 */

export type ModuleMappingMode = 'FRONT_EXACT' | 'FRONT_APPROX' | 'LOGICAL';

export interface ModuleFrontPanelMap {
  /** Chave estável do módulo (`huawei-gpfd-16`). */
  moduleKey: string;
  label: string;
  family: string;
  partNumber?: string | null;
  mappingMode: ModuleMappingMode;
  imageStatus: FrontPanelImageStatus;
  image: string;
  naturalWidth: number;
  naturalHeight: number;
  expectedPortCount: number;
  note?: string;
  ports: FrontPanelPortMap[];
}

interface Manifest {
  schemaVersion: string;
  coordinateSystem: string;
  modules: ModuleFrontPanelMap[];
}

const MODULE_MANIFEST = manifest as unknown as Manifest;

/** Todos os mapas de placa declarados. */
export const MODULE_FRONT_PANEL_MAPS: readonly ModuleFrontPanelMap[] = MODULE_MANIFEST.modules;

const mapsByKey = new Map<string, ModuleFrontPanelMap>(
  MODULE_FRONT_PANEL_MAPS.map((map) => [map.moduleKey, map]),
);

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-/()]+/g, '');
}

/** Chaves pelas quais um módulo pode ser reconhecido no mapa. */
function identityKeys(map: ModuleFrontPanelMap): string[] {
  return [map.moduleKey, map.partNumber ?? '', map.label].filter(Boolean).map(normalize);
}

/** Identidade mínima de um módulo instalado/catalogado. */
export interface ModuleFrontPanelIdentity {
  moduleKey?: string | null;
  partNumber?: string | null;
  model?: string | null;
  name?: string | null;
}

const MIN_LOOSE_LENGTH = 4;

/**
 * Mapa da placa por identidade do módulo.
 *
 * Compara `moduleKey`, `partNumber` e `label` de forma tolerante a separadores
 * e a sufixos (ex.: `H901MPSC` casa com o rótulo `H901MPSC (controle)`).
 */
export function moduleFrontPanelMapFor(
  identity: ModuleFrontPanelIdentity | null | undefined,
): ModuleFrontPanelMap | null {
  if (!identity) return null;
  const candidates = [identity.moduleKey, identity.partNumber, identity.model, identity.name]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(normalize);
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const exact = MODULE_FRONT_PANEL_MAPS.find((map) => identityKeys(map).includes(candidate));
    if (exact) return exact;
  }

  for (const candidate of candidates) {
    if (candidate.length < MIN_LOOSE_LENGTH) continue;
    const loose = MODULE_FRONT_PANEL_MAPS.find((map) =>
      identityKeys(map).some((key) => key.includes(candidate) || candidate.includes(key)),
    );
    if (loose) return loose;
  }
  return null;
}

export function moduleFrontPanelMapByKey(
  moduleKey: string | null | undefined,
): ModuleFrontPanelMap | null {
  if (!moduleKey) return null;
  return mapsByKey.get(moduleKey) ?? null;
}

/** Proporção natural da imagem da placa (fallback 6:1, formato de placa). */
export function moduleFrontPanelAspectRatio(map: ModuleFrontPanelMap): number {
  if (map.naturalWidth > 0 && map.naturalHeight > 0) return map.naturalWidth / map.naturalHeight;
  return 6;
}

/**
 * Adaptação para o renderizador de painel por imagem já existente.
 *
 * O componente `PhysicalImagePanel` (e `frontPanelAnchorPx`) trabalham com
 * `FrontPanelImageMap`; a placa usa exatamente o mesmo formato de portas, então
 * o painel da placa reaproveita hitbox, tooltip, seleção e âncora.
 */
export function moduleFrontPanelImageMap(map: ModuleFrontPanelMap): FrontPanelImageMap {
  return {
    catalogKey: `module:${map.moduleKey}`,
    model: map.label,
    status: 'ACTIVE_TEST',
    imageStatus: map.imageStatus,
    image: map.image,
    naturalWidth: map.naturalWidth,
    naturalHeight: map.naturalHeight,
    expectedPortCount: map.expectedPortCount,
    ports: map.ports,
  };
}

/** Hotspot da placa pelo centro do MESMO bbox usado no hitbox. */
export function modulePortAnchor(
  map: ModuleFrontPanelMap,
  portName: string,
): { x: number; y: number } | null {
  const port = map.ports.find((candidate) => candidate.portName === portName);
  if (!port) return null;
  return { x: port.bbox.x + port.bbox.width / 2, y: port.bbox.y + port.bbox.height / 2 };
}

export function overlappingModulePortPairs(map: ModuleFrontPanelMap): [string, string][] {
  const pairs: [string, string][] = [];
  for (let left = 0; left < map.ports.length; left += 1) {
    for (let right = left + 1; right < map.ports.length; right += 1) {
      const a = map.ports[left]!;
      const b = map.ports[right]!;
      if (boxesOverlap(a.bbox, b.bbox)) pairs.push([a.portName, b.portName]);
    }
  }
  return pairs;
}

function insideImage(bbox: FrontPanelNormalizedBox): boolean {
  return (
    bbox.x >= 0 &&
    bbox.y >= 0 &&
    bbox.width > 0 &&
    bbox.height > 0 &&
    bbox.x + bbox.width <= 1 &&
    bbox.y + bbox.height <= 1
  );
}

/** Validação do mapa da placa (nomes duplicados, bbox e sobreposição). */
export function validateModuleFrontPanelMap(map: ModuleFrontPanelMap): string[] {
  const errors: string[] = [];

  if (!map.image) errors.push(`${map.moduleKey}: sem imagem declarada`);

  if (map.ports.length !== map.expectedPortCount) {
    errors.push(
      `${map.moduleKey}: esperado ${map.expectedPortCount} portas, obtido ${map.ports.length}`,
    );
  }

  const seen = new Set<string>();
  for (const port of map.ports) {
    if (seen.has(port.portName)) errors.push(`${map.moduleKey}: porta duplicada ${port.portName}`);
    seen.add(port.portName);
    if (!insideImage(port.bbox)) {
      errors.push(`${map.moduleKey}: ${port.portName} fora da imagem normalizada`);
    }
  }

  for (const [left, right] of overlappingModulePortPairs(map)) {
    errors.push(`${map.moduleKey}: overlap ${left} x ${right}`);
  }

  return errors;
}
