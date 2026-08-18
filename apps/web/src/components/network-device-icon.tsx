'use client';

import type { NetworkDeviceIconType } from '@/lib/device-appearance';

export type { NetworkDeviceIconType } from '@/lib/device-appearance';

export type NetworkDeviceIconVariant = '2d' | '3d';

interface NetworkDeviceIconProps {
  type: NetworkDeviceIconType;
  variant: NetworkDeviceIconVariant;
  status?: string;
  size?: number;
}

const common = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function assertNever(value: never): never {
  throw new Error(`Unsupported network device icon: ${String(value)}`);
}

function DeviceGlyph({ type }: { type: NetworkDeviceIconType }) {
  switch (type) {
    case 'CORE_ROUTER':
      return (
        <>
          <circle {...common} cx="32" cy="32" r="14" />
          <circle {...common} cx="32" cy="32" r="7" />
          <path {...common} d="M32 5v8M32 51v8M5 32h8M51 32h8" />
          <path {...common} d="M32 5l-3 4m3-4 3 4M32 59l-3-4m3 4 3-4M5 32l4-3m-4 3 4 3M59 32l-4-3m4 3-4 3" />
        </>
      );
    case 'EDGE_ROUTER':
      return (
        <>
          <circle {...common} cx="17" cy="40" r="5" />
          <circle {...common} cx="32" cy="19" r="5" />
          <circle {...common} cx="49" cy="37" r="5" />
          <path {...common} d="M21 36l8-12m7-1 9 10M22 42l22-3" />
        </>
      );
    case 'ROUTER':
      return (
        <>
          <circle {...common} cx="32" cy="32" r="12" />
          <path {...common} d="M32 7v9M32 48v9M7 32h9M48 32h9" />
          <path {...common} d="M32 7l-3 4m3-4 3 4M32 57l-3-4m3 4 3-4M7 32l4-3m-4 3 4 3M57 32l-4-3m4 3-4 3" />
        </>
      );
    case 'CORE_SWITCH':
      return (
        <>
          <rect {...common} x="12" y="20" width="40" height="24" rx="5" />
          <rect {...common} x="19" y="26" width="26" height="12" rx="2" />
          <path {...common} d="M32 12v8M32 44v8" />
          <path {...common} d="M32 12l-4 5m4-5 4 5M32 52l-4-5m4 5 4-5" />
        </>
      );
    case 'SWITCH':
      return (
        <>
          <rect {...common} x="13" y="22" width="38" height="20" rx="4" />
          <path {...common} d="M32 14v8M32 42v8" />
          <path {...common} d="M32 14l-4 5m4-5 4 5M32 50l-4-5m4 5 4-5" />
          <path {...common} d="M21 28h5m9 0h5M21 36h5m9 0h5" />
        </>
      );
    case 'AGGREGATION':
      return (
        <>
          <rect {...common} x="24" y="26" width="16" height="12" rx="3" />
          <path {...common} d="M12 22l12 7M12 42l12-7M52 22l-12 7M52 42l-12-7" />
        </>
      );
    case 'OLT':
      return (
        <>
          <rect {...common} x="17" y="16" width="30" height="14" rx="3" />
          <path {...common} d="M24 16v-6M32 16v-8M40 16v-6" />
          <path {...common} d="M20 30l-7 9M27 30l-3 11M32 30v12M37 30l3 11M44 30l7 9" />
        </>
      );
    case 'ONU':
      return (
        <>
          <rect {...common} x="16" y="26" width="32" height="18" rx="4" />
          <path {...common} d="M32 26v-8" />
          <path {...common} d="M32 18l-4 5m4-5 4 5" />
          <circle {...common} cx="23" cy="35" r="1.6" />
          <circle {...common} cx="41" cy="35" r="1.6" />
          <path {...common} d="M23 41h6M35 41h6" />
        </>
      );
    case 'FIREWALL':
      return (
        <>
          <path {...common} d="M32 10l17 6v12c0 10-7 16-17 20-10-4-17-10-17-20V16l17-6z" />
          <path {...common} d="M32 21c3 3.5 3 7 0 10-3-3-3-6.5 0-10z" />
        </>
      );
    case 'SERVER':
      return (
        <>
          <rect {...common} x="16" y="14" width="32" height="36" rx="4" />
          <path {...common} d="M22 22h20M22 32h20M22 42h20" />
          <circle {...common} cx="41" cy="19" r="1.6" />
          <circle {...common} cx="41" cy="29" r="1.6" />
        </>
      );
    case 'WIRELESS':
      return (
        <>
          <path {...common} d="M14 25c11-9 25-9 36 0" />
          <path {...common} d="M20 33c7-5 17-5 24 0" />
          <path {...common} d="M26 41c3-2 9-2 12 0" />
          <circle {...common} cx="32" cy="49" r="2.2" />
        </>
      );
    case 'CLOUD':
      return (
        <path
          {...common}
          d="M20 46h25c8 0 12-5 12-11s-5-10-11-10c-3-8-14-11-21-5-8-2-15 4-15 12 0 8 5 14 10 14z"
        />
      );
    case 'BNG':
      return (
        <>
          <circle {...common} cx="32" cy="32" r="12" />
          <path {...common} d="M21 32h22" />
          <circle {...common} cx="32" cy="32" r="3" />
          <path {...common} d="M32 20v3M32 41v3" />
        </>
      );
    case 'CUSTOM':
      return <path {...common} d="M32 12l5 14 15 1-12 9 4 15-12-8-12 8 4-15-12-9 15-1 5-14z" />;
    case 'GENERIC':
      return (
        <>
          <path {...common} d="M32 11l17 10v22L32 53 15 43V21l17-10z" />
          <circle {...common} cx="32" cy="32" r="5" />
        </>
      );
  }
  return assertNever(type);
}

export function NetworkDeviceIcon({ type, variant, size = 32 }: NetworkDeviceIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`device-node__svg device-node__svg--${variant}`}
      role="img"
      aria-label={`${type.toLowerCase().replaceAll('_', ' ')} device icon`}
      strokeWidth={variant === '3d' ? 2.4 : 2.1}
    >
      <DeviceGlyph type={type} />
    </svg>
  );
}
