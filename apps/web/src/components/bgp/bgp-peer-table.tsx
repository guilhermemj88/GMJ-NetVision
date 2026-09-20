'use client';

import { useState } from 'react';
import type { BgpDashboardDevice, BgpDashboardPeer } from '@gmj/shared';
import { RefreshCw } from 'lucide-react';
import { formatBgpTraffic, formatBgpUptime, formatRouteCount } from '@/lib/bgp-format';
import { nextSort, sortBgpPeers, type BgpSort, type BgpSortKey } from '@/lib/bgp-sort';

function stateLabel(peer: BgpDashboardPeer): string {
  return peer.established ? 'UP' : peer.state === 'UNKNOWN' ? 'DOWN' : peer.state;
}

function roleLabel(role: BgpDashboardPeer['role']): string | null {
  return role === 'OTHER' ? null : role;
}

const SORTABLE_COLUMNS: Array<{ key: BgpSortKey; label: string }> = [
  { key: 'state', label: 'Estado' },
  { key: 'peer', label: 'Peer' },
  { key: 'asn', label: 'ASN' },
  { key: 'routes', label: 'Rotas' },
  { key: 'traffic', label: 'Tráfego da interface' },
  { key: 'uptime', label: 'Uptime' },
];

export function BgpPeerTable({
  devices,
  onSelectPeer,
  onRefreshDevice,
  refreshingDeviceIds,
  emptyMessage,
}: {
  devices: BgpDashboardDevice[];
  onSelectPeer: (peer: BgpDashboardPeer) => void;
  onRefreshDevice?: (deviceId: string) => void;
  refreshingDeviceIds?: ReadonlySet<string>;
  emptyMessage?: string;
}) {
  const [sort, setSort] = useState<BgpSort>({ key: 'state', direction: 'asc' });

  if (!devices.length) {
    return (
      <div className="hosts-table-wrap">
        <div className="hosts-empty">
          <span>{emptyMessage ?? 'Nenhum peer BGP encontrado para os filtros selecionados.'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bgp-table-wrap hosts-table-wrap">
      <table className="bgp-table">
        <thead>
          <tr>
            {SORTABLE_COLUMNS.map((column) => (
              <th key={column.key}>
                <button
                  type="button"
                  className="bgp-sort"
                  onClick={() => setSort((current) => nextSort(current, column.key))}
                >
                  {column.label}
                  <span className={sort.key === column.key ? 'is-active' : ''}>
                    {sort.key === column.key ? (sort.direction === 'asc' ? '↑' : '↓') : ''}
                  </span>
                </button>
              </th>
            ))}
            <th>Histórico</th>
          </tr>
        </thead>
      </table>
      {devices.map((device) => (
        <section key={device.id} className="bgp-device">
          <header className="bgp-device__header">
            <span className={`host-status host-status--${device.bgpMonitoringEnabled ? 'up' : 'warning'}`} />
            <strong>{device.displayName || device.hostname}</strong>
            <small>{device.hostname}</small>
            <em>{device.peers.length} peer(s)</em>
            {onRefreshDevice && (
              <button
                type="button"
                className="bgp-device__refresh"
                disabled={refreshingDeviceIds?.has(device.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  onRefreshDevice(device.id);
                }}
              >
                <RefreshCw
                  size={12}
                  className={refreshingDeviceIds?.has(device.id) ? 'spin' : ''}
                />
                {refreshingDeviceIds?.has(device.id) ? 'Atualizando...' : 'Atualizar agora'}
              </button>
            )}
          </header>
          <table className="bgp-table bgp-table--rows">
            <tbody>
              {sortBgpPeers(device.peers, sort).map((peer) => (
                <tr
                  key={peer.id}
                  className={peer.established ? 'is-up' : 'is-down'}
                  onClick={() => onSelectPeer(peer)}
                >
                  <td data-label="Estado">
                    <span className={`bgp-state bgp-state--${peer.established ? 'up' : 'down'}`}>
                      <span />
                      {stateLabel(peer)}
                    </span>
                    {!peer.established && peer.state !== 'UNKNOWN' && (
                      <small className="bgp-state__technical">{peer.state}</small>
                    )}
                  </td>
                  <td data-label="Peer">
                    <strong>{peer.displayName}</strong>
                    <small>{peer.peerAddress}</small>
                  </td>
                  <td data-label="ASN">
                    <span>{peer.remoteAs ?? '-'}</span>
                    {roleLabel(peer.role) && <small className="bgp-role">{roleLabel(peer.role)}</small>}
                  </td>
                  <td data-label="Rotas">
                    <span className="bgp-routes">{formatRouteCount(peer.receivedPrefixes)}</span>
                  </td>
                  <td data-label="Tráfego da interface">
                    {peer.interface ? (
                      <span className="bgp-traffic">
                        <em className="rx">↓ {formatBgpTraffic(peer.interface.rxBps)}</em>
                        <em className="tx">↑ {formatBgpTraffic(peer.interface.txBps)}</em>
                      </span>
                    ) : (
                      <span className="bgp-traffic bgp-traffic--empty">-</span>
                    )}
                  </td>
                  <td data-label="Uptime">
                    <span>{formatBgpUptime(peer.establishedSince)}</span>
                  </td>
                  <td data-label="Histórico">
                    <span className="bgp-sparkline bgp-sparkline--empty">—</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

