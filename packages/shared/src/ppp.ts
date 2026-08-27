import type {
  HostRecord,
  PppDisplayMode,
  PppLabelPosition,
  PppTotalWidgetSettings,
} from './types';

export const DEFAULT_PPP_DISPLAY_MODE: PppDisplayMode = 'AUTO';
export const DEFAULT_PPP_POSITION: PppLabelPosition = 'BOTTOM';
export const DEFAULT_PPP_FONT_SIZE = 14;
export const DEFAULT_PPP_LABEL = 'PPP TOTAL';

/**
 * AUTO rule for a single host: PPP is only shown when the device is known to
 * support the counter and the online value is strictly greater than 2.
 * 0, 1 and 2 are intentionally hidden so access concentrators with a residual
 * session count do not pollute the map. SHOW always displays a supported
 * device (including 0) and HIDE never displays anything.
 */
export function isPppVisible(
  displayMode: PppDisplayMode,
  supported: boolean,
  online: number,
): boolean {
  if (!supported) return false;
  if (displayMode === 'HIDE') return false;
  if (displayMode === 'SHOW') return true;
  return online > 2;
}

const pppNumberFormatter = new Intl.NumberFormat('pt-BR');

export function formatPppOnline(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return pppNumberFormatter.format(normalized);
}

export function formatPppLabel(online: number): string {
  return `PPP ${formatPppOnline(online)}`;
}

export function defaultPppTotalSettings(): PppTotalWidgetSettings {
  return {
    mode: 'AUTO',
    selectedHostIds: [],
    title: DEFAULT_PPP_LABEL,
    fontColor: null,
    fontSize: 24,
    backgroundColor: null,
    backgroundOpacity: 85,
    showHostCount: true,
    showFreshness: true,
  };
}

export interface PppTotalComputation {
  /** Sum of the valid PPP online counters for the hosts in scope. */
  total: number;
  /** Number of PPP-capable hosts that participate in the total. */
  hostCount: number;
  /** Number of participating hosts whose reading is still considered fresh. */
  freshHostCount: number;
}

/**
 * A reading is considered fresh for `PPP_FRESHNESS_WINDOW_MS` (3 minutes),
 * comfortably above the ~60s operational poll cycle without treating a single
 * skipped cycle as stale data.
 */
export const PPP_FRESHNESS_WINDOW_MS = 180_000;

function isFresh(updatedAt: string | null, now: number): boolean {
  if (!updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && now - timestamp <= PPP_FRESHNESS_WINDOW_MS;
}

/**
 * Computes the PPP TOTAL for a map. In AUTO every PPP-capable host of the map
 * participates; in MANUAL only the hosts listed in `selectedHostIds` (and only
 * when they are PPP-capable). Unsupported or invalid hosts are always ignored.
 */
export function computePppTotal(
  hosts: HostRecord[],
  settings: PppTotalWidgetSettings,
  now: number = Date.now(),
): PppTotalComputation {
  const capable = hosts.filter((host) => host.pppSupported);
  const inScope =
    settings.mode === 'MANUAL'
      ? capable.filter((host) => settings.selectedHostIds.includes(host.id))
      : capable;
  return {
    total: inScope.reduce((sum, host) => sum + Math.max(0, Math.trunc(host.pppOnline)), 0),
    hostCount: inScope.length,
    freshHostCount: inScope.filter((host) => isFresh(host.pppUpdatedAt, now)).length,
  };
}
