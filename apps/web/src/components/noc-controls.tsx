'use client';

import { useEffect, useState } from 'react';
import { Button } from '@gmj/ui';
import { ChevronLeft, ChevronRight, Maximize, Minimize, Pause, Play, X } from 'lucide-react';
import { useMapStore } from '@/store/map-store';

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function NocControls() {
  const maps = useMapStore((state) => state.maps);
  const rotation = useMapStore((state) => state.rotation);
  const rotateBy = useMapStore((state) => state.rotateBy);
  const stopRotation = useMapStore((state) => state.stopRotation);
  const setRotationPaused = useMapStore((state) => state.setRotationPaused);
  const [remaining, setRemaining] = useState(rotation.intervalSeconds);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    if (!rotation.active) return;
    const update = () => {
      if (rotation.paused) return;
      const milliseconds = rotation.nextSwitchAt - Date.now();
      if (milliseconds <= 0) {
        rotateBy(1);
        return;
      }
      setRemaining(Math.max(1, Math.ceil(milliseconds / 1000)));
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [rotateBy, rotation.active, rotation.nextSwitchAt, rotation.paused]);

  if (!rotation.active) return null;
  const currentId = rotation.mapIds[rotation.currentIndex];
  const current = maps.find((map) => map.id === currentId);
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  return (
    <aside className="noc-controls" aria-label="Controles do modo NOC">
      <div className="noc-controls__identity">
        <span>NOC ROTATION</span>
        <strong>{current?.name ?? 'Carregando mapa'}</strong>
      </div>
      <div className="noc-controls__position">
        <strong>{rotation.currentIndex + 1}</strong>
        <span>/ {rotation.mapIds.length}</span>
      </div>
      <Button compact variant="ghost" aria-label="Mapa anterior" onClick={() => rotateBy(-1)}>
        <ChevronLeft size={17} />
      </Button>
      <Button
        compact
        variant={rotation.paused ? 'primary' : 'secondary'}
        onClick={() => setRotationPaused(!rotation.paused)}
      >
        {rotation.paused ? <Play size={15} /> : <Pause size={15} />}
        {rotation.paused ? 'Retomar' : 'Pausar'}
      </Button>
      <Button compact variant="ghost" aria-label="Próximo mapa" onClick={() => rotateBy(1)}>
        <ChevronRight size={17} />
      </Button>
      <div className={`noc-countdown ${rotation.paused ? 'is-paused' : ''}`}>
        <span>{rotation.paused ? 'PAUSADO' : 'PRÓXIMO MAPA'}</span>
        <strong>{rotation.paused ? '—' : formatCountdown(remaining)}</strong>
        <i
          style={{
            width: rotation.paused
              ? '100%'
              : `${Math.min(100, (remaining / rotation.intervalSeconds) * 100)}%`,
          }}
        />
      </div>
      <Button compact variant="ghost" onClick={() => void toggleFullscreen()}>
        {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        {fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
      </Button>
      <Button compact variant="danger" onClick={stopRotation}>
        <X size={15} /> Sair do NOC
      </Button>
    </aside>
  );
}
