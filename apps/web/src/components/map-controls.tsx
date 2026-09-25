'use client';

import { useSyncExternalStore } from 'react';
import type {
  LinkDisplayStyle,
  LinkMetricDisplay,
  MapSettingsUpdate,
  NodeDisplayMode,
  TrafficLabelMode,
} from '@gmj/shared';
import {
  ALARM_SCALE_OPTIONS,
  getAlarmScale,
  setAlarmScale,
  subscribeAlarmScale,
} from '@/lib/alarm-panel-preferences';
import { SegmentedControl } from '@gmj/ui';
import { Focus, Maximize, Minus, Plus } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { updateNetworkMap } from '@/lib/api';
import {
  scalesMatchPreset,
  useMapStore,
  VISUAL_PRESETS,
  type MapScalePreset,
} from '@/store/map-store';
import { LinkGeometryControls } from './link-geometry-controls';
import { PppTotalControls } from './ppp-total-controls';

const nodeModes: Array<[NodeDisplayMode, string]> = [
  ['ICON_2D', 'Ícones 2D'],
  ['ICON_3D', 'Ícones 3D'],
  ['CARD', 'Cards'],
];
const linkStyles: Array<[LinkDisplayStyle, string]> = [
  ['FLOW', 'Flow'],
  ['WEATHERMAP', 'Weathermap'],
  ['HYBRID', 'Hybrid'],
  ['MINIMAL', 'Minimal'],
];
const metricModes: Array<[LinkMetricDisplay, string]> = [
  ['THROUGHPUT', 'Throughput'],
  ['UTILIZATION', 'Utilização %'],
  ['BOTH', 'Ambos'],
  ['NONE', 'Nenhum'],
];
const trafficLabelModes: Array<[TrafficLabelMode, string]> = [
  ['CARD', 'Cards'],
  ['INLINE', 'Inline'],
  ['HIDDEN', 'Oculto'],
];

/** Presets rápidos de escala: não mudam dado nenhum, só `nodeScale/linkScale/labelScale`. */
const SCALE_PRESETS: Array<{ label: string; scales: MapScalePreset }> = [
  { label: 'Compacto', scales: { nodeScale: 80, linkScale: 80, labelScale: 80 } },
  { label: 'Normal', scales: { nodeScale: 100, linkScale: 100, labelScale: 100 } },
  { label: 'Grande', scales: { nodeScale: 130, linkScale: 130, labelScale: 130 } },
  { label: 'WeatherMap', scales: { nodeScale: 75, linkScale: 140, labelScale: 85 } },
];

function toOptions<T extends string>(pairs: Array<[T, string]>) {
  return pairs.map(([value, label]) => ({ value, label }));
}

/**
 * Controles VISUAIS do mapa (aparência de nós, enlaces, métricas e escala).
 *
 * Vivem na rail lateral do mapa — não são mais um painel permanente sobre o
 * canvas. Continuam persistindo as mesmas chaves de `MapSettings`.
 */
export function MapVisualControls() {
  const map = useMapStore((state) => state.map);
  const setNodeDisplayMode = useMapStore((state) => state.setNodeDisplayMode);
  const setLinkDisplayStyle = useMapStore((state) => state.setLinkDisplayStyle);
  const setLinkMetricDisplay = useMapStore((state) => state.setLinkMetricDisplay);
  const setTrafficLabelMode = useMapStore((state) => state.setTrafficLabelMode);
  const setMapScales = useMapStore((state) => state.setMapScales);
  const alarmScale = useSyncExternalStore(subscribeAlarmScale, getAlarmScale, getAlarmScale);

  const persist = (settings: MapSettingsUpdate) => {
    if (map) void updateNetworkMap(map.id, { settings }).catch(() => undefined);
  };

  const changeScales = (
    scales: Partial<Pick<MapSettingsUpdate, 'nodeScale' | 'linkScale' | 'labelScale'>>,
  ) => {
    setMapScales(scales);
    persist(scales);
  };

  const labelScale = map?.settings.labelScale ?? 100;
  const visualPreset = useMapStore((state) => state.visualPreset);
  const presetScales = VISUAL_PRESETS[visualPreset].scales;
  const nodeScale = map?.settings.nodeScale ?? 100;
  const linkScale = map?.settings.linkScale ?? 100;
  /**
   * A escala atual deixou de ser a sugerida pelo preset? Então ela é do
   * operador: trocar de preset não sobrescreve (ver `presetScalePatch`).
   */
  const scalesCustomized = map ? !scalesMatchPreset(map.settings, visualPreset) : false;
  const isScalePresetActive = (scales: MapScalePreset) =>
    nodeScale === scales.nodeScale &&
    linkScale === scales.linkScale &&
    labelScale === scales.labelScale;
  const legibilityActive = ALARM_SCALE_OPTIONS.some(
    ({ value }) => value === labelScale && value === alarmScale,
  )
    ? labelScale
    : null;

  return (
    <>
      <div className="map-visual__group">
        <span className="map-visual__group-title">ESCALA</span>
        <ScaleControl
          label="Equipamentos"
          value={map?.settings.nodeScale ?? 100}
          onChange={(nodeScale) => changeScales({ nodeScale })}
        />
        <ScaleControl
          label="Enlaces"
          value={map?.settings.linkScale ?? 100}
          onChange={(linkScale) => changeScales({ linkScale })}
        />
        <ScaleControl
          label="Labels"
          value={labelScale}
          onChange={(labelScale) => changeScales({ labelScale })}
        />
        <div className="scale-presets" aria-label="Presets de escala">
          <span>Presets</span>
          {SCALE_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.label}
              className={isScalePresetActive(preset.scales) ? 'is-active' : ''}
              onClick={() => changeScales(preset.scales)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {scalesCustomized ? (
          <p className="map-visual__note">
            Escala ajustada à mão: trocar de preset não sobrescreve estes valores.
            <button type="button" onClick={() => changeScales(presetScales)}>
              Aplicar escala do preset ({presetScales.nodeScale}/{presetScales.linkScale}/
              {presetScales.labelScale})
            </button>
          </p>
        ) : null}
        <div className="scale-presets" aria-label="Preset de legibilidade">
          <span>Legibilidade</span>
          {ALARM_SCALE_OPTIONS.map(({ value, label }) => (
            <button
              type="button"
              key={value}
              className={legibilityActive === value ? 'is-active' : ''}
              onClick={() => {
                changeScales({ labelScale: value });
                setAlarmScale(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="map-visual__group">
        <span className="map-visual__group-title">TRÁFEGO</span>
        <SegmentedControl
          layout="stacked"
          size="sm"
          label="Modo de tráfego"
          ariaLabel="Exibição de tráfego"
          value={map?.settings.trafficLabelMode ?? 'CARD'}
          options={toOptions(trafficLabelModes)}
          onChange={(value) => {
            setTrafficLabelMode(value);
            persist({ trafficLabelMode: value });
          }}
        />
      </div>

      <div className="map-visual__group">
        <span className="map-visual__group-title">EQUIPAMENTOS</span>
        <SegmentedControl
          layout="stacked"
          size="sm"
          label="Modo de exibição"
          ariaLabel="Modo de exibição dos equipamentos"
          value={map?.settings.nodeDisplayMode ?? 'ICON_2D'}
          options={toOptions(nodeModes)}
          onChange={(value) => {
            setNodeDisplayMode(value);
            persist({ nodeDisplayMode: value });
          }}
        />
      </div>

      <div className="map-visual__group">
        <span className="map-visual__group-title">ENLACES</span>
        <SegmentedControl
          layout="stacked"
          size="sm"
          label="Estilo"
          ariaLabel="Estilo dos enlaces"
          value={map?.settings.linkDisplayStyle ?? 'HYBRID'}
          options={toOptions(linkStyles)}
          onChange={(value) => {
            setLinkDisplayStyle(value);
            persist({ linkDisplayStyle: value });
          }}
        />
        <SegmentedControl
          layout="stacked"
          size="sm"
          label="Métrica"
          ariaLabel="Métrica exibida nos enlaces"
          value={map?.settings.linkMetricDisplay ?? 'BOTH'}
          options={toOptions(metricModes)}
          onChange={(value) => {
            setLinkMetricDisplay(value);
            persist({ linkMetricDisplay: value });
          }}
        />
      </div>

      <div className="map-visual__group">
        <span className="map-visual__group-title">GEOMETRIA DO ENLACE</span>
        <LinkGeometryControls />
      </div>

      <PppTotalControls />
    </>
  );
}

/**
 * Controles flutuantes mínimos sobre o canvas: zoom, enquadrar e tela cheia.
 * Ficam no canto inferior direito para não competir com a rail nem com o
 * inspector.
 */
export function MapControls() {
  const flow = useReactFlow();

  const fullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  return (
    <div className="map-zoombar" role="group" aria-label="Controles de visualização do mapa">
      <button type="button" aria-label="Diminuir zoom" title="Diminuir zoom" onClick={() => flow.zoomOut()}>
        <Minus size={15} />
      </button>
      <button type="button" aria-label="Aumentar zoom" title="Aumentar zoom" onClick={() => flow.zoomIn()}>
        <Plus size={15} />
      </button>
      <button
        type="button"
        aria-label="Enquadrar mapa"
        title="Enquadrar mapa"
        onClick={() => flow.fitView({ padding: 0.14, duration: 500 })}
      >
        <Focus size={15} />
      </button>
      <button type="button" aria-label="Tela cheia" title="Tela cheia" onClick={() => void fullscreen()}>
        <Maximize size={14} />
      </button>
    </div>
  );
}

function ScaleControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="scale-control">
      <span>{label}</span>
      <button type="button" aria-label={`Reduzir ${label}`} onClick={() => onChange(value - 10)}>
        −
      </button>
      <input
        aria-label={`Escala de ${label}`}
        type="range"
        min="50"
        max="200"
        step="10"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}%</output>
      <button type="button" aria-label={`Aumentar ${label}`} onClick={() => onChange(value + 10)}>
        +
      </button>
    </div>
  );
}
