'use client';

import type { CSSProperties } from 'react';
import type { MapNode as DomainMapNode, NodeDisplayMode } from '@gmj/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { LockKeyhole } from 'lucide-react';
import { DEVICE_HANDLE_SIDES } from '@/lib/edge-handles';
import { normalizeGenericIconType } from '@/lib/device-appearance';
import { NetworkDeviceIcon } from './network-device-icon';
import { NetworkDeviceGlyphV2 } from './network-device-glyphs-v2';
import {
  MAP_GLYPH_BASE_SIZE,
  isMapGlyphCompact,
  mapGlyphEffectiveSize,
  resolveMapDeviceGlyphV2,
} from '@/lib/map-visual-v2-glyphs';

export interface GenericNodeData extends Record<string, unknown> {
  mapNode: DomainMapNode;
  editMode: boolean;
  displayMode: NodeDisplayMode;
  nodeScale: number;
  labelScale: number;
  /** Fora da camada/recorte atual: atenuado, mas ainda clicável. */
  dimmed?: boolean;
  /** MAP-VISUAL-V2: qual jogo de glifos usar (padrão V1 — produção intacta). */
  glyphEngine?: 'v1' | 'v2';
}

export type GenericFlowNode = Node<GenericNodeData, 'generic'>;

const handlePositions = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
} as const;

export function GenericNode({ data, selected }: NodeProps<GenericFlowNode>) {
  const { mapNode, editMode, displayMode, nodeScale, labelScale, dimmed, glyphEngine = 'v1' } = data;
  const iconType = normalizeGenericIconType(mapNode.genericType);
  const iconVariant = displayMode === 'ICON_3D' ? '3d' : '2d';
  const label = mapNode.label || mapNode.genericType || 'Node';
  const v2Glyph = glyphEngine === 'v2' ? resolveMapDeviceGlyphV2(iconType) : null;

  return (
    <div
      className={`device-node device-node--${displayMode.toLowerCase()} device-node--type-${iconType.toLowerCase().replaceAll('_', '-')} ${selected ? 'is-selected' : ''} ${mapNode.locked ? 'is-locked' : ''} ${dimmed ? 'is-dimmed' : ''}`}
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
        {v2Glyph ? (
          <NetworkDeviceGlyphV2
            type={v2Glyph}
            size={MAP_GLYPH_BASE_SIZE}
            className="device-node__glyph"
            compact={isMapGlyphCompact(v2Glyph, mapGlyphEffectiveSize(nodeScale))}
          />
        ) : (
          <NetworkDeviceIcon type={iconType} variant={iconVariant} size={MAP_GLYPH_BASE_SIZE} />
        )}
      </div>
      <div className="device-node__copy">
        <strong>{label}</strong>
        <span>{mapNode.genericType ?? 'GENERIC'}</span>
      </div>
      {mapNode.locked && <LockKeyhole className="device-node__lock" size={13} />}
    </div>
  );
}
