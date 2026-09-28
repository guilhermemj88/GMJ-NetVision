/**
 * Deslocamento **visual** das labels de tráfego — uma por direção/lane.
 *
 * O que é: um par `{dx, dy}` em unidades de fluxo (as mesmas coordenadas dos
 * nós), aplicado por cima da posição calculada da label. Serve só para o
 * operador afastar um texto que ficou em cima do outro.
 *
 * O que NÃO é: não altera topologia, não muda a geometria do enlace, não toca
 * em métricas nem em `MapSettings` do mapa. Por isso vive em `localStorage`
 * (chave por mapa), no mesmo padrão das outras preferências de leitura do
 * módulo (painel de alarmes, ícone do equipamento, rail recolhida).
 */

export type TrafficLabelLane = 'a' | 'b';

export interface TrafficLabelOffset {
  dx: number;
  dy: number;
}

export type TrafficLabelOffsets = Record<
  string,
  Partial<Record<TrafficLabelLane, TrafficLabelOffset>>
>;

export const TRAFFIC_LABEL_OFFSETS_PREFIX = 'gmj:traffic-labels:';

const TRAFFIC_LABEL_OFFSETS_EVENT = 'gmj:traffic-labels-change';

/** Limite defensivo: um label arrastado nunca precisa sair de ~4 mil px. */
const MAX_OFFSET = 4000;

const EMPTY: TrafficLabelOffsets = Object.freeze({});

export function trafficLabelOffsetsKey(mapId: string): string {
  return `${TRAFFIC_LABEL_OFFSETS_PREFIX}${mapId}`;
}

function clampOffset(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(value * 10) / 10));
}

function parseOffset(value: unknown): TrafficLabelOffset | null {
  if (!value || typeof value !== 'object') return null;
  const dx = clampOffset((value as { dx?: unknown }).dx);
  const dy = clampOffset((value as { dy?: unknown }).dy);
  if (dx === null || dy === null) return null;
  if (dx === 0 && dy === 0) return null;
  return { dx, dy };
}

/** Aceita só o formato esperado; qualquer ruído no storage é descartado. */
export function parseTrafficLabelOffsets(raw: string | null): TrafficLabelOffsets {
  if (!raw) return EMPTY;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return EMPTY;
  const result: TrafficLabelOffsets = {};
  for (const [linkId, lanes] of Object.entries(data as Record<string, unknown>)) {
    if (!linkId || !lanes || typeof lanes !== 'object') continue;
    const entry: Partial<Record<TrafficLabelLane, TrafficLabelOffset>> = {};
    for (const lane of ['a', 'b'] as const) {
      const offset = parseOffset((lanes as Record<string, unknown>)[lane]);
      if (offset) entry[lane] = offset;
    }
    if (entry.a || entry.b) result[linkId] = entry;
  }
  return Object.keys(result).length ? result : EMPTY;
}

function read(mapId: string): TrafficLabelOffsets {
  try {
    return parseTrafficLabelOffsets(window.localStorage.getItem(trafficLabelOffsetsKey(mapId)));
  } catch {
    // Storage indisponível (contexto restrito): o mapa segue sem deslocamento.
    return EMPTY;
  }
}

let cache: { mapId: string; raw: string | null; value: TrafficLabelOffsets } | null = null;

/**
 * Snapshot estável por mapa — `useSyncExternalStore` exige a MESMA referência
 * enquanto nada mudou, então o último resultado fica em cache.
 */
export function getTrafficLabelOffsets(mapId: string | null | undefined): TrafficLabelOffsets {
  if (!mapId || typeof window === 'undefined') return EMPTY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(trafficLabelOffsetsKey(mapId));
  } catch {
    return EMPTY;
  }
  if (cache && cache.mapId === mapId && cache.raw === raw) return cache.value;
  const value = parseTrafficLabelOffsets(raw);
  cache = { mapId, raw, value };
  return value;
}

export function trafficLabelOffset(
  offsets: TrafficLabelOffsets | null | undefined,
  linkId: string,
  lane: TrafficLabelLane,
): TrafficLabelOffset | null {
  return offsets?.[linkId]?.[lane] ?? null;
}

/** Quantas labels (pares link+direção) estão deslocadas neste mapa. */
export function countTrafficLabelOffsets(offsets: TrafficLabelOffsets | null | undefined): number {
  if (!offsets) return 0;
  return Object.values(offsets).reduce(
    (total, lanes) => total + (lanes.a ? 1 : 0) + (lanes.b ? 1 : 0),
    0,
  );
}

function write(mapId: string, offsets: TrafficLabelOffsets): void {
  try {
    if (Object.keys(offsets).length === 0) {
      window.localStorage.removeItem(trafficLabelOffsetsKey(mapId));
    } else {
      window.localStorage.setItem(trafficLabelOffsetsKey(mapId), JSON.stringify(offsets));
    }
  } catch {
    // Sem storage a alteração vale só para a sessão atual (o evento já sai).
  }
  cache = null;
  window.dispatchEvent(new CustomEvent(TRAFFIC_LABEL_OFFSETS_EVENT, { detail: { mapId } }));
}

/**
 * Grava (ou limpa, com `null`) o deslocamento de UMA lane. Não encosta nas
 * outras direções do mesmo enlace nem em outros enlaces.
 */
export function setTrafficLabelOffset(
  mapId: string | null | undefined,
  linkId: string,
  lane: TrafficLabelLane,
  offset: TrafficLabelOffset | null,
): void {
  if (!mapId || typeof window === 'undefined' || !linkId) return;
  const current = read(mapId);
  const entry = { ...(current[linkId] ?? {}) };
  const normalized = parseOffset(offset ?? undefined);
  if (normalized) entry[lane] = normalized;
  else delete entry[lane];
  const next: TrafficLabelOffsets = { ...current };
  if (entry.a || entry.b) next[linkId] = entry;
  else delete next[linkId];
  write(mapId, next);
}

/** Reset global: limpa todas as labels deslocadas do mapa atual. */
export function resetTrafficLabelOffsets(mapId: string | null | undefined): void {
  if (!mapId || typeof window === 'undefined') return;
  write(mapId, {});
}

export function subscribeTrafficLabelOffsets(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onLocal = () => onStoreChange();
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key.startsWith(TRAFFIC_LABEL_OFFSETS_PREFIX)) onStoreChange();
  };
  window.addEventListener(TRAFFIC_LABEL_OFFSETS_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(TRAFFIC_LABEL_OFFSETS_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}
