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
          <path
            {...common}
            d="M12 32h40M32 12v40M12 32l7-6m-7 6 7 6m33-6-7-6m7 6-7 6M32 12l-6 7m6-7 6 7m-6 33-6-7m6 7 6-7"
          />
          <circle {...common} cx="32" cy="32" r="7" />
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
          <path {...common} d="M14 32h36m-7-7 7 7-7 7M32 14v36m-7-7 7 7 7-7" />
          <circle {...common} cx="32" cy="32" r="14" />
        </>
      );
    case 'CORE_SWITCH':
      return (
        <>
          <rect {...common} x="14" y="16" width="36" height="32" rx="5" />
          <path {...common} d="M22 25h20M22 32h20M22 39h20" />
          <circle {...common} cx="18" cy="25" r="1" />
          <circle {...common} cx="46" cy="39" r="1" />
        </>
      );
    case 'SWITCH':
      return (
        <>
          <rect {...common} x="12" y="22" width="40" height="20" rx="4" />
          <path {...common} d="M20 30h5m4 0h5m4 0h6M20 36h5m4 0h5m4 0h6" />
        </>
      );
    case 'AGGREGATION':
      return (
        <>
          <circle {...common} cx="15" cy="18" r="4" />
          <circle {...common} cx="15" cy="46" r="4" />
          <circle {...common} cx="49" cy="32" r="5" />
          <path {...common} d="M19 18h7c7 0 7 14 15 14h3M19 46h7c7 0 7-14 15-14" />
        </>
      );
    case 'OLT':
      return (
        <>
          <path {...common} d="M24 47h16M27 47l5-27 5 27M29 34h6M30 27h4" />
          <path
            {...common}
            d="M20 22c-5 5-5 13 0 18M44 22c5 5 5 13 0 18M15 17c-8 8-8 22 0 30M49 17c8 8 8 22 0 30"
          />
        </>
      );
    case 'ONU':
      return (
        <>
          <rect {...common} x="16" y="22" width="32" height="25" rx="5" />
          <path {...common} d="M24 22v-6h16v6M23 32h18M23 38h11" />
          <circle {...common} cx="41" cy="38" r="1" />
        </>
      );
    case 'FIREWALL':
      return (
        <>
          <path {...common} d="M32 12l18 7v13c0 11-7 18-18 22-11-4-18-11-18-22V19l18-7z" />
          <path {...common} d="M20 27h24M20 35h24M25 27v8m14-8v8m-7 0v8" />
        </>
      );
    case 'SERVER':
      return (
        <>
          <rect {...common} x="18" y="13" width="28" height="38" rx="4" />
          <path {...common} d="M23 23h18M23 32h18M23 41h18" />
          <circle {...common} cx="38" cy="19" r="1" />
          <circle {...common} cx="42" cy="19" r="1" />
        </>
      );
    case 'WIRELESS':
      return (
        <>
          <path {...common} d="M12 25c11-11 29-11 40 0M19 33c7-7 19-7 26 0M26 41c3-3 9-3 12 0" />
          <circle {...common} cx="32" cy="48" r="2" />
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
          <circle {...common} cx="32" cy="32" r="10" />
          <circle {...common} cx="32" cy="32" r="3" />
          <path
            {...common}
            d="M32 22V12M32 52V42M22 32H12M52 32H42M25 25l-7-7m28 28-7-7m0-14 7-7M18 46l7-7"
          />
        </>
      );
    case 'CUSTOM':
      return <path {...common} d="M32 12l5 14 15 1-12 9 4 15-12-8-12 8 4-15-12-9 15-1 5-14z" />;
    case 'GENERIC':
      return (
        <>
          <path {...common} d="M32 12l18 10v20L32 52 14 42V22l18-10z" />
          <circle {...common} cx="32" cy="32" r="7" />
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
