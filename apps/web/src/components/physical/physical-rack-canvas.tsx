'use client';

import type {
  PhysicalConnection,
  PhysicalPath,
  PhysicalPort,
  PhysicalRack,
} from '@gmj/shared';
import { PORT_STATE_LABELS } from './physical-catalog';
import type { PhysicalConnectionMode, PhysicalSelection } from './physical-types';

const U_HEIGHT = 30;
const RACK_LEFT = 58;
const RACK_WIDTH = 560;
const LANE_X = 664;
const CANVAS_WIDTH = 820;

function assetTop(rack: PhysicalRack, startU: number, heightU: number): number {
  return (rack.units - (startU + heightU - 1)) * U_HEIGHT;
}

function portPoint(rack: PhysicalRack, assetId: string, portId: string): { x: number; y: number } | null {
  const asset = rack.assets.find((candidate) => candidate.id === assetId);
  if (!asset) return null;
  const index = Math.max(0, asset.ports.findIndex((port) => port.id === portId));
  const top = assetTop(rack, asset.startU, asset.heightU);
  const height = asset.heightU * U_HEIGHT;
  const columns = Math.min(16, Math.max(1, asset.ports.length));
  const visibleIndex = index % columns;
  return {
    x: RACK_LEFT + RACK_WIDTH - 22 - (columns - 1 - visibleIndex) * 15,
    y: top + height / 2,
  };
}

interface CablePath {
  connection: PhysicalConnection;
  d: string;
  selected: boolean;
  related: boolean;
  exitLabel?: string;
  labelX?: number;
  labelY?: number;
}

interface Props {
  rack: PhysicalRack;
  connections: PhysicalConnection[];
  mode: PhysicalConnectionMode;
  selection: PhysicalSelection;
  path: PhysicalPath | null;
  onSelectAsset: (id: string) => void;
  onSelectPort: (id: string) => void;
  onSelectConnection: (id: string) => void;
  onClear: () => void;
}

export function PhysicalRackCanvas({
  rack,
  connections,
  mode,
  selection,
  path,
  onSelectAsset,
  onSelectPort,
  onSelectConnection,
  onClear,
}: Props) {
  const pathConnectionIds = new Set(
    path?.steps.flatMap((step) => (step.kind === 'CABLE' ? [step.connectionId] : [])) ?? [],
  );
  const selectedConnectionId = selection?.kind === 'connection' ? selection.id : null;
  const related = (connection: PhysicalConnection) => {
    if (selection?.kind === 'asset') {
      return connection.a.assetId === selection.id || connection.b.assetId === selection.id;
    }
    if (selection?.kind === 'port') return pathConnectionIds.has(connection.id);
    if (selection?.kind === 'connection') return connection.id === selection.id;
    return false;
  };

  let exitSlot = 0;
  const cables: CablePath[] = connections.flatMap((connection) => {
    const aInRack = connection.a.rackId === rack.id;
    const bInRack = connection.b.rackId === rack.id;
    if (!aInRack && !bInRack) return [];
    const isRelated = related(connection);
    if (mode === 'hidden' || (mode === 'selected' && !isRelated)) return [];
    const selected = connection.id === selectedConnectionId || pathConnectionIds.has(connection.id);
    if (aInRack && bInRack) {
      const a = portPoint(rack, connection.a.assetId, connection.portAId);
      const b = portPoint(rack, connection.b.assetId, connection.portBId);
      if (!a || !b) return [];
      const lane = LANE_X + (exitSlot % 4) * 16;
      exitSlot += 1;
      return [{ connection, d: `M ${a.x} ${a.y} H ${lane} V ${b.y} H ${b.x}`, selected, related: isRelated }];
    }
    const local = aInRack ? connection.a : connection.b;
    const point = portPoint(rack, local.assetId, local.portId);
    if (!point) return [];
    const y = 22 + exitSlot * 24;
    const lane = LANE_X + (exitSlot % 4) * 16;
    exitSlot += 1;
    const remote = aInRack ? connection.b : connection.a;
    return [
      {
        connection,
        d: `M ${point.x} ${point.y} H ${lane} V ${y} H ${CANVAS_WIDTH - 12}`,
        selected,
        related: isRelated,
        exitLabel: `→ ${remote.siteName} / ${remote.rackName} / ${remote.assetName}`,
        labelX: LANE_X + 8,
        labelY: y - 6,
      },
    ];
  });

  const activeAssetIds = new Set<string>();
  if (selection?.kind === 'asset') activeAssetIds.add(selection.id);
  if (selection?.kind === 'port') {
    for (const asset of rack.assets) {
      if (asset.ports.some((port) => port.id === selection.id)) activeAssetIds.add(asset.id);
    }
  }
  for (const cable of cables.filter((item) => item.related)) {
    activeAssetIds.add(cable.connection.a.assetId);
    activeAssetIds.add(cable.connection.b.assetId);
  }

  return (
    <div className="physical-canvas-scroll" onClick={onClear}>
      <div
        className="physical-canvas"
        style={{ width: CANVAS_WIDTH, height: rack.units * U_HEIGHT + 64 }}
      >
        <div
          className="physical-rack-frame"
          style={{ left: RACK_LEFT, width: RACK_WIDTH, height: rack.units * U_HEIGHT }}
        >
          {Array.from({ length: rack.units }, (_, index) => {
            const unit = rack.units - index;
            return (
              <div
                key={unit}
                className={`physical-u-row ${unit % 5 === 0 ? 'is-major' : ''}`}
                style={{ top: index * U_HEIGHT, height: U_HEIGHT }}
              >
                <span>{String(unit).padStart(2, '0')}</span>
                <span>{unit % 5 === 0 ? String(unit).padStart(2, '0') : ''}</span>
              </div>
            );
          })}
          <div className="physical-rail physical-rail--left" />
          <div className="physical-rail physical-rail--right" />
        </div>

        <div
          className="physical-cable-lane"
          style={{ left: LANE_X, height: rack.units * U_HEIGHT }}
          aria-hidden="true"
        >
          <span>CABLE LANE</span>
        </div>

        <svg
          className="physical-cables"
          width={CANVAS_WIDTH}
          height={rack.units * U_HEIGHT}
          aria-label="Conexões físicas"
        >
          {cables.map((cable) => (
            <g key={cable.connection.id}>
              <path
                d={cable.d}
                className={`physical-cable-hit ${cable.selected ? 'is-selected' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectConnection(cable.connection.id);
                }}
              />
              <path
                d={cable.d}
                className={`physical-cable physical-cable--${cable.connection.medium.toLowerCase()} ${
                  cable.selected ? 'is-selected' : cable.related ? 'is-related' : 'is-dim'
                }`}
              />
              {cable.exitLabel ? (
                <text x={cable.labelX} y={cable.labelY} className="physical-cable-label">
                  {cable.exitLabel}
                </text>
              ) : null}
            </g>
          ))}
        </svg>

        {rack.assets.map((asset) => {
          const top = assetTop(rack, asset.startU, asset.heightU);
          const active = activeAssetIds.has(asset.id);
          const dimmed = Boolean(selection && activeAssetIds.size && !active);
          const uEnd = asset.startU + asset.heightU - 1;
          const portButton = (port: PhysicalPort, context: string) => {
            const selected = selection?.kind === 'port' && selection.id === port.id;
            const pathPort = path?.steps.some(
              (step) => step.kind === 'PORT' && step.portId === port.id,
            );
            return (
              <button
                key={port.id}
                type="button"
                className={`physical-port state-${port.state.toLowerCase()} ${
                  selected || pathPort ? 'is-selected' : ''
                } physical-port--${port.side.toLowerCase()}`}
                title={`${port.name}${port.label ? ` · ${port.label}` : ''} · ${PORT_STATE_LABELS[port.state]}${
                  port.lldp ? ` · LLDP ${port.lldp.remoteHostname}/${port.lldp.remotePortName}` : ''
                }`}
                aria-label={`${context}, porta ${port.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectPort(port.id);
                }}
              >
                <span />
                {port.lldp ? <i className="physical-port__lldp" aria-hidden="true" /> : null}
              </button>
            );
          };
          const flatPorts = asset.ports.filter((port) => !port.moduleId);
          return (
            <article
              key={asset.id}
              className={`physical-faceplate physical-faceplate--${asset.kind.toLowerCase()} ${
                active ? 'is-selected' : ''
              } ${dimmed ? 'is-dimmed' : ''} ${asset.slots.length ? 'is-modular' : ''}`}
              style={{
                left: RACK_LEFT + 22,
                top: top + 1,
                width: RACK_WIDTH - 44,
                height: asset.heightU * U_HEIGHT - 2,
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectAsset(asset.id);
              }}
            >
              <span className="physical-faceplate__kind" />
              <div className="physical-faceplate__identity">
                <strong>{asset.name}</strong>
                <small>
                  {asset.template?.manufacturer || asset.device?.vendor || asset.kind}
                  {' · '}U{asset.startU}{uEnd > asset.startU ? `–U${uEnd}` : ''}
                </small>
              </div>
              <div className="physical-faceplate__ports" aria-label={`Portas de ${asset.name}`}>
                {asset.slots.length ? (
                  <div className="physical-faceplate__slots">
                    {asset.slots.map((slot) => (
                      <div
                        key={slot.id}
                        className={`physical-slot ${slot.module ? 'is-occupied' : ''}`}
                        title={
                          slot.module
                            ? `${slot.label || `Slot ${slot.index}`} · ${slot.module.name}`
                            : `${slot.label || `Slot ${slot.index}`} · vazio`
                        }
                      >
                        <em>{slot.index}</em>
                        {slot.module ? (
                          <>
                            <small>{slot.module.model || slot.module.name}</small>
                            <div className="physical-slot__ports">
                              {slot.module.ports
                                .slice(0, 6)
                                .map((port) => portButton(port, `${asset.name} ${slot.module?.name ?? ''}`))}
                            </div>
                          </>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="physical-faceplate__flat">
                  {flatPorts.slice(0, 24).map((port) => portButton(port, asset.name))}
                  {flatPorts.length > 24 ? <b>+{flatPorts.length - 24}</b> : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
