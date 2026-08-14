'use client';

import { Badge, Button } from '@gmj/ui';
import { Compass, Settings, Sparkles } from 'lucide-react';
import { useMapStore } from '@/store/map-store';

export function TopBar() {
  const map = useMapStore((state) => state.map);
  const editMode = useMapStore((state) => state.editMode);
  const setEditMode = useMapStore((state) => state.setEditMode);
  const setPanel = useMapStore((state) => state.setPanel);
  if (!map) return <header className="topbar topbar--loading" />;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark">
          <span />
          <span />
          <span />
        </span>
        <div>
          <strong>GMJ</strong>
          <span>NETVISION</span>
        </div>
      </div>
      <div className="topbar__divider" />
      <div className="map-identity">
        <span>MAPA ATIVO</span>
        <strong>{map.name}</strong>
      </div>
      <Badge tone="hybrid">{map.mode}</Badge>
      <div className="topbar__spacer" />
      <div className="source-status">
        <span className="source-status__dot" />
        <span>FONTE</span>
        <strong>DEMO</strong>
      </div>
      <time title={new Date(map.updatedAt).toLocaleString('pt-BR')}>Atualizado agora</time>
      <Button
        compact
        variant={editMode ? 'primary' : 'secondary'}
        onClick={() => setEditMode(!editMode)}
      >
        <Compass size={15} /> {editMode ? 'Edição ativa' : 'Editar mapa'}
      </Button>
      <Button compact variant="ghost" onClick={() => setPanel('discovery')}>
        <Sparkles size={15} /> Descobrir
      </Button>
      <Button
        compact
        variant="ghost"
        aria-label="Configurações"
        onClick={() => setPanel('settings')}
      >
        <Settings size={16} />
      </Button>
    </header>
  );
}
