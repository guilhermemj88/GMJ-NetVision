import type { PhysicalAsset, PhysicalCatalogEntry } from '@gmj/shared';
import manifest from './s6730-front-panel-maps-v1.json';
/**
 * Painel frontal por imagem + mapa técnico invisível de portas.
 *
 * A imagem é **somente aparência**. A verdade de posição (clique, tooltip,
 * âncora de cabo) vive no mapa normalizado `0..1`, que aponta para a
 * identidade **estável do catálogo** (`10GE-1`, `QSFP28-1`).
 *
 *     hotspot normalizado → PhysicalPort do template → mappedInterface → UP/DOWN/LLDP/cabo
 *
 * O nome CLI hierárquico (`10GE0/0/1`, `100GE1/0/4`) nunca aparece no mapa: ele
 * chega depois, pelo sync de interfaces já existente.
 */

/** Retângulo normalizado (`0..1`) relativo à imagem do painel. */
export interface FrontPanelNormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrontPanelPortMap {
  /** Nome estável do `PhysicalPort` no catálogo (não é o nome CLI da interface). */
  portName: string;
  connector: string;
  bbox: FrontPanelNormalizedBox;
}

export type FrontPanelMapStatus = 'ACTIVE_TEST' | 'AWAITING_APPROVED_IMAGE';

export interface FrontPanelImageMap {
  catalogKey: string;
  model: string;
  status: FrontPanelMapStatus;
  image?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  expectedPortCount: number;
  ports: FrontPanelPortMap[];
}

interface Manifest {
  version: string;
  coordinateSpace: string;
  maps: FrontPanelImageMap[];
}

const FRONT_PANEL_MANIFEST = manifest as unknown as Manifest;

/** Todos os mapas declarados (ativos ou aguardando imagem aprovada). */
export const FRONT_PANEL_MAPS: readonly FrontPanelImageMap[] = FRONT_PANEL_MANIFEST.maps;

const mapsByCatalogKey = new Map<string, FrontPanelImageMap>(
  FRONT_PANEL_MAPS.map((map) => [map.catalogKey, map]),
);

/**
 * Mapa utilizável para um `catalogKey`.
 *
 * Só devolve mapa **ACTIVE_TEST** com imagem declarada: um template V2 em
 * `AWAITING_APPROVED_IMAGE` continua no renderer geométrico (nada de reutilizar
 * a imagem da versão não-V2 automaticamente).
 */
export function frontPanelImageMap(catalogKey: string | null | undefined): FrontPanelImageMap | null {
  if (!catalogKey) return null;
  const map = mapsByCatalogKey.get(catalogKey) ?? null;
  if (!map || map.status !== 'ACTIVE_TEST' || !map.image) return null;
  return map;
}

/** Mapa do asset (via `template.catalogKey`), quando existir e estiver ativo. */
export function frontPanelImageMapForAsset(
  asset: Pick<PhysicalAsset, 'template'>,
): FrontPanelImageMap | null {
  return frontPanelImageMap(asset.template?.catalogKey);
}

/** `true` quando o template usa painel por imagem. */
export function hasFrontPanelImage(catalogKey: string | null | undefined): boolean {
  return frontPanelImageMap(catalogKey) !== null;
}

/** Motivo pelo qual um `catalogKey` conhecido não está ativo (para a preview). */
export function frontPanelMapStatus(catalogKey: string | null | undefined): FrontPanelMapStatus | null {
  if (!catalogKey) return null;
  return mapsByCatalogKey.get(catalogKey)?.status ?? null;
}

/** Centro do **mesmo** bbox usado pelo hitbox: visual = clique = âncora do cabo. */
export function normalizedPortAnchor(bbox: FrontPanelNormalizedBox): { x: number; y: number } {
  return {
    x: bbox.x + bbox.width / 2,
    y: bbox.y + bbox.height / 2,
  };
}

function loose(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.\-/]+/g, '');
}

/** Identidade mínima necessária para casar o hotspot com uma porta. */
export interface FrontPanelPortIdentity {
  name: string;
  label?: string | null;
}

/**
 * Resolve `hotspot → porta` já materializada pelo template.
 *
 * Compara com `name` e `label` (exato e tolerante a separadores) para absorver
 * diferenças de formatação do catálogo, sem inventar entidades novas.
 */
export function resolveMappedPhysicalPort<T extends FrontPanelPortIdentity>(
  ports: readonly T[],
  map: FrontPanelPortMap,
): T | null {
  const exact = ports.find((port) => port.name === map.portName || port.label === map.portName);
  if (exact) return exact;

  const wanted = loose(map.portName);
  return (
    ports.find((port) => loose(port.name) === wanted || loose(port.label ?? '') === wanted) ?? null
  );
}

/** Portas do catálogo do template que o mapa cobre, na ordem do mapa. */
export function resolvedMapPorts(
  entry: Pick<PhysicalCatalogEntry, 'ports'>,
  map: FrontPanelImageMap,
): { mapped: FrontPanelPortMap; port: PhysicalCatalogEntry['ports'][number] }[] {
  return map.ports.flatMap((mapped) => {
    const port = resolveMappedPhysicalPort(entry.ports, mapped);
    return port ? [{ mapped, port }] : [];
  });
}

/**
 * Caminho inverso: `PhysicalPort → hotspot`. Usado para ancorar o cabo no
 * centro do bbox **daquela** porta, sem varrer geometria paralela.
 */
export function frontPanelPortMapFor(
  map: FrontPanelImageMap,
  port: FrontPanelPortIdentity,
): FrontPanelPortMap | null {
  const names = [port.name, port.label ?? ''].filter(Boolean);
  const exact = map.ports.find((candidate) => names.includes(candidate.portName));
  if (exact) return exact;
  const looseNames = new Set(names.map(loose));
  return map.ports.find((candidate) => looseNames.has(loose(candidate.portName))) ?? null;
}

export function boxesOverlap(a: FrontPanelNormalizedBox, b: FrontPanelNormalizedBox): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** Pares de hotspots que se sobrepõem (deve ser vazio em mapa aprovado). */
export function overlappingMapPairs(map: FrontPanelImageMap): [string, string][] {
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

/**
 * Validação do manifesto. Um mapa `AWAITING_APPROVED_IMAGE` não é validado:
 * ele existe apenas para registrar que a imagem oficial ainda não foi aprovada.
 */
export function validateFrontPanelMap(map: FrontPanelImageMap): string[] {
  const errors: string[] = [];
  if (map.status !== 'ACTIVE_TEST') return errors;

  if (!map.image) errors.push(`${map.catalogKey}: sem imagem declarada`);

  if (map.ports.length !== map.expectedPortCount) {
    errors.push(`${map.catalogKey}: esperado ${map.expectedPortCount} portas, obtido ${map.ports.length}`);
  }

  const seen = new Set<string>();
  for (const port of map.ports) {
    if (seen.has(port.portName)) errors.push(`${map.catalogKey}: porta duplicada ${port.portName}`);
    seen.add(port.portName);
    const b = port.bbox;
    if (
      b.x < 0 ||
      b.y < 0 ||
      b.width <= 0 ||
      b.height <= 0 ||
      b.x + b.width > 1 ||
      b.y + b.height > 1
    ) {
      errors.push(`${map.catalogKey}: ${port.portName} fora da imagem normalizada`);
    }
  }

  for (const [left, right] of overlappingMapPairs(map)) {
    errors.push(`${map.catalogKey}: overlap ${left} x ${right}`);
  }

  return errors;
}

/** Contagem por família de conector — usada no card da preview. */
export function connectorTally(map: FrontPanelImageMap): Map<string, number> {
  const tally = new Map<string, number>();
  for (const port of map.ports) {
    tally.set(port.connector, (tally.get(port.connector) ?? 0) + 1);
  }
  return tally;
}

/** Retângulo do painel em pixels do canvas (a MESMA caixa usada para desenhar). */
export interface FrontPanelBoxPx {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Proporção natural da imagem (largura / altura) — o painel nunca distorce. */
export function frontPanelAspectRatio(map: FrontPanelImageMap): number {
  const width = map.naturalWidth ?? 0;
  const height = map.naturalHeight ?? 0;
  if (width > 0 && height > 0) return width / height;
  return 7.2;
}

/**
 * Âncora do cabo em pixels do canvas: centro do **mesmo** bbox usado pelo
 * hitbox (`left + x * width`), nunca uma geometria paralela.
 */
export function frontPanelAnchorPx(
  map: FrontPanelImageMap,
  portName: string,
  box: FrontPanelBoxPx,
): { x: number; y: number } | null {
  const port = map.ports.find((candidate) => candidate.portName === portName);
  if (!port) return null;
  const anchor = normalizedPortAnchor(port.bbox);
  return { x: box.left + anchor.x * box.width, y: box.top + anchor.y * box.height };
}
