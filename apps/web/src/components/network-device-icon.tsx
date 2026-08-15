'use client';

import type { CSSProperties } from 'react';
import { useState } from 'react';

export type NetworkDeviceIconType =
  | 'router'
  | 'switch'
  | 'core-switch'
  | 'aggregation'
  | 'olt'
  | 'onu'
  | 'firewall'
  | 'server'
  | 'wireless'
  | 'cloud'
  | 'bras'
  | 'generic'
  | 'unknown';

export type NetworkDeviceIconVariant = '2d' | '3d';

export function resolveNetworkDeviceIconAsset(
  type: NetworkDeviceIconType,
  variant: NetworkDeviceIconVariant,
): string {
  const normalized = (type ?? 'generic').toString().toLowerCase();
  const safeType = normalized === 'unknown' ? 'generic' : normalized;
  const iconMap: Record<string, string> = {
    router: 'router',
    switch: 'switch',
    'core-switch': 'switch',
    aggregation: 'switch',
    olt: 'olt',
    onu: 'onu',
    firewall: 'firewall',
    server: 'server',
    wireless: 'wireless',
    cloud: 'cloud',
    internet: 'cloud',
    provider: 'cloud',
    upstream: 'cloud',
    bras: 'bras',
    bng: 'bras',
    generic: 'generic',
  };

  const resolved = iconMap[safeType] ?? 'generic';
  return `/network-icons/${resolved}-${variant}.svg`;
}

function FallbackGlyph({
  type,
  variant,
  status,
  size,
}: {
  type: NetworkDeviceIconType;
  variant: NetworkDeviceIconVariant;
  status: string;
  size: number;
}) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: variant === '3d' ? 1.7 : 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    opacity: 1,
  };

  const strokeColor = status === 'down' ? '#ff6b6b' : status === 'warning' ? '#f7b955' : '#7fe3ff';
  const activeCommon = {
    ...common,
    stroke: strokeColor,
  };

  const iconMap: Record<string, string> = {
    router: 'router',
    switch: 'switch',
    'core-switch': 'switch',
    aggregation: 'switch',
    olt: 'olt',
    onu: 'onu',
    firewall: 'firewall',
    server: 'server',
    wireless: 'wireless',
    cloud: 'cloud',
    bras: 'bras',
  };

  const resolvedType = iconMap[type] ?? 'generic';

  const baseProps = {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    className: 'device-node__svg',
    role: 'img',
    'aria-label': `${resolvedType} device icon (fallback)`,
    style: { overflow: 'visible' } as CSSProperties,
  };

  switch (resolvedType) {
    case 'router':
      return (
        <svg {...baseProps}>
          <path {...common} d="M14 29h36M18 22h28v16H18z" />
          <path {...common} d="M26 22v-6m12 6v-6M22 38v10m20-10v10M18 46h28" />
          <path {...activeCommon} d="M20 25h24" opacity={0.75} />
        </svg>
      );
    case 'switch':
      return (
        <svg {...baseProps}>
          <rect {...common} x="16" y="18" width="32" height="28" rx="3" />
          <path {...common} d="M24 18v28M40 18v28M16 26h32M16 38h32" opacity={0.8} />
          <path {...activeCommon} d="M18 52h28" />
        </svg>
      );
    case 'olt':
      return (
        <svg {...baseProps}>
          <path {...common} d="M16 42l9-18h14l9 18" />
          <path {...common} d="M24 24h16M26 32h12M18 46h28" />
          <path {...activeCommon} d="M20 46V18m24 28V18" opacity={0.7} />
        </svg>
      );
    case 'onu':
      return (
        <svg {...baseProps}>
          <rect {...common} x="18" y="22" width="28" height="22" rx="2" />
          <path {...common} d="M24 18h16M22 50h20M25 30h14" opacity={0.8} />
          <path {...activeCommon} d="M32 14v8" />
        </svg>
      );
    case 'firewall':
      return (
        <svg {...baseProps}>
          <path {...common} d="M32 12l18 8v14c0 10-6 18-18 22-12-4-18-12-18-22V20l18-8z" />
          <path {...activeCommon} d="M24 30h16M22 38h20" opacity={0.7} />
        </svg>
      );
    case 'server':
      return (
        <svg {...baseProps}>
          <rect {...common} x="22" y="12" width="20" height="40" rx="3" />
          <path {...common} d="M26 22h12M26 30h12M26 38h12" opacity={0.8} />
          <path {...activeCommon} d="M32 52v-6" />
        </svg>
      );
    case 'wireless':
      return (
        <svg {...baseProps}>
          <path {...common} d="M18 36c7-9 21-9 28 0" />
          <path {...common} d="M22 42c5-6 15-6 20 0" />
          <path {...common} d="M26 48c3-3 9-3 12 0" />
          <circle {...activeCommon} cx="32" cy="22" r="6" />
        </svg>
      );
    case 'cloud':
      return (
        <svg {...baseProps}>
          <path {...common} d="M18 38c-2-11 7-18 17-16 5-6 17-4 20 7 5 1 8 6 7 11-1 7-8 12-16 12H28c-10 0-17-7-16-14z" />
          <path {...activeCommon} d="M22 42h20" opacity={0.7} />
        </svg>
      );
    case 'bras':
      return (
        <svg {...baseProps}>
          <path {...common} d="M18 24h28v16H18z" />
          <path {...common} d="M14 32h-4M50 32h4M24 18v-6M40 18v-6M26 24l-8 18M38 24l8 18" opacity={0.75} />
        </svg>
      );
    case 'generic':
    default:
      return (
        <svg {...baseProps}>
          <circle {...common} cx="32" cy="24" r="11" />
          <path {...common} d="M16 46h32M22 46V34m20 12V34" opacity={0.8} />
          <circle {...activeCommon} cx="32" cy="24" r="5" opacity={0.8} />
        </svg>
      );
  }
}

export function NetworkDeviceIcon({
  type,
  variant,
  status,
  size = 52,
}: {
  type: NetworkDeviceIconType;
  variant: NetworkDeviceIconVariant;
  status?: string;
  size?: number;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  const assetPath = resolveNetworkDeviceIconAsset(type, variant);
  const safeStatus = status ?? 'up';

  return (
    <div
      className="network-device-icon"
      style={{
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        color: 'currentColor',
        overflow: 'visible',
      }}
    >
      {!loadFailed ? (
        <img
          src={assetPath}
          alt={`${type} device icon`}
          width={size}
          height={size}
          className="device-node__svg"
          onError={() => setLoadFailed(true)}
          style={{ overflow: 'visible', color: 'currentColor' }}
        />
      ) : null}
      {loadFailed && (
        <FallbackGlyph type={type} variant={variant} status={safeStatus} size={size} />
      )}
    </div>
  );
}
