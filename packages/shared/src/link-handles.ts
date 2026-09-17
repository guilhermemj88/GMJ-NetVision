import type { LinkHandleSide } from './types';

/**
 * Manual connection sides shared by the API validation, the persistence layer
 * and the map/drawer UI. Keeping them in one place avoids three drifting lists.
 */
export const LINK_HANDLE_SIDES: readonly LinkHandleSide[] = [
  'AUTO',
  'TOP',
  'RIGHT',
  'BOTTOM',
  'LEFT',
];

export const LINK_HANDLE_SIDE_LABELS: ReadonlyArray<{ value: LinkHandleSide; label: string }> = [
  { value: 'AUTO', label: 'Automática' },
  { value: 'TOP', label: 'Superior' },
  { value: 'RIGHT', label: 'Direita' },
  { value: 'BOTTOM', label: 'Inferior' },
  { value: 'LEFT', label: 'Esquerda' },
];

export function isLinkHandleSide(value: unknown): value is LinkHandleSide {
  return typeof value === 'string' && (LINK_HANDLE_SIDES as readonly string[]).includes(value);
}

/** Links created before this feature (or by an older client) simply mean `AUTO`. */
export function normalizeLinkHandleSide(value: unknown): LinkHandleSide {
  return isLinkHandleSide(value) ? value : 'AUTO';
}
