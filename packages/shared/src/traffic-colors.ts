export type TrafficColorPresetId =
  | 'DEFAULT'
  | 'BLUE_ORANGE'
  | 'GREEN_YELLOW'
  | 'BLUE_PINK'
  | 'GREEN_PURPLE';

export interface TrafficColorPreset {
  id: TrafficColorPresetId;
  label: string;
  aToB: string;
  bToA: string;
}

// Default directional identities are the canonical cyan/purple constants from
// the traffic-edge CSS (.traffic-edge--normal and .traffic-edge--ba.traffic-edge--normal).
export const DEFAULT_TRAFFIC_COLOR_A_TO_B = '#40c8e8';
export const DEFAULT_TRAFFIC_COLOR_B_TO_A = '#9575f0';

export const TRAFFIC_COLOR_PRESETS: TrafficColorPreset[] = [
  {
    id: 'DEFAULT',
    label: 'Padrão — Ciano / Roxo',
    aToB: DEFAULT_TRAFFIC_COLOR_A_TO_B,
    bToA: DEFAULT_TRAFFIC_COLOR_B_TO_A,
  },
  { id: 'BLUE_ORANGE', label: 'Azul / Laranja', aToB: '#4da3ff', bToA: '#f0923c' },
  { id: 'GREEN_YELLOW', label: 'Verde / Amarelo', aToB: '#35c26e', bToA: '#e5c13c' },
  { id: 'BLUE_PINK', label: 'Azul / Rosa', aToB: '#4da3ff', bToA: '#e05aa8' },
  { id: 'GREEN_PURPLE', label: 'Verde / Roxo', aToB: '#35c26e', bToA: '#9575f0' },
];

export type TrafficColorPaletteSelection = TrafficColorPresetId | 'CUSTOM';

export function matchTrafficColorPreset(
  aToB: string | null,
  bToA: string | null,
): TrafficColorPaletteSelection {
  if (aToB === null && bToA === null) return 'DEFAULT';
  const preset = TRAFFIC_COLOR_PRESETS.find((item) => item.aToB === aToB && item.bToA === bToA);
  return preset ? preset.id : 'CUSTOM';
}
