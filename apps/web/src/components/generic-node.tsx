'use client';

import type { CSSProperties } from 'react';
import type { MapNode as DomainMapNode, NodeDisplayMode } from '@gmj/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { LockKeyhole } from 'lucide-react';
import { DEVICE_HANDLE_SIDES } from '@/lib/edge-handles';
import { normalizeGenericIconType } from '@/lib/device-appearance';
import { NetworkDeviceIcon } from './network-device-icon';

export interface GenericNodeData extends Record<string, unknown> {
  mapNode: DomainMapNode;
  editMode: boolean;
  displayMode: NodeDisplayMode;
  nodeScale: number;
  labelScale: number;
}

export type GenericFlowNode = Node<GenericNodeData, 'generic'>;

const handlePositions = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
} as const;

export function GenericNode({ data, selected }: NodeProps<GenericFlowNode>) {
  const { mapNode, editMode, displayMode, nodeScale, labelScale } = data;
  const iconType = normalizeGenericIconType(mapNode.genericType);
  const iconVariant = displayMode === 'ICON_3D' ? '3d' : '2d';
  const label = mapNode.label || mapNode.genericType || 'Node';

  return (
    <div
      className={`device-node device-node--${displayMode.toLowerCase()} device-node--type-${iconType.toLowerCase().replaceAll('_', '-')} ${selected ? 'is-selected' : ''} ${mapNode.locked ? 'is-locked' : ''}`}
      style={
        {
          '--node-scale': nodeScale / 100,
          '--node-label-scale': labelScale / 100,
        } as CSSProperties
      }
      title={label}
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
        <NetworkDeviceIcon type={iconType} variant={iconVariant} size={32} />
      </div>
      <div className="device-node__copy">
        <strong>{label}</strong>
        <span>{mapNode.genericType ?? 'GENERIC'}</span>
      </div>
      {mapNode.locked && <LockKeyhole className="device-node__lock" size={13} />}
    </div>
  );
}
