'use client';

import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { getPublicView } from '@/lib/api';
import type { NetworkMap } from '@gmj/shared';
import { useMapStore } from '@/store/map-store';
import { NetworkCanvas } from './network-canvas';
import { NocControls } from './noc-controls';

export function PublicViewer({ token, kind }: { token: string; kind: 'MAP' | 'NOC' }) {
  const setMap = useMapStore((state) => state.setMap);
  const setReadOnly = useMapStore((state) => state.setReadOnly);
  const loadPublicMaps = useMapStore((state) => state.loadPublicMaps);
  const startRotation = useMapStore((state) => state.startRotation);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [noc, setNoc] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const view = await getPublicView(token);
        if (cancelled) return;
        if (kind === 'MAP' && view.type === 'MAP' && view.map) {
          setReadOnly(true);
          setMap(view.map as unknown as NetworkMap);
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
          setNoc(true);
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
  }, [token, kind, setMap, setReadOnly, loadPublicMaps, startRotation]);

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

  return (
    <div className="netvision-app public-viewer">
      <ReactFlowProvider>
        <NetworkCanvas readOnly />
      </ReactFlowProvider>
      {noc && <NocControls />}
    </div>
  );
}
