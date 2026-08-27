'use client';

import { useCallback, useSyncExternalStore, type CSSProperties } from 'react';
import {
  formatPppLabel,
  formatPppOnline,
  isPppVisible,
  type Device,
  type MapNode as DomainMapNode,
  type NodeDisplayMode,
} from '@gmj/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { LockKeyhole } from 'lucide-react';
import {
  getDeviceIconPreference,
  resolveDeviceIconType,
  subscribeDeviceIconPreference,
  type DeviceIconType,
} from '@/lib/device-appearance';
import { NetworkDeviceIcon } from './network-device-icon';
import { DEVICE_HANDLE_SIDES } from '@/lib/edge-handles';

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

const handlePositions = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
} as const;

export function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { device, mapNode, editMode, showInterfaces, displayMode, nodeScale, labelScale } = data;
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeDeviceIconPreference(device.id, onStoreChange),
    [device.id],
  );
  const getSnapshot = useCallback(() => getDeviceIconPreference(device.id), [device.id]);
  const getServerSnapshot = useCallback((): DeviceIconType => 'AUTO', []);
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const iconType = resolveDeviceIconType(device, preference);
  const iconVariant = displayMode === 'ICON_3D' ? '3d' : '2d';
  const showPpp = isPppVisible(mapNode.pppDisplayMode, device.pppSupported, device.pppOnline);
  const pppLabelStyle = {
    ...(mapNode.pppColor ? { color: mapNode.pppColor } : {}),
    fontSize: mapNode.pppFontSize,
  } as CSSProperties;

  return (
    <div
      className={`device-node device-node--${displayMode.toLowerCase()} device-node--type-${iconType.toLowerCase().replaceAll('_', '-')} status-${device.status.toLowerCase()} ${selected ? 'is-selected' : ''} ${mapNode.locked ? 'is-locked' : ''}`}
      style={
        {
          '--node-scale': nodeScale / 100,
          '--node-label-scale': labelScale / 100,
        } as CSSProperties
      }
      title={`${device.name} · ${device.ip} · ${device.status}`}
    >
      {DEVICE_HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={handlePositions[side]}
          isConnectable={editMode}
        />
      ))}
      <div className="device-node__icon">
        <NetworkDeviceIcon
          type={iconType}
          variant={iconVariant}
          status={device.status.toLowerCase()}
          size={32}
        />
        <span className="status-pulse" />
      </div>
      <div className="device-node__copy">
        <strong>{device.name}</strong>
        <span>{device.ip}</span>
        {displayMode === 'CARD' && <em>{device.site}</em>}
      </div>
      {mapNode.locked && <LockKeyhole className="device-node__lock" size={13} />}
      {showInterfaces && (
        <span className="device-node__ports">{device.interfaces.length} ports</span>
      )}
      {showPpp && (
        <span
          className={`device-node__ppp device-node__ppp--${mapNode.pppPosition.toLowerCase()}`}
          style={pppLabelStyle}
        >
          {formatPppLabel(device.pppOnline)}
        </span>
      )}
      <div className="device-tooltip">
        <strong>{device.name}</strong>
        <span>{device.ip}</span>
        <span>
          {device.vendor} {device.model}
        </span>
        {device.pppSupported && <span>PPP online: {formatPppOnline(device.pppOnline)}</span>}
        <small>
          {device.site} · {device.status}
        </small>
      </div>
    </div>
  );
}
