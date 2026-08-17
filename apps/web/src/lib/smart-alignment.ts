import type { Position } from '@gmj/shared';

export interface AlignmentNode {
  id: string;
  position: Position;
  width: number;
  height: number;
}

export interface AlignmentGuide {
  axis: 'horizontal' | 'vertical';
  coordinate: number;
  start: number;
  end: number;
  targetId: string;
  target: AlignmentNode;
}

export interface SmartAlignmentResult {
  position: Position;
  guides: AlignmentGuide[];
}

interface Candidate {
  delta: number;
  distance: number;
  target: AlignmentNode;
}

function center(node: AlignmentNode): Position {
  return {
    x: node.position.x + node.width / 2,
    y: node.position.y + node.height / 2,
  };
}

function bestCandidate(candidates: Candidate[]): Candidate | undefined {
  return candidates.sort((left, right) =>
    Math.abs(left.delta) - Math.abs(right.delta)
      || left.distance - right.distance
      || left.target.id.localeCompare(right.target.id),
  )[0];
}

/**
 * Aligns node centers in flow coordinates. Callers should convert the desired
 * screen-pixel tolerance by dividing it by the current React Flow zoom.
 */
export function calculateSmartAlignment(
  dragged: AlignmentNode,
  others: AlignmentNode[],
  tolerance: number,
  enabled: boolean,
): SmartAlignmentResult {
  if (!enabled || tolerance <= 0) return { position: dragged.position, guides: [] };

  const draggedCenter = center(dragged);
  const candidates = others.map((target) => {
    const targetCenter = center(target);
    const distance = Math.hypot(targetCenter.x - draggedCenter.x, targetCenter.y - draggedCenter.y);
    return {
      target,
      distance,
      vertical: targetCenter.x - draggedCenter.x,
      horizontal: targetCenter.y - draggedCenter.y,
    };
  });
  const vertical = bestCandidate(candidates
    .filter((item) => Math.abs(item.vertical) <= tolerance)
    .map((item) => ({ delta: item.vertical, distance: item.distance, target: item.target })));
  const horizontal = bestCandidate(candidates
    .filter((item) => Math.abs(item.horizontal) <= tolerance)
    .map((item) => ({ delta: item.horizontal, distance: item.distance, target: item.target })));
  const position = {
    x: dragged.position.x + (vertical?.delta ?? 0),
    y: dragged.position.y + (horizontal?.delta ?? 0),
  };
  const snapped = { ...dragged, position };
  const snappedCenter = center(snapped);
  const guides: AlignmentGuide[] = [];

  if (vertical) {
    const targetCenter = center(vertical.target);
    guides.push({
      axis: 'vertical',
      coordinate: targetCenter.x,
      start: Math.min(snappedCenter.y, targetCenter.y),
      end: Math.max(snappedCenter.y, targetCenter.y),
      targetId: vertical.target.id,
      target: vertical.target,
    });
  }
  if (horizontal) {
    const targetCenter = center(horizontal.target);
    guides.push({
      axis: 'horizontal',
      coordinate: targetCenter.y,
      start: Math.min(snappedCenter.x, targetCenter.x),
      end: Math.max(snappedCenter.x, targetCenter.x),
      targetId: horizontal.target.id,
      target: horizontal.target,
    });
  }

  return { position, guides };
}
