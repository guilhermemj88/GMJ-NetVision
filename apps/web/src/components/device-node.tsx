'use client';

import type { CSSProperties } from 'react';
import type { Device, MapNode as DomainMapNode, NodeDisplayMode } from '@gmj/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { LockKeyhole } from 'lucide-react';

export interface DeviceNodeData extends Record<string, unknown> {
  device: Device;
  mapNode: DomainMapNode;
  editMode: boolean;
  showInterfaces: boolean;
  displayMode: NodeDisplayMode;
  nodeScale: number;
  labelScale: number;
}

export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

type NetworkIconKind =
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
  | 'generic';

function normalizeDeviceKind(device: Device): NetworkIconKind {
  const text = `${device.name} ${device.hostname} ${device.model} ${device.vendor} ${device.deviceType}`.toLowerCase();

  if (/olt|ont|onu|optical/.test(text)) return 'olt';
  if (/bng|bras/.test(text)) return 'bras';
  if (/fw|firewall|fortigate|fgt|pa-/.test(text)) return 'firewall';
  if (/ap|wifi|wireless|wlan/.test(text)) return 'wireless';
  if (/cloud|internet|provider|upstream|peer|backbone|operadora|external|wan/.test(text) || device.deviceType === 'internet' || device.deviceType === 'ix') {
    return 'cloud';
  }
  if (/s6730|s6720|s6750|s[0-9]{3,}|switch|core/.test(text)) return 'switch';
  if (/ne40|ne8000|asr|mx|ccr|rtr|router|pe router|p router/.test(text)) return 'router';
  if (device.deviceType === 'core') return 'core-switch';
  if (device.deviceType === 'aggregation') return 'aggregation';
  if (device.deviceType === 'server') return 'server';
  if (device.deviceType === 'olt') return 'olt';
  if (device.deviceType === 'firewall') return 'firewall';
  if (device.deviceType === 'switch') return 'switch';
  if (device.deviceType === 'router') return 'router';
  if (device.deviceType === 'generic') return 'generic';
  return 'generic';
}

function DeviceIcon({ kind, variant }: { kind: NetworkIconKind; variant: '2d' | '3d' }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: variant === '3d' ? 1.7 : 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  const baseProps = { width: 44, height: 44, viewBox: '0 0 64 64', className: 'device-node__svg' };

  switch (kind) {
    case 'router':
      return (
        <svg {...baseProps}>
          <path {...common} d="M14 29h36M18 22h28v16H18z" />
          <path {...common} d="M26 22v-6m12 6v-6M22 38v10m20-10v10M18 46h28" />
          <path {...common} d="M20 26h24" opacity={0.7} />
        </svg>
      );
    case 'switch':
      return (
        <svg {...baseProps}>
          <rect {...common} x="16" y="18" width="32" height="28" rx="3" />
          <path {...common} d="M24 18v28M40 18v28M16 26h32M16 38h32" opacity={0.8} />
          <path {...common} d="M18 52h28" />
        </svg>
      );
    case 'core-switch':
      return (
        <svg {...baseProps}>
          <path {...common} d="M18 17h28v30H18z" />
          <path {...common} d="M24 17v30M40 17v30M18 25h28M18 39h28" opacity={0.8} />
          <path {...common} d="M22 50h20" />
          <path {...common} d="M12 50h6M46 50h6" />
        </svg>
      );
    case 'aggregation':
      return (
        <svg {...baseProps}>
          <path {...common} d="M18 18h10v10H18zm18 0h10v10H36zm-18 18h10v10H18zm18 0h10v10H36z" />
          <path {...common} d="M28 18v28M18 32h28" opacity={0.7} />
        </svg>
      );
    case 'olt':
      return (
        <svg {...baseProps}>
          <path {...common} d="M16 42l9-18h14l9 18" />
          <path {...common} d="M24 24h16M26 32h12M18 46h28" />
          <path {...common} d="M20 46V18m24 28V18" opacity={0.7} />
        </svg>
      );
    case 'onu':
      return (
        <svg {...baseProps}>
          <rect {...common} x="18" y="22" width="28" height="22" rx="2" />
          <path {...common} d="M24 18h16M22 50h20M25 30h14" opacity={0.8} />
          <path {...common} d="M32 14v8" />
        </svg>
      );
    case 'firewall':
      return (
        <svg {...baseProps}>
          <path {...common} d="M32 12l18 8v14c0 10-6 18-18 22-12-4-18-12-18-22V20l18-8z" />
          <path {...common} d="M24 30h16M22 38h20" opacity={0.7} />
        </svg>
      );
    case 'server':
      return (
        <svg {...baseProps}>
          <rect {...common} x="22" y="12" width="20" height="40" rx="3" />
          <path {...common} d="M26 22h12M26 30h12M26 38h12" opacity={0.8} />
          <path {...common} d="M32 52v-6" />
        </svg>
      );
    case 'wireless':
      return (
        <svg {...baseProps}>
          <path {...common} d="M18 36c7-9 21-9 28 0" />
          <path {...common} d="M22 42c5-6 15-6 20 0" />
          <path {...common} d="M26 48c3-3 9-3 12 0" />
          <circle {...common} cx="32" cy="22" r="6" />
        </svg>
      );
    case 'cloud':
      return (
        <svg {...baseProps}>
          <path {...common} d="M18 38c-2-11 7-18 17-16 5-6 17-4 20 7 5 1 8 6 7 11-1 7-8 12-16 12H28c-10 0-17-7-16-14z" />
          <path {...common} d="M22 42h20" opacity={0.7} />
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
        </svg>
      );
  }
}

export function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { device, mapNode, editMode, showInterfaces, displayMode, nodeScale, labelScale } = data;
  const kind = normalizeDeviceKind(device);

  return (
    <div
      className={`device-node device-node--${displayMode.toLowerCase()} status-${device.status.toLowerCase()} ${selected ? 'is-selected' : ''} ${mapNode.locked ? 'is-locked' : ''}`}
      style={
        {
          '--node-scale': nodeScale / 100,
          '--node-label-scale': labelScale / 100,
        } as CSSProperties
      }
      title={`${device.name} · ${device.ip} · ${device.status}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={editMode} />
      <div className="device-node__icon">
        <DeviceIcon kind={kind} variant={displayMode === 'ICON_3D' ? '3d' : '2d'} />
        <span className="status-pulse" />
      </div>
      <div className="device-node__copy">
        <strong>{device.name}</strong>
        {displayMode === 'CARD' && <span>{device.site}</span>}
      </div>
      {mapNode.locked && <LockKeyhole className="device-node__lock" size={13} />}
      {showInterfaces && (
        <span className="device-node__ports">{device.interfaces.length} ports</span>
      )}
      <div className="device-tooltip">
        <strong>{device.name}</strong>
        <span>{device.ip}</span>
        <span>
          {device.vendor} {device.model}
        </span>
        <small>
          {device.site} · {device.status}
        </small>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={editMode} />
    </div>
  );
}
