'use client';

import type { CSSProperties } from 'react';
import type { Device, MapNode as DomainMapNode, NodeDisplayMode } from '@gmj/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { LockKeyhole } from 'lucide-react';
import { NetworkDeviceIcon } from './network-device-icon';

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

  if (/onu|ont|olt|optical/.test(text)) return 'onu';
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

export function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { device, mapNode, editMode, showInterfaces, displayMode, nodeScale, labelScale } = data;
  const kind = normalizeDeviceKind(device);
  const iconVariant = displayMode === 'ICON_3D' ? '3d' : '2d';

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
        <NetworkDeviceIcon type={kind} variant={iconVariant} status={device.status.toLowerCase()} size={52} />
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
