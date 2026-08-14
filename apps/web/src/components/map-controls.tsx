'use client';

import type {
  LinkDisplayStyle,
  LinkMetricDisplay,
  MapSettingsUpdate,
  NodeDisplayMode,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import { Boxes, Focus, Maximize, Minus, Plus, Share2 } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { updateNetworkMap } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

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

export function MapControls() {
  const flow = useReactFlow();
  const map = useMapStore((state) => state.map);
  const preferences = useMapStore((state) => state.preferences);
  const setPreference = useMapStore((state) => state.setPreference);
  const setNodeDisplayMode = useMapStore((state) => state.setNodeDisplayMode);
  const setLinkDisplayStyle = useMapStore((state) => state.setLinkDisplayStyle);
  const setLinkMetricDisplay = useMapStore((state) => state.setLinkMetricDisplay);

  const fullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  const persist = (settings: MapSettingsUpdate) => {
    if (map) void updateNetworkMap(map.id, { settings }).catch(() => undefined);
  };

  return (
    <>
      <div className="visual-controls">
        <div className="visual-controls__title">
          <Boxes size={13} /> Visual do mapa
        </div>
        <SegmentedControl
          label="Equipamentos"
          value={map?.settings.nodeDisplayMode ?? 'ICON_2D'}
          options={nodeModes}
          onChange={(value) => {
            setNodeDisplayMode(value);
            persist({ nodeDisplayMode: value });
          }}
        />
        <SegmentedControl
          label="Enlaces"
          value={map?.settings.linkDisplayStyle ?? 'HYBRID'}
          options={linkStyles}
          onChange={(value) => {
            setLinkDisplayStyle(value);
            persist({ linkDisplayStyle: value });
          }}
        />
        <SegmentedControl
          label="Métrica"
          value={map?.settings.linkMetricDisplay ?? 'BOTH'}
          options={metricModes}
          onChange={(value) => {
            setLinkMetricDisplay(value);
            persist({ linkMetricDisplay: value });
          }}
        />
      </div>

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
              onClick={() => {
                setPreference(key);
                persist({ filters: { [key]: !preferences[key] } });
              }}
            >
              <span /> {label}
            </button>
          ))}
        </div>
        <Share2 size={12} className="map-controls__mode" />
      </div>
    </>
  );
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-row">
      <span>{label}</span>
      <div>
        {options.map(([option, text]) => (
          <button
            type="button"
            key={option}
            className={value === option ? 'is-active' : ''}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
