'use client';

import { Button } from '@gmj/ui';
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
import { deleteDevice, deleteLink, savePositions } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

export function EditToolbar() {
  const flow = useReactFlow();
  const map = useMapStore((state) => state.map);
  const selection = useMapStore((state) => state.selection);
  const setPanel = useMapStore((state) => state.setPanel);
  const setNodeLocked = useMapStore((state) => state.setNodeLocked);
  const applyLayout = useMapStore((state) => state.applyLayout);
  const removeDevice = useMapStore((state) => state.removeDevice);
  const removeLink = useMapStore((state) => state.removeLink);
  const markSaved = useMapStore((state) => state.markSaved);
  const showToast = useMapStore((state) => state.showToast);
  const dirty = useMapStore((state) => state.dirty);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!map) return;
      await savePositions(
        map.id,
        map.nodes.map((node) => ({
          nodeId: node.id,
          position: node.position,
          locked: node.locked,
        })),
      );
    },
    onSuccess: markSaved,
    onError: () => {
      markSaved();
      showToast('Posições salvas localmente (API offline)');
    },
  });

  if (!map) return null;
  const selectedNode =
    selection?.kind === 'device'
      ? map.nodes.find((node) => node.deviceId === selection.id)
      : undefined;

  const removeSelected = () => {
    if (selection?.kind === 'link') {
      removeLink(selection.id);
      void deleteLink(map.id, selection.id).catch(() => undefined);
      showToast('Enlace removido');
    } else if (selection?.kind === 'device') {
      removeDevice(selection.id);
      void deleteDevice(map.id, selection.id).catch(() => undefined);
      showToast('Equipamento removido');
    }
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
      <Button compact variant="ghost" onClick={() => setPanel('create-link')}>
        <Cable size={15} /> Criar enlace
      </Button>
      <Button compact variant="ghost" disabled={!selection} onClick={removeSelected}>
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
      <Button
        compact
        variant={dirty ? 'primary' : 'secondary'}
        disabled={saveMutation.isPending}
        onClick={() => saveMutation.mutate()}
      >
        <Save size={15} /> {saveMutation.isPending ? 'Salvando…' : 'Salvar'}
      </Button>
    </div>
  );
}
