'use client';

import type { Device, MapNode as DomainMapNode, NodeDisplayMode } from '@gmj/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Boxes,
  Building2,
  Cable,
  Cloud,
  Earth,
  LockKeyhole,
  Network,
  RadioTower,
  Router,
  Server,
  Shield,
  Users,
} from 'lucide-react';

export interface DeviceNodeData extends Record<string, unknown> {
  device: Device;
  mapNode: DomainMapNode;
  editMode: boolean;
  showInterfaces: boolean;
  displayMode: NodeDisplayMode;
}

export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

function DeviceIcon({ type, large }: { type: Device['deviceType']; large: boolean }) {
  const props = { size: large ? 30 : 22, strokeWidth: large ? 1.55 : 1.7 };
  switch (type) {
    case 'internet':
      return <Earth {...props} />;
    case 'ix':
      return <Cloud {...props} />;
    case 'firewall':
      return <Shield {...props} />;
    case 'olt':
      return <RadioTower {...props} />;
    case 'server':
      return <Server {...props} />;
    case 'customers':
      return <Users {...props} />;
    case 'core':
      return <Network {...props} />;
    case 'aggregation':
      return <Boxes {...props} />;
    case 'edge':
    case 'router':
      return <Router {...props} />;
    case 'switch':
      return <Cable {...props} />;
    default:
      return <Building2 {...props} />;
  }
}

export function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { device, mapNode, editMode, showInterfaces, displayMode } = data;
  const isIcon = displayMode !== 'CARD';
  return (
    <div
      className={`device-node device-node--${displayMode.toLowerCase()} status-${device.status.toLowerCase()} ${selected ? 'is-selected' : ''} ${mapNode.locked ? 'is-locked' : ''}`}
      title={`${device.name} · ${device.ip} · ${device.status}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={editMode} />
      <div className="device-node__icon">
        <DeviceIcon type={device.deviceType} large={isIcon} />
        <span className="status-pulse" />
      </div>
      <div className="device-node__copy">
        <strong>{device.name}</strong>
        <span>{device.site}</span>
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
