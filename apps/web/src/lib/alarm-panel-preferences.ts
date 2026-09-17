/**
 * Client-side visual preference for the alarm panel size.
 *
 * Unlike `nodeScale`/`linkScale`/`labelScale` (persisted per map), `alarmScale`
 * is a global NOC readability preference stored in `localStorage` together with
 * the panel position. It stays in sync across the alarm panel and the
 * "Legibilidade" preset in the visual panel through the subscription below.
 */
export type AlarmScale = 100 | 125 | 150;

export const ALARM_SCALE_OPTIONS: ReadonlyArray<{ value: AlarmScale; label: string }> = [
  { value: 100, label: 'Normal' },
  { value: 125, label: 'Grande' },
  { value: 150, label: 'Extra' },
];

export const DEFAULT_ALARM_SCALE: AlarmScale = 125;

export const ALARM_SCALE_STORAGE_KEY = 'gmj:alarms:panel-scale';
const ALARM_SCALE_CHANGE_EVENT = 'gmj:alarms:panel-scale-change';

function parseAlarmScale(value: string | null): AlarmScale | null {
  if (value === '100' || value === '125' || value === '150') {
    return Number(value) as AlarmScale;
  }
  return null;
}

export function getAlarmScale(): AlarmScale {
  if (typeof window === 'undefined') return DEFAULT_ALARM_SCALE;
  try {
    return (
      parseAlarmScale(window.localStorage.getItem(ALARM_SCALE_STORAGE_KEY)) ??
      DEFAULT_ALARM_SCALE
    );
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
    return DEFAULT_ALARM_SCALE;
  }
}

export function setAlarmScale(scale: AlarmScale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ALARM_SCALE_STORAGE_KEY, String(scale));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  window.dispatchEvent(new CustomEvent(ALARM_SCALE_CHANGE_EVENT));
}

export function subscribeAlarmScale(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onStorage = (event: StorageEvent) => {
    if (event.key === ALARM_SCALE_STORAGE_KEY) onStoreChange();
  };

  window.addEventListener(ALARM_SCALE_CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ALARM_SCALE_CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStorage);
  };
}
