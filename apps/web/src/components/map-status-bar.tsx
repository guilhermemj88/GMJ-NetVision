'use client';

import { useEffect, useState } from 'react';
import { formatRelative } from '@/lib/bgp-format';
import type { MapFocusView } from '@/lib/use-map-focus';
import { useMapStore } from '@/store/map-store';

/**
 * Relógio isolado: só a barra de status re-renderiza a cada segundo, o canvas
 * (React Flow) permanece intocado.
 */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Status/contexto do mapa.
 *
 * Substitui a antiga marca d'água ("Atualizado agora") por números reais do
 * recorte em tela: equipamentos por estado, enlaces em falha, enlaces em uso
 * alto, alarmes ativos e o recorte de camada/vizinhança aplicado.
 */
export function MapStatusBar({ focus }: { focus: MapFocusView }) {
  const map = useMapStore((state) => state.map);
  const layerFilter = useMapStore((state) => state.layerFilter);
  const focusHops = useMapStore((state) => state.focusHops);
  const selection = useMapStore((state) => state.selection);
  const now = useNow();

  const stats = focus.stats;
  const updatedAt = map?.updatedAt ? Date.parse(map.updatedAt) : Number.NaN;
  const age = Number.isFinite(updatedAt) ? formatRelative(now - updatedAt) : null;

  const selectionLabel =
    selection?.kind === 'device' || selection?.kind === 'node'
      ? (focus.focusLabel ?? 'selecionado')
      : null;

  return (
    <div className="map-statusbar" role="status" aria-label="Status do mapa">
      <span className="map-statusbar__label">EQUIPAMENTOS</span>
      <span className="map-statusbar__item map-statusbar__item--up">
        <b>{stats.devicesUp}</b> UP
      </span>
      <span className="map-statusbar__item map-statusbar__item--warning">
        <b>{stats.devicesWarning}</b> WARN
      </span>
      <span className="map-statusbar__item map-statusbar__item--down">
        <b>{stats.devicesDown}</b> DOWN
      </span>
      <span className="map-statusbar__sep" aria-hidden="true" />
      <span className="map-statusbar__label">ENLACES</span>
      <span className="map-statusbar__item">
        <b>{stats.links}</b> total
      </span>
      <span className="map-statusbar__item map-statusbar__item--down">
        <b>{stats.linksDown}</b> down
      </span>
      <span className="map-statusbar__item map-statusbar__item--warning">
        <b>{stats.linksHighUtilization}</b> ≥70%
      </span>
      <span className="map-statusbar__sep" aria-hidden="true" />
      <span className="map-statusbar__item map-statusbar__item--info">
        <b>{stats.alarms}</b> alarme(s)
      </span>
      <span className="map-statusbar__sep" aria-hidden="true" />
      <span className="map-statusbar__label">
        {layerFilter === 'ALL' ? 'CAMADA: TODOS' : `CAMADA: ${layerFilter}`}
        {focusHops > 0 && selectionLabel ? ` · ${focusHops} HOP (${selectionLabel})` : ''}
        {focus.dimmedTotal > 0 ? ` · ${focus.dimmedTotal} ATENUADO(S)` : ''}
      </span>
      <span className="map-statusbar__sep" aria-hidden="true" />
      <span className="map-statusbar__label" title={map?.updatedAt ?? undefined}>
        {age ? `DADOS: ${age}` : 'SEM TIMESTAMP DE COLETA'}
      </span>
    </div>
  );
}
