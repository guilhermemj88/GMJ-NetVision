'use client';

import { useEffect, useState } from 'react';
import { getPublicView } from '@/lib/api';
import type { NetworkMap } from '@gmj/shared';
import { useMapStore } from '@/store/map-store';
import { NetworkWorkspace } from './network-workspace';

export function PublicViewer({ token, kind }: { token: string; kind: 'MAP' | 'NOC' }) {
  const setPublicMap = useMapStore((state) => state.setPublicMap);
  const setReadOnly = useMapStore((state) => state.setReadOnly);
  const loadPublicMaps = useMapStore((state) => state.loadPublicMaps);
  const startRotation = useMapStore((state) => state.startRotation);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const view = await getPublicView(token);
        if (cancelled) return;
        if (kind === 'MAP' && view.type === 'MAP' && view.map) {
          setPublicMap(view.map as unknown as NetworkMap);
          setReady(true);
          return;
        }
        if (kind === 'NOC' && view.type === 'NOC' && view.playlist && view.playlist.maps.length > 0) {
          const maps = view.playlist.maps as unknown as NetworkMap[];
          loadPublicMaps(maps);
          setReadOnly(true);
          startRotation({
            mapIds: maps.map((item) => item.id),
            intervalSeconds: view.playlist.rotationIntervalSeconds,
            hideTopBar: true,
            hideControls: true,
            pauseOnInteraction: false,
          });
          setReady(true);
          return;
        }
        setError('Link público inválido.');
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Link público inválido.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, kind, setPublicMap, setReadOnly, loadPublicMaps, startRotation]);

  if (error) {
    return (
      <div className="public-error">
        <strong>Link indisponível</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="auth-loading">
        <span className="map-loading__radar" />
        <strong>Carregando mapa</strong>
      </div>
    );
  }

  return <NetworkWorkspace publicMode />;
}
