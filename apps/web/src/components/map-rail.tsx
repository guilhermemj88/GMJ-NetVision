'use client';

import { useMemo } from 'react';
import { Crosshair, Eye, Layers, SlidersHorizontal } from 'lucide-react';
import { SegmentedControl, StatusPill } from '@gmj/ui';
import { updateNetworkMap } from '@/lib/api';
import type { FocusHops, MapLayerFilter, VisualPreset } from '@/lib/map-focus';
import { useMapFocus } from '@/lib/use-map-focus';
import { useMapStore, VISUAL_PRESETS } from '@/store/map-store';
import { MapVisualControls } from './map-controls';

const PRESETS: Array<{ value: VisualPreset; label: string; hint: string }> = [
  {
    value: 'OPERACIONAL',
    label: 'Operacional',
    hint: 'Foco em falha: o que está saudável é atenuado; tráfego e utilização em evidência.',
  },
  {
    value: 'TOPOLOGIA',
    label: 'Topologia',
    hint: 'Foco em estrutura: nomes e conexões visíveis, métricas instantâneas ocultas.',
  },
  {
    value: 'ENGENHARIA',
    label: 'Engenharia',
    hint: 'Máximo detalhe: cards, interfaces, RX/TX, capacidade e labels na linha.',
  },
];

const LAYERS: Array<{ value: MapLayerFilter; label: string; hint: string }> = [
  { value: 'ALL', label: 'Todos', hint: 'Sem recorte: o mapa inteiro em foco.' },
  {
    value: 'PROBLEM',
    label: 'Com problema',
    hint: 'DOWN, WARNING, alarme ativo, enlace caído ou utilização alta.',
  },
  { value: 'DOWN', label: 'DOWN', hint: 'Equipamento ou enlace fora de operação.' },
  { value: 'ALARMS', label: 'Alarmes', hint: 'Equipamentos com alarme ativo.' },
  {
    value: 'HIGH_UTIL',
    label: 'Utilização alta',
    hint: 'Enlaces com o pior sentido em 70% ou mais.',
  },
];

const HOPS: Array<{ value: FocusHops; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
];

/**
 * Rail de camadas do mapa.
 *
 * O canvas é o protagonista: preset, camadas, recortes e vizinhança ficam
 * nesta coluna estreita. Nenhum destes controles altera topologia, métricas ou
 * posições — só o que está em evidência.
 */
export function MapRail() {
  const map = useMapStore((state) => state.map);
  const visualPreset = useMapStore((state) => state.visualPreset);
  const setVisualPreset = useMapStore((state) => state.setVisualPreset);
  const layerFilter = useMapStore((state) => state.layerFilter);
  const setLayerFilter = useMapStore((state) => state.setLayerFilter);
  const siteFilter = useMapStore((state) => state.siteFilter);
  const setSiteFilter = useMapStore((state) => state.setSiteFilter);
  const deviceTypeFilter = useMapStore((state) => state.deviceTypeFilter);
  const setDeviceTypeFilter = useMapStore((state) => state.setDeviceTypeFilter);
  const focusHops = useMapStore((state) => state.focusHops);
  const setFocusHops = useMapStore((state) => state.setFocusHops);
  const showToast = useMapStore((state) => state.showToast);
  const focus = useMapFocus();

  const sites = useMemo(() => {
    const unique = new Set((map?.devices ?? []).map((device) => device.site).filter(Boolean));
    return [...unique].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [map?.devices]);

  const deviceTypes = useMemo(() => {
    const unique = new Set((map?.devices ?? []).map((device) => device.deviceType).filter(Boolean));
    return [...unique].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [map?.devices]);

  const preset = PRESETS.find((item) => item.value === visualPreset) ?? PRESETS[0]!;
  const hasCuts = layerFilter !== 'ALL' || siteFilter !== null || deviceTypeFilter !== null;

  const applyPreset = (value: VisualPreset) => {
    setVisualPreset(value);
    const application = VISUAL_PRESETS[value];
    if (map) {
      void updateNetworkMap(map.id, {
        settings: {
          nodeDisplayMode: application.nodeDisplayMode,
          linkDisplayStyle: application.linkDisplayStyle,
          linkMetricDisplay: application.linkMetricDisplay,
          trafficLabelMode: application.trafficLabelMode,
          filters: application.preferences,
        },
      }).catch(() => undefined);
    }
    showToast(`Preset ${value} aplicado`);
  };

  const clearCuts = () => {
    setLayerFilter('ALL');
    setSiteFilter(null);
    setDeviceTypeFilter(null);
    setFocusHops(0);
  };

  if (!map) return null;

  return (
    <aside className="map-rail" aria-label="Camadas e presets do mapa">
      <header className="map-rail__header">
        <span>
          <Layers size={12} /> CAMADAS DO MAPA
        </span>
        <strong>{preset.label}</strong>
      </header>

      <div className="map-rail__scroll">
        <section className="map-rail__section">
          <h2>PRESET VISUAL</h2>
          <SegmentedControl
            layout="stacked"
            size="sm"
            ariaLabel="Preset visual do mapa"
            value={visualPreset}
            options={PRESETS.map(({ value, label }) => ({ value, label }))}
            onChange={applyPreset}
          />
          <p className="map-rail__hint">{preset.hint}</p>
          <p className="map-rail__note">
            Os três presets mostram os mesmos dados e o mesmo grafo. Nada é criado, duplicado
            ou removido.
          </p>
        </section>

        <section className="map-rail__section">
          <h2>CAMADA</h2>
          <ul className="map-rail__layers">
            {LAYERS.map((layer) => (
              <li key={layer.value}>
                <button
                  type="button"
                  className={layer.value === layerFilter ? 'is-active' : ''}
                  title={layer.hint}
                  aria-pressed={layer.value === layerFilter}
                  onClick={() => setLayerFilter(layer.value)}
                >
                  <span>{layer.label}</span>
                  <em>{focus.layerCounts[layer.value]}</em>
                </button>
              </li>
            ))}
          </ul>
          <p className="map-rail__hint">
            Fora da camada o elemento fica <strong>atenuado</strong>, nunca escondido: continua
            legível e clicável.
          </p>
        </section>

        <section className="map-rail__section">
          <h2>RECORTES</h2>
          {sites.length > 1 ? (
            <label className="map-rail__field">
              <span>POP / site</span>
              <select
                value={siteFilter ?? ''}
                onChange={(event) => setSiteFilter(event.target.value || null)}
              >
                <option value="">Todos os sites</option>
                {sites.map((site) => (
                  <option key={site} value={site}>
                    {site}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="map-rail__note">Um único site nos dados deste mapa.</p>
          )}
          {deviceTypes.length > 1 ? (
            <label className="map-rail__field">
              <span>Tipo de equipamento</span>
              <select
                value={deviceTypeFilter ?? ''}
                onChange={(event) => setDeviceTypeFilter(event.target.value || null)}
              >
                <option value="">Todos os tipos</option>
                {deviceTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {hasCuts ? (
            <div className="map-rail__cut-summary">
              <span>
                <Eye size={12} /> {focus.dimmedTotal} elemento(s) atenuado(s)
              </span>
              <button type="button" onClick={clearCuts}>
                Mostrar tudo
              </button>
            </div>
          ) : (
            <p className="map-rail__note">Sem recorte ativo.</p>
          )}
        </section>

        <section className="map-rail__section">
          <h2>
            <Crosshair size={11} /> VIZINHANÇA
          </h2>
          <div className="map-rail__hops" role="group" aria-label="Saltos de vizinhança">
            {HOPS.map((hop) => (
              <button
                type="button"
                key={hop.value}
                className={hop.value === focusHops ? 'is-active' : ''}
                aria-pressed={hop.value === focusHops}
                disabled={!focus.focusLabel && hop.value !== 0}
                title={hop.value === 0 ? 'Sem recorte de vizinhança' : `${hop.label} salto(s)`}
                onClick={() => setFocusHops(hop.value)}
              >
                {hop.label}
              </button>
            ))}
          </div>
          <p className="map-rail__hint">
            {focus.focusLabel
              ? `Centro: ${focus.focusLabel}. Os demais equipamentos ficam atenuados.`
              : 'Selecione um equipamento no mapa para focar a vizinhança.'}
          </p>
        </section>

        <details className="map-rail__details">
          <summary>
            <SlidersHorizontal size={12} /> Visualização e escala
          </summary>
          <div className="map-rail__visual">
            <MapVisualControls />
          </div>
        </details>
      </div>

      <footer className="map-rail__legend" aria-label="Legenda de estado">
        <StatusPill status="UP" size="sm" />
        <StatusPill status="WARNING" size="sm" />
        <StatusPill status="DOWN" size="sm" />
        <StatusPill status="UNKNOWN" size="sm" />
      </footer>
    </aside>
  );
}
