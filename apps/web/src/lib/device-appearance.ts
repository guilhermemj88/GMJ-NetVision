import type { DeviceType } from '@gmj/shared';

export const DEVICE_ICON_TYPES = [
  'AUTO',
  'CORE_ROUTER',
  'EDGE_ROUTER',
  'ROUTER',
  'CORE_SWITCH',
  'SWITCH',
  'AGGREGATION',
  'OLT',
  'ONU',
  'FIREWALL',
  'SERVER',
  'WIRELESS',
  'CLOUD',
  'BNG',
  'GENERIC',
  'CUSTOM',
] as const;

export type DeviceIconType = (typeof DEVICE_ICON_TYPES)[number];
export type ResolvedDeviceIconType = Exclude<DeviceIconType, 'AUTO'>;

export const DEVICE_ICON_OPTIONS: ReadonlyArray<{ value: DeviceIconType; label: string }> = [
  { value: 'AUTO', label: 'Automático' },
  { value: 'CORE_ROUTER', label: 'Core Router' },
  { value: 'EDGE_ROUTER', label: 'Edge Router' },
  { value: 'ROUTER', label: 'Router' },
  { value: 'CORE_SWITCH', label: 'Core Switch' },
  { value: 'SWITCH', label: 'Switch' },
  { value: 'AGGREGATION', label: 'Agregação' },
  { value: 'OLT', label: 'OLT' },
  { value: 'ONU', label: 'ONU / ONT' },
  { value: 'FIREWALL', label: 'Firewall' },
  { value: 'SERVER', label: 'Servidor' },
  { value: 'WIRELESS', label: 'Wireless' },
  { value: 'CLOUD', label: 'Cloud / Internet' },
  { value: 'BNG', label: 'BNG / BRAS' },
  { value: 'GENERIC', label: 'Genérico' },
  { value: 'CUSTOM', label: 'Personalizado' },
];

interface DeviceAppearanceSource {
  name?: string;
  displayName?: string;
  hostname?: string;
  model?: string;
  vendor?: string;
  deviceType?: DeviceType | string;
}

const STORAGE_PREFIX = 'gmj:device-icon:';
export const DEVICE_ICON_CHANGE_EVENT = 'gmj:device-icon-change';

function isDeviceIconType(value: string | null): value is DeviceIconType {
  return value !== null && (DEVICE_ICON_TYPES as readonly string[]).includes(value);
}

export function resolveDeviceIconType(
  device: DeviceAppearanceSource,
  preference: DeviceIconType = 'AUTO',
): ResolvedDeviceIconType {
  if (preference !== 'AUTO') return preference;

  const type = device.deviceType?.toLowerCase() ?? 'generic';
  const text = [device.name, device.displayName, device.hostname, device.model, device.vendor]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/\b(bng|bras)\b/.test(text)) return 'BNG';
  if (/\b(onu|ont)\b/.test(text)) return 'ONU';
  if (/\b(olt|ma5800|c600)\b/.test(text) || type === 'olt') return 'OLT';
  if (/\b(firewall|fortigate|fgt|palo alto)\b|\bpa-\d+/i.test(text) || type === 'firewall') {
    return 'FIREWALL';
  }
  if (/\b(wireless|wi-fi|wifi|wlan|access point)\b|\bap[-_\d]/.test(text)) return 'WIRELESS';
  if (type === 'customers') return 'GENERIC';
  if (
    type === 'internet' ||
    type === 'ix' ||
    /\b(internet|cloud|upstream|provider|peer)\b/.test(text)
  ) {
    return 'CLOUD';
  }
  if (type === 'server') return 'SERVER';

  const looksLikeSwitch = /\b(s6730|s6720|s6750|s5735|catalyst|switch)\b/.test(text);
  const looksLikeRouter = /\b(ne8000|ne40|asr|mx\d+|ccr|router)\b/.test(text);

  if (type === 'core') return looksLikeSwitch ? 'CORE_SWITCH' : 'CORE_ROUTER';
  if (type === 'edge') return 'EDGE_ROUTER';
  if (type === 'aggregation') return 'AGGREGATION';
  if (type === 'switch') return /\bcore\b/.test(text) ? 'CORE_SWITCH' : 'SWITCH';
  if (type === 'router') return 'ROUTER';

  if (/\bne8000\b/.test(text) || looksLikeRouter) return 'ROUTER';
  if (/\bs6730\b/.test(text) || looksLikeSwitch) return 'SWITCH';
  return 'GENERIC';
}

export function getDeviceIconPreference(deviceId: string): DeviceIconType {
  if (typeof window === 'undefined') return 'AUTO';
  const saved = window.localStorage.getItem(`${STORAGE_PREFIX}${deviceId}`);
  return isDeviceIconType(saved) ? saved : 'AUTO';
}

export function setDeviceIconPreference(deviceId: string, iconType: DeviceIconType): void {
  if (typeof window === 'undefined') return;
  const key = `${STORAGE_PREFIX}${deviceId}`;
  if (iconType === 'AUTO') window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, iconType);
  window.dispatchEvent(
    new CustomEvent(DEVICE_ICON_CHANGE_EVENT, { detail: { deviceId, iconType } }),
  );
}

export function subscribeDeviceIconPreference(
  deviceId: string,
  onStoreChange: () => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onCustomChange = (event: Event) => {
    const detail = (event as CustomEvent<{ deviceId?: string }>).detail;
    if (detail?.deviceId === deviceId) onStoreChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === `${STORAGE_PREFIX}${deviceId}`) onStoreChange();
  };

  window.addEventListener(DEVICE_ICON_CHANGE_EVENT, onCustomChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(DEVICE_ICON_CHANGE_EVENT, onCustomChange);
    window.removeEventListener('storage', onStorage);
  };
}
