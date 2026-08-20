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
import {
  deleteDevice,
  deleteLink,
  deleteMapNode,
  savePositions,
  updateNetworkMap,
} from '@/lib/api';
import { useMapStore } from '@/store/map-store';

export function EditToolbar() {
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

  const removeSelected = () => {
    if (selection?.kind === 'link') {
      removeLink(selection.id);
      void deleteLink(map.id, selection.id).catch(() => undefined);
      showToast('Enlace removido');
    } else if (selection?.kind === 'node') {
      removeNode(selection.id);
      void deleteMapNode(map.id, selection.id).catch(() => undefined);
      showToast('Node removido');
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
      <Button compact variant="ghost" onClick={() => setPanel('add-generic-node')}>
        <Plus size={15} /> Node conceitual
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
