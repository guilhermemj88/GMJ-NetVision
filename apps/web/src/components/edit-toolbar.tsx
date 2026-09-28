'use client';

import { Button } from '@gmj/ui';
import { useState } from 'react';
import { ConfirmDialog } from '@gmj/ui';
import {
  AlignHorizontalDistributeCenter,
  Cable,
  LockKeyhole,
  Plus,
  Radar,
  Save,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useReactFlow } from '@xyflow/react';
import { createAutoLayout } from '@/lib/layout';
import {
  deleteDevice,
  deleteLink,
  deleteMapNode,
  savePositions,
  updateNetworkMap,
} from '@/lib/api';
import { useMapStore } from '@/store/map-store';

export function EditToolbar() {
  const [pendingRemoval, setPendingRemoval] = useState<
    { kind: 'link' | 'node' | 'device'; id: string; label: string } | null
  >(null);
  const flow = useReactFlow();
  const map = useMapStore((state) => state.map);
  const selection = useMapStore((state) => state.selection);
  const setPanel = useMapStore((state) => state.setPanel);
  const setNodeLocked = useMapStore((state) => state.setNodeLocked);
  const applyLayout = useMapStore((state) => state.applyLayout);
  const removeDevice = useMapStore((state) => state.removeDevice);
  const removeNode = useMapStore((state) => state.removeNode);
  const removeLink = useMapStore((state) => state.removeLink);
  const setMap = useMapStore((state) => state.setMap);
  const markSaved = useMapStore((state) => state.markSaved);
  const showToast = useMapStore((state) => state.showToast);
  const dirty = useMapStore((state) => state.dirty);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!map) return;
      await updateNetworkMap(map.id, { settings: map.settings });
      return savePositions(
        map.id,
        map.nodes.map((node) => ({
          nodeId: node.id,
          position: node.position,
          positionSource: node.positionSource,
          locked: node.locked,
        })),
      );
    },
    onSuccess: (savedMap) => {
      if (savedMap) setMap(savedMap);
      markSaved();
    },
    onError: () => {
      showToast('Falha ao salvar mapa no servidor');
    },
  });

  if (!map) return null;
  const selectedNode =
    selection?.kind === 'device' || selection?.kind === 'node'
      ? map.nodes.find((node) => (node.deviceId ?? node.id) === selection.id)
      : undefined;

  const requestRemoval = () => {
    if (!selection) return;
    if (selection.kind === 'link') {
      const link = map.links.find((item) => item.id === selection.id);
      setPendingRemoval({
        kind: 'link',
        id: selection.id,
        label: link?.label?.trim() || 'enlace selecionado',
      });
      return;
    }
    if (selection.kind === 'node') {
      const node = map.nodes.find((item) => item.id === selection.id);
      setPendingRemoval({
        kind: 'node',
        id: selection.id,
        label: node?.label || node?.genericType || 'node conceitual',
      });
      return;
    }
    if (selection.kind === 'device') {
      const device = map.devices.find((item) => item.id === selection.id);
      setPendingRemoval({
        kind: 'device',
        id: selection.id,
        label: device?.name || 'equipamento',
      });
    }
  };

  const confirmRemoval = () => {
    if (!pendingRemoval) return;
    if (pendingRemoval.kind === 'link') {
      removeLink(pendingRemoval.id);
      void deleteLink(map.id, pendingRemoval.id).catch(() => undefined);
      showToast('Enlace removido');
    } else if (pendingRemoval.kind === 'node') {
      removeNode(pendingRemoval.id);
      void deleteMapNode(map.id, pendingRemoval.id).catch(() => undefined);
      showToast('Node removido');
    } else {
      removeDevice(pendingRemoval.id);
      void deleteDevice(map.id, pendingRemoval.id).catch(() => undefined);
      showToast('Equipamento removido');
    }
    setPendingRemoval(null);
  };

  const autoLayout = () => {
    applyLayout(createAutoLayout(map));
    window.setTimeout(() => flow.fitView({ padding: 0.18, duration: 600 }), 40);
    showToast('Mapa auto-organizado; posições manuais preservadas');
  };

  return (
    <div className="edit-toolbar">
      <span className="edit-toolbar__mode">
        <i /> MODO EDIÇÃO
      </span>
      <div className="edit-toolbar__separator" />
      <Button compact variant="ghost" onClick={() => setPanel('add-device')}>
        <Plus size={15} /> Equipamento
      </Button>
      <Button compact variant="ghost" onClick={() => setPanel('add-generic-node')}>
        <Plus size={15} /> Node conceitual
      </Button>
      <Button compact variant="ghost" onClick={() => setPanel('create-link')}>
        <Cable size={15} /> Criar enlace
      </Button>
      <Button compact variant="ghost" disabled={!selection} onClick={requestRemoval}>
        <Trash2 size={15} /> Excluir
      </Button>
      <div className="edit-toolbar__separator" />
      <Button compact variant="ghost" onClick={autoLayout}>
        <AlignHorizontalDistributeCenter size={15} /> Auto-layout
      </Button>
      <Button
        compact
        variant="ghost"
        disabled={!selectedNode || selectedNode.locked}
        onClick={() => selectedNode && setNodeLocked(selectedNode.id, true)}
      >
        <LockKeyhole size={14} /> Lock
      </Button>
      <Button
        compact
        variant="ghost"
        disabled={!selectedNode?.locked}
        onClick={() => selectedNode && setNodeLocked(selectedNode.id, false)}
      >
        <UnlockKeyhole size={14} /> Unlock
      </Button>
      <Button compact variant="ghost" onClick={() => setPanel('discovery')}>
        <Radar size={15} /> Vizinhos
      </Button>
      <div className="edit-toolbar__spacer" />
      {dirty ? (
        <span
          className="edit-toolbar__dirty"
          title="As alterações ficam locais até você salvar; o refresh do mapa não as sobrescreve"
        >
          Alterações não salvas
        </span>
      ) : null}
      <Button
        compact
        variant={dirty ? 'primary' : 'secondary'}
        disabled={saveMutation.isPending}
        onClick={() => saveMutation.mutate()}
      >
        <Save size={15} /> {saveMutation.isPending ? 'Salvando…' : 'Salvar'}
      </Button>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title={
          pendingRemoval?.kind === 'device'
            ? 'Remover equipamento do mapa?'
            : pendingRemoval?.kind === 'link'
              ? 'Excluir enlace?'
              : 'Remover node conceitual?'
        }
        description={
          pendingRemoval?.kind === 'device'
            ? 'O equipamento sai deste mapa. Ele continua no inventário global e em outros mapas.'
            : pendingRemoval?.kind === 'link'
              ? 'O enlace é removido do mapa. Interfaces e equipamentos não são alterados.'
              : 'O node conceitual é removido do mapa, junto com os enlaces ligados a ele.'
        }
        details={<span>{pendingRemoval?.label}</span>}
        confirmLabel={pendingRemoval?.kind === 'device' ? 'Remover do mapa' : 'Excluir'}
        onConfirm={confirmRemoval}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}
