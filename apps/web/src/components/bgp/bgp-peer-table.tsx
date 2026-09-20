'use client';

import type { BgpDashboardDevice, BgpDashboardPeer } from '@gmj/shared';
import { formatBgpTraffic, formatBgpUptime, formatRouteCount } from '@/lib/bgp-format';

function stateLabel(peer: BgpDashboardPeer): string {
  return peer.established ? 'UP' : peer.state === 'UNKNOWN' ? 'DOWN' : peer.state;
}

function roleLabel(role: BgpDashboardPeer['role']): string | null {
  return role === 'OTHER' ? null : role;
}

export function BgpPeerTable({
  devices,
  onSelectPeer,
}: {
  devices: BgpDashboardDevice[];
  onSelectPeer: (peer: BgpDashboardPeer) => void;
}) {
  if (!devices.length) {
    return (
      <div className="hosts-table-wrap">
        <div className="hosts-empty">
          <span>Nenhum peer BGP encontrado para os filtros selecionados.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bgp-table-wrap hosts-table-wrap">
      <table className="bgp-table">
        <thead>
          <tr>
            <th>Estado</th>
            <th>Peer</th>
            <th>ASN</th>
            <th>Rotas</th>
            <th>Tráfego da interface</th>
            <th>Uptime</th>
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
          </header>
          <table className="bgp-table bgp-table--rows">
            <tbody>
              {device.peers.map((peer) => (
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
