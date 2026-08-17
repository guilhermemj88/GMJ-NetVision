'use client';

import { Badge, Button } from '@gmj/ui';
import {
  ChevronDown,
  Compass,
  MapPinned,
  MonitorPlay,
  Server,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useMapStore } from '@/store/map-store';

export function TopBar() {
  const map = useMapStore((state) => state.map);
  const maps = useMapStore((state) => state.maps);
  const activeMapId = useMapStore((state) => state.activeMapId);
  const setActiveMap = useMapStore((state) => state.setActiveMap);
  const editMode = useMapStore((state) => state.editMode);
  const setEditMode = useMapStore((state) => state.setEditMode);
  const setPanel = useMapStore((state) => state.setPanel);
  const view = useMapStore((state) => state.view);
  const setView = useMapStore((state) => state.setView);
  if (!map && view === 'MAP') return <header className="topbar topbar--loading" />;

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
      <nav className="primary-nav">
        <button
          type="button"
          className={view === 'MAP' ? 'is-active' : ''}
          onClick={() => setView('MAP')}
        >
          <MapPinned size={14} /> Mapa
        </button>
        <button
          type="button"
          className={view === 'HOSTS' ? 'is-active' : ''}
          onClick={() => setView('HOSTS')}
        >
          <Server size={14} /> Hosts
        </button>
      </nav>
      {view === 'MAP' && map && (
        <>
          <div className="topbar__divider" />
          <label className="map-selector">
            <span>MAPA ATIVO</span>
            <div>
              <select
                value={activeMapId ?? ''}
                onChange={(event) => setActiveMap(event.target.value)}
              >
                {maps.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </div>
          </label>
          <Button
            compact
            variant="ghost"
            aria-label="Gerenciar mapas"
            onClick={() => setPanel('maps')}
          >
            <MapPinned size={15} />
          </Button>
          <Badge tone="hybrid">{map.mode}</Badge>
        </>
      )}
      <div className="topbar__spacer" />
      <div className="source-status" title="Dados carregados pela API NetVision">
        <span className="source-status__dot" />
        <span>FONTE</span>
        <strong>API</strong>
      </div>
      {map && <time title={new Date(map.updatedAt).toLocaleString('pt-BR')}>Atualizado agora</time>}
      {view === 'MAP' && (
        <>
          <Button compact variant="ghost" onClick={() => setPanel('rotation')}>
            <MonitorPlay size={15} /> NOC
          </Button>
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
        </>
      )}
    </header>
  );
}
