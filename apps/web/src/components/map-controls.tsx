'use client';

import { useEffect, useState } from 'react';
import type {
  LinkDisplayStyle,
  LinkMetricDisplay,
  MapSettingsUpdate,
  NodeDisplayMode,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import {
  Boxes,
  ChevronLeft,
  ChevronRight,
  Focus,
  Maximize,
  Minus,
  Plus,
  Share2,
  X,
} from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { updateNetworkMap } from '@/lib/api';
import { useMediaQuery } from '@/lib/use-media-query';
import { useMapStore } from '@/store/map-store';
import { PppTotalControls } from './ppp-total-controls';

const VISUAL_PANEL_COLLAPSED_KEY = 'netvision.mapVisualPanelCollapsed';

function readCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(VISUAL_PANEL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

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

function VisualPanelContent() {
  const map = useMapStore((state) => state.map);
  const setNodeDisplayMode = useMapStore((state) => state.setNodeDisplayMode);
  const setLinkDisplayStyle = useMapStore((state) => state.setLinkDisplayStyle);
  const setLinkMetricDisplay = useMapStore((state) => state.setLinkMetricDisplay);
  const setMapScales = useMapStore((state) => state.setMapScales);

  const persist = (settings: MapSettingsUpdate) => {
    if (map) void updateNetworkMap(map.id, { settings }).catch(() => undefined);
  };

  const changeScales = (
    scales: Partial<Pick<MapSettingsUpdate, 'nodeScale' | 'linkScale' | 'labelScale'>>,
  ) => {
    setMapScales(scales);
    persist(scales);
  };

  return (
    <>
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
      <div className="scale-presets" aria-label="Presets de escala">
        <span>Escala</span>
        {(
          [
            ['Compacto', 80],
            ['Normal', 100],
            ['Grande', 130],
          ] as const
        ).map(([label, value]) => (
          <button
            type="button"
            key={value}
            onClick={() => changeScales({ nodeScale: value, linkScale: value, labelScale: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <ScaleControl
        label="Nós"
        value={map?.settings.nodeScale ?? 100}
        onChange={(nodeScale) => changeScales({ nodeScale })}
      />
      <ScaleControl
        label="Links"
        value={map?.settings.linkScale ?? 100}
        onChange={(linkScale) => changeScales({ linkScale })}
      />
      <ScaleControl
        label="Labels"
        value={map?.settings.labelScale ?? 100}
        onChange={(labelScale) => changeScales({ labelScale })}
      />
      <PppTotalControls />
    </>
  );
}

export function MapControls() {
  const flow = useReactFlow();
  const map = useMapStore((state) => state.map);
  const preferences = useMapStore((state) => state.preferences);
  const setPreference = useMapStore((state) => state.setPreference);
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 720px)');

  useEffect(() => {
    setCollapsed(readCollapsedPreference());
  }, []);

  const fullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  const persist = (settings: MapSettingsUpdate) => {
    if (map) void updateNetworkMap(map.id, { settings }).catch(() => undefined);
  };

  const setCollapsedPersist = (value: boolean) => {
    setCollapsed(value);
    try {
      window.localStorage.setItem(VISUAL_PANEL_COLLAPSED_KEY, value ? '1' : '0');
    } catch {
      // Ignore storage failures (private mode, quotas, etc).
    }
  };

  return (
    <>
      {isMobile ? (
        <>
          <button
            type="button"
            className="visual-sheet-fab"
            aria-label="Abrir Visual do mapa"
            onClick={() => setSheetOpen(true)}
          >
            <Boxes size={16} />
            <span>Visual</span>
          </button>
          {sheetOpen && (
            <div className="visual-sheet-backdrop" onClick={() => setSheetOpen(false)}>
              <section
                className="visual-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Visual do mapa"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="visual-sheet__header">
                  <span>
                    <Boxes size={13} /> Visual do mapa
                  </span>
                  <button
                    type="button"
                    aria-label="Fechar Visual do mapa"
                    onClick={() => setSheetOpen(false)}
                  >
                    <X size={16} />
                  </button>
                </header>
                <div className="visual-sheet__scroll">
                  <VisualPanelContent />
                </div>
              </section>
            </div>
          )}
        </>
      ) : collapsed ? (
        <button
          type="button"
          className="visual-controls-rail"
          aria-label="Expandir Visual do mapa"
          onClick={() => setCollapsedPersist(false)}
        >
          <Boxes size={15} />
          <ChevronLeft size={13} />
        </button>
      ) : (
        <div className="visual-controls">
          <div className="visual-controls__title">
            <Boxes size={13} /> Visual do mapa
            <button
              type="button"
              className="visual-controls__collapse"
              aria-label="Recolher Visual do mapa"
              onClick={() => setCollapsedPersist(true)}
            >
              <ChevronRight size={13} />
            </button>
          </div>
          <VisualPanelContent />
        </div>
      )}

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
              ['showTrafficAnimation', 'Animação'],
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
