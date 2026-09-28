'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LinkHandleSide } from '@gmj/shared';
import { Move3d, PencilRuler, RotateCcw, Undo2 } from 'lucide-react';
import { persistLinkPatch, type LinkCanvasPatch } from '@/lib/link-persistence';
import { resetLinkGeometry } from '@/lib/link-curvature';
import { useMapStore } from '@/store/map-store';

const HANDLE_SIDES: Array<{ value: LinkHandleSide; label: string }> = [
  { value: 'AUTO', label: 'Automático' },
  { value: 'TOP', label: 'Topo' },
  { value: 'RIGHT', label: 'Direita' },
  { value: 'BOTTOM', label: 'Base' },
  { value: 'LEFT', label: 'Esquerda' },
];

/**
 * Geometria do enlace selecionado, direto na rail.
 *
 * Antes era preciso selecionar o enlace, entrar em modo edição e abrir "Editar
 * enlace" no inspetor para achar curvatura/pontas. Aqui as mesmas ações ficam a
 * um clique, usando exatamente o mesmo PATCH (`persistLinkPatch`) e o mesmo modo
 * edição do canvas — nenhuma implementação paralela, nenhum dado novo.
 */
export function LinkGeometryControls() {
  const map = useMapStore((state) => state.map);
  const selection = useMapStore((state) => state.selection);
  const editMode = useMapStore((state) => state.editMode);
  const readOnly = useMapStore((state) => state.readOnly);
  const setEditMode = useMapStore((state) => state.setEditMode);
  const setLinkGeometryDraft = useMapStore((state) => state.setLinkGeometryDraft);
  const linkGeometryDrafts = useMapStore((state) => state.linkGeometryDrafts);
  const showToast = useMapStore((state) => state.showToast);
  const client = useQueryClient();
  const [curvatureInput, setCurvatureInput] = useState<string | null>(null);

  const link = useMemo(
    () =>
      selection?.kind === 'link' ? map?.links.find((item) => item.id === selection.id) : undefined,
    [map?.links, selection],
  );

  if (readOnly) return null;

  if (!link) {
    return (
      <div className="link-geometry link-geometry--empty">
        <p>
          Selecione um enlace no mapa para editar curvatura, pontas e geometria. As conexões
          continuam exatamente as que já estão salvas.
        </p>
        <button type="button" onClick={() => setEditMode(true)} disabled={editMode}>
          <PencilRuler size={12} />
          {editMode ? 'Modo edição ativo' : 'Ativar modo edição'}
        </button>
      </div>
    );
  }

  const busy = Boolean(linkGeometryDrafts[link.id]);
  const primaryPath = link.visualPaths[0];
  const curvature = primaryPath?.curvature ?? 0;
  const value = curvatureInput ?? String(curvature);

  const applyPatch = async (patch: LinkCanvasPatch, options?: { message?: string }) => {
    const original = {
      visualPaths: link.visualPaths,
      linkLayoutMode: link.linkLayoutMode,
    };
    setLinkGeometryDraft(link.id, {
      visualPaths: patch.visualPaths ?? link.visualPaths,
      linkLayoutMode: patch.linkLayoutMode ?? link.linkLayoutMode,
    });
    try {
      await persistLinkPatch(client, link, patch);
      setLinkGeometryDraft(link.id, null);
      if (options?.message) showToast(options.message);
    } catch {
      setLinkGeometryDraft(link.id, original);
      setLinkGeometryDraft(link.id, null);
      showToast('Não foi possível salvar a geometria do enlace');
    }
  };

  const setHandleSide = (end: 'source' | 'target', side: LinkHandleSide) => {
    void applyPatch(end === 'source' ? { sourceHandleSide: side } : { targetHandleSide: side });
  };

  return (
    <div className="link-geometry">
      <p className="link-geometry__title" title={link.label ?? undefined}>
        {link.label?.trim() || 'Enlace selecionado'}
      </p>
      <p className="link-geometry__meta">
        {link.linkLayoutMode === 'MANUAL' ? 'Geometria manual' : 'Geometria automática'} ·{' '}
        {link.visualPaths.length} caminho(s) · curvatura {Math.round(curvature)} px
      </p>

      <div className="link-geometry__sides">
        <label>
          Ponta A
          <select
            value={link.sourceHandleSide ?? 'AUTO'}
            disabled={busy}
            onChange={(event) => setHandleSide('source', event.target.value as LinkHandleSide)}
          >
            {HANDLE_SIDES.map((side) => (
              <option key={side.value} value={side.value}>
                {side.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ponta B
          <select
            value={link.targetHandleSide ?? 'AUTO'}
            disabled={busy}
            onChange={(event) => setHandleSide('target', event.target.value as LinkHandleSide)}
          >
            {HANDLE_SIDES.map((side) => (
              <option key={side.value} value={side.value}>
                {side.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="link-geometry__curvature">
        <span>Curvatura (caminho 1)</span>
        <input
          type="number"
          step="10"
          min="-500"
          max="500"
          value={value}
          disabled={busy}
          onChange={(event) => setCurvatureInput(event.target.value)}
        />
        <button
          type="button"
          disabled={busy || Number(value) === curvature}
          onClick={() => {
            const next = Number(value);
            if (!Number.isFinite(next)) return;
            void applyPatch({
              visualPaths: link.visualPaths.map((path, index) =>
                index === 0 ? { ...path, curvature: next } : path,
              ),
            });
            setCurvatureInput(null);
          }}
        >
          Aplicar
        </button>
      </label>

      <div className="link-geometry__actions">
        <button
          type="button"
          className="is-primary"
          onClick={() => {
            setEditMode(true);
            showToast('Modo edição ativo: arraste a alça da curva no mapa');
          }}
        >
          <Move3d size={12} /> Editar curvatura no mapa
        </button>
        <button
          type="button"
          disabled={busy}
          title="Zera a curvatura de todos os caminhos, mantendo o modo manual"
          onClick={() => {
            const reset = resetLinkGeometry(link);
            void applyPatch(
              { visualPaths: reset.visualPaths, linkLayoutMode: reset.linkLayoutMode },
              { message: 'Geometria do enlace resetada' },
            );
          }}
        >
          <RotateCcw size={12} /> Resetar geometria
        </button>
        <button
          type="button"
          disabled={busy}
          title="Volta o enlace para a geometria automática (AUTO), com curvatura zero"
          onClick={() => {
            const reset = resetLinkGeometry(link, true);
            void applyPatch(
              { visualPaths: reset.visualPaths, linkLayoutMode: reset.linkLayoutMode },
              { message: 'Enlace de volta ao posicionamento automático' },
            );
          }}
        >
          <Undo2 size={12} /> Voltar ao automático
        </button>
      </div>
      <p className="link-geometry__hint">
        No mapa: arraste a alça do meio da curva; as pontas usam os handles existentes e os smart
        guides continuam iguais.
      </p>
    </div>
  );
}
