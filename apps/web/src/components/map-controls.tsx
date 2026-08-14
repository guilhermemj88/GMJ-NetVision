'use client';

import { Button } from '@gmj/ui';
import { Focus, Maximize, Minus, Plus } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { useMapStore } from '@/store/map-store';

export function MapControls() {
  const flow = useReactFlow();
  const preferences = useMapStore((state) => state.preferences);
  const setPreference = useMapStore((state) => state.setPreference);

  const fullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  return (
    <div className="map-controls">
      <div className="map-controls__zoom">
        <Button compact variant="ghost" aria-label="Aumentar zoom" onClick={() => flow.zoomIn()}>
          <Plus size={16} />
        </Button>
        <Button compact variant="ghost" aria-label="Diminuir zoom" onClick={() => flow.zoomOut()}>
          <Minus size={16} />
        </Button>
        <Button
          compact
          variant="ghost"
          aria-label="Enquadrar mapa"
          onClick={() => flow.fitView({ padding: 0.14, duration: 500 })}
        >
          <Focus size={16} />
        </Button>
        <Button compact variant="ghost" aria-label="Tela cheia" onClick={() => void fullscreen()}>
          <Maximize size={15} />
        </Button>
      </div>
      <div className="map-controls__toggles">
        {(
          [
            ['showTraffic', 'Tráfego'],
            ['showUtilization', 'Utilização'],
            ['showLabels', 'Labels'],
            ['showOffline', 'Offline'],
            ['showInterfaces', 'Interfaces'],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={preferences[key] ? 'is-active' : ''}
            onClick={() => setPreference(key)}
          >
            <span /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}
