import type { LinkLayoutMode } from './types';

/**
 * Automatic separation of "sibling" links that share the same node pair.
 *
 * When two or more links connect the same two endpoints they would normally be
 * drawn on top of each other. This module computes a small, stable,
 * perpendicular offset for each sibling so they fan out as gentle arcs while
 * keeping single links perfectly straight.
 *
 * The comparison is direction-agnostic: A→B and B→A belong to the same visual
 * group. The returned offset is expressed in the link's own source→target
 * normal space (the sign is already orientation-corrected), so a renderer can
 * add it directly to whatever perpendicular offset it already applies.
 */

export interface LinkParallelLayoutInput {
  id: string;
  /** Canonical endpoint key of the source (device id or node id). */
  sourceKey: string;
  /** Canonical endpoint key of the target (device id or node id). */
  targetKey: string;
  layoutMode: LinkLayoutMode;
}

export interface LinkParallelLayout {
  siblingCount: number;
  siblingIndex: number;
  /**
   * Perpendicular offset in the link's own source→target normal space.
   * Zero for MANUAL links and for links without siblings.
   */
  offset: number;
}

/** Stable, direction-agnostic group key for a node pair. */
export function parallelGroupKey(sourceKey: string, targetKey: string): string {
  const a = sourceKey || '\u0000';
  const b = targetKey || '\u0000';
  return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
}

/**
 * Symmetric perpendicular offsets (pixels) for a group of `count` siblings.
 * Values are intentionally gentle so the map stays clean.
 */
export function parallelOffsets(count: number): number[] {
  const total = Math.max(1, Math.trunc(count));
  if (total === 1) return [0];
  if (total === 2) return [-18, 18];
  if (total === 3) return [0, -26, 26];
  if (total === 4) return [-36, -12, 12, 36];
  // 5+: progressive spacing, capped so very dense groups stay legible.
  const spacing = Math.min(24, 14 + total);
  return Array.from({ length: total }, (_, index) => (index - (total - 1) / 2) * spacing);
}

/**
 * Computes the automatic parallel layout for every provided link.
 * The result is deterministic: siblings are ordered by id before assignment.
 */
export function computeParallelLinkLayouts(
  links: readonly LinkParallelLayoutInput[],
): Map<string, LinkParallelLayout> {
  const groups = new Map<string, LinkParallelLayoutInput[]>();
  for (const link of links) {
    const key = parallelGroupKey(link.sourceKey, link.targetKey);
    const group = groups.get(key);
    if (group) group.push(link);
    else groups.set(key, [link]);
  }

  const result = new Map<string, LinkParallelLayout>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const offsets = parallelOffsets(sorted.length);
    sorted.forEach((link, index) => {
      const worldOffset = offsets[index] ?? 0;
      // The renderer offsets along the link's own normal vector. Links stored
      // in reverse canonical order have an inverted normal, so flip the sign
      // to keep every sibling on the same world-space axis.
      const canonicalForward = link.sourceKey < link.targetKey;
      const offset =
        link.layoutMode === 'MANUAL' ? 0 : worldOffset * (canonicalForward ? 1 : -1);
      result.set(link.id, {
        siblingCount: sorted.length,
        siblingIndex: index,
        offset,
      });
    });
  }
  return result;
}
