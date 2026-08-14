'use client';

import type { Device, MapNode as DomainMapNode } from '@gmj/shared';
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
}

export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

function DeviceIcon({ type }: { type: Device['deviceType'] }) {
  const props = { size: 22, strokeWidth: 1.7 };
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
  const { device, mapNode, editMode, showInterfaces } = data;
  return (
    <div
      className={`device-node status-${device.status.toLowerCase()} ${selected ? 'is-selected' : ''} ${mapNode.locked ? 'is-locked' : ''}`}
      title={`${device.name} · ${device.ip} · ${device.status}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={editMode} />
      <div className="device-node__icon">
        <DeviceIcon type={device.deviceType} />
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
      <Handle type="source" position={Position.Right} isConnectable={editMode} />
    </div>
  );
}
