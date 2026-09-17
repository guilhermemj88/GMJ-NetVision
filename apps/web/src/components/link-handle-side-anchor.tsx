'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EdgeLabelRenderer, useViewport } from '@xyflow/react';
import { LINK_HANDLE_SIDES, LINK_HANDLE_SIDE_LABELS, type LinkHandleSide, type NetworkLink } from '@gmj/shared';
import { persistLinkPatch } from '@/lib/link-persistence';
import { useMapStore } from '@/store/map-store';

const SIDE_SHORT: Record<LinkHandleSide, string> = {
  AUTO: 'A',
  TOP: 'T',
  RIGHT: 'R',
  BOTTOM: 'B',
  LEFT: 'L',
};

function sideLabel(side: LinkHandleSide): string {
  return LINK_HANDLE_SIDE_LABELS.find((option) => option.value === side)?.label ?? side;
}

/**
 * Small control drawn on top of each end of the selected link. Clicking cycles
 * the connection side (`AUTO → TOP → RIGHT → BOTTOM → LEFT → AUTO`) and persists
 * it immediately, without ever touching the logical endpoints of the link.
 */
export function LinkHandleSideAnchor({
  link,
  end,
  point,
}: {
  link: NetworkLink;
  end: 'SOURCE' | 'TARGET';
  point: { x: number; y: number };
}) {
  const { zoom } = useViewport();
  const client = useQueryClient();
  const replaceLink = useMapStore((state) => state.replaceLink);
  const showToast = useMapStore((state) => state.showToast);
  const [pending, setPending] = useState(false);
  const current: LinkHandleSide =
    end === 'SOURCE' ? (link.sourceHandleSide ?? 'AUTO') : (link.targetHandleSide ?? 'AUTO');
  const index = LINK_HANDLE_SIDES.indexOf(current);
  const next = LINK_HANDLE_SIDES[(index + 1) % LINK_HANDLE_SIDES.length] ?? 'AUTO';
  const sideName = end === 'SOURCE' ? 'ponta A' : 'ponta B';

  const mutation = useMutation({
    mutationFn: () =>
      persistLinkPatch(client, link, end === 'SOURCE' ? { sourceHandleSide: next } : { targetHandleSide: next }),
    onMutate: () => setPending(true),
    onSuccess: (updated) => replaceLink(updated),
    onError: () => showToast('Não foi possível alterar a conexão do enlace. Tente novamente.'),
    onSettled: () => setPending(false),
  });

  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        className={`link-handle-anchor link-handle-anchor--${end.toLowerCase()} nodrag nopan`}
        title={`Conexão da ${sideName}: ${sideLabel(current)} — clique para ${sideLabel(next)}`}
        aria-label={`Conexão da ${sideName}: ${sideLabel(current)}. Alterar para ${sideLabel(next)}`}
        data-side={current}
        data-end={end}
        disabled={pending}
        style={{
          transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px) scale(${1 / Math.max(zoom, 0.01)})`,
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (!pending) mutation.mutate();
        }}
      >
        {SIDE_SHORT[current]}
      </button>
    </EdgeLabelRenderer>
  );
}
