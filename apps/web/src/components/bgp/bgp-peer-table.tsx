'use client';

import { useState } from 'react';
import type { BgpDashboardDevice, BgpDashboardPeer } from '@gmj/shared';
import { RefreshCw, ChevronRight } from 'lucide-react';
import { formatBgpTraffic, formatBgpUptime, formatRouteCount } from '@/lib/bgp-format';
import { formatRelative } from '@/lib/bgp-format';
import { nextSort, sortBgpPeers, type BgpSort, type BgpSortKey } from '@/lib/bgp-sort';
import { isDdosMitigationUiEnabled } from '@/lib/feature-flags';

function stateLabel(peer: BgpDashboardPeer): string {
  return peer.established ? 'UP' : peer.state === 'UNKNOWN' ? 'DOWN' : peer.state;
}

function roleLabel(role: BgpDashboardPeer['role']): string | null {
  return role === 'OTHER' ? null : role;
}

function familyLabel(family: BgpDashboardPeer['addressFamily']): string {
  return family === 'IPV6' ? 'IPv6' : 'IPv4';
}

const SORTABLE_COLUMNS: Array<{ key: BgpSortKey; label: string }> = [
  { key: 'state', label: 'Estado' },
  { key: 'peer', label: 'Peer' },
  { key: 'asn', label: 'ASN' },
  { key: 'routes', label: 'Rotas' },
  { key: 'traffic', label: 'Tráfego da interface' },
  { key: 'uptime', label: 'Uptime' },
];

/**
 * Quedas e indisponibilidade corrente do peer.
 *
 * `flaps` conta as transições observadas nas últimas 48h (alertas ativos +
 * resolvidos) e `downSince` é o início da indisponibilidade atual. Nada é
 * inferido: sem alerta, a célula mostra "—".
 */
function FlapCell({
  flaps,
  downSince,
  now,
}: {
  flaps: number;
  downSince: string | null;
  now?: number | undefined;
}) {
  if (!flaps && !downSince) return <span className="hosts-cell-muted">—</span>;
  const startedAt = downSince ? Date.parse(downSince) : Number.NaN;
  const downFor =
    downSince && now !== undefined && Number.isFinite(startedAt)
      ? formatRelative(now - startedAt)
      : null;

  return (
    <span className="bgp-flaps">
      {flaps > 0 && (
        <em className={flaps > 1 ? 'is-many' : ''} title={`${flaps} queda(s) nas últimas 48h`}>
          {flaps}×
        </em>
      )}
      {downSince && downFor ? (
        <small title={`Fora de ESTABLISHED desde ${new Date(downSince).toLocaleString('pt-BR')}`}>
          down {downFor}
        </small>
      ) : null}
    </span>
  );
}

/**
 * Card do peer para o celular.
 *
 * Mesma fonte de dados da tabela: recebe o peer já ordenado, as quedas de 48h
 * e o início da indisponibilidade corrente. Nada é recalculado nem inferido —
 * `DOWN há` só aparece quando existe alerta ativo com data.
 */
function BgpPeerCard({
  peer,
  flaps,
  downSince,
  now,
  onSelect,
}: {
  peer: BgpDashboardPeer;
  flaps: number;
  downSince: string | null;
  now?: number | undefined;
  onSelect: (peer: BgpDashboardPeer) => void;
}) {
  const startedAt = downSince ? Date.parse(downSince) : Number.NaN;
  const downFor =
    downSince && now !== undefined && Number.isFinite(startedAt)
      ? formatRelative(now - startedAt)
      : null;
  const uptime = formatBgpUptime(peer.establishedSince);

  return (
    <button
      type="button"
      className={`bgp-card${peer.established ? ' is-up' : ' is-down'}`}
      onClick={() => onSelect(peer)}
    >
      <span className="bgp-card__top">
        <span className="bgp-card__identity">
          <strong>{peer.peerAddress}</strong>
          <small>{peer.displayName}</small>
        </span>
        <span className={`bgp-state bgp-state--${peer.established ? 'up' : 'down'}`}>
          <span />
          {peer.established ? 'UP' : 'DOWN'}
        </span>
      </span>

      <span className="bgp-card__device">{peer.deviceDisplayName || peer.deviceHostname}</span>

      <span className="bgp-card__meta">
        <span className={`bgp-family bgp-family--${peer.addressFamily.toLowerCase()}`}>
          {familyLabel(peer.addressFamily)}
        </span>
        <span className="bgp-card__asn">ASN {peer.remoteAs ?? '—'}</span>
        {/* Estado técnico do BGP fica ao lado, sem competir com o DOWN. */}
        {!peer.established && peer.state !== 'UNKNOWN' ? (
          <span className="bgp-card__state-tech">{peer.state}</span>
        ) : null}
        {roleLabel(peer.role) ? <span className="bgp-role">{roleLabel(peer.role)}</span> : null}
        {peer.adminState === 'IGNORED' ? (
          <span className="bgp-admin bgp-admin--ignored">IGNORADO</span>
        ) : null}
      </span>

      <span className="bgp-card__metrics">
        <span className="bgp-card__metric">
          <em>Rotas</em>
          <strong>{formatRouteCount(peer.receivedPrefixes)}</strong>
        </span>
        {peer.interface ? (
          <>
            <span className="bgp-card__metric bgp-card__metric--rx">
              <em>↓ RX</em>
              <strong>{formatBgpTraffic(peer.interface.rxBps)}</strong>
            </span>
            <span className="bgp-card__metric bgp-card__metric--tx">
              <em>↑ TX</em>
              <strong>{formatBgpTraffic(peer.interface.txBps)}</strong>
            </span>
          </>
        ) : (
          <span className="bgp-card__metric bgp-card__metric--empty">
            <em>RX/TX</em>
            <strong>—</strong>
          </span>
        )}
      </span>

      <span className="bgp-card__footer">
        {peer.established ? (
          <span className="bgp-card__uptime">UP há {uptime}</span>
        ) : downFor ? (
          <span className="bgp-card__uptime is-down">DOWN {downFor}</span>
        ) : (
          <span className="bgp-card__uptime is-down">DOWN</span>
        )}
        {flaps > 0 ? (
          <span className={`bgp-card__flaps${flaps > 1 ? ' is-many' : ''}`}>
            {flaps} queda{flaps > 1 ? 's' : ''} / 48h
          </span>
        ) : null}
        <ChevronRight className="bgp-card__chevron" size={16} aria-hidden="true" />
      </span>
    </button>
  );
}

export function BgpPeerTable({
  devices,
  onSelectPeer,
  onRefreshDevice,
  refreshingDeviceIds,
  emptyMessage,
  flapsByPeer,
  downSinceByPeer,
  now,
}: {
  devices: BgpDashboardDevice[];
  onSelectPeer: (peer: BgpDashboardPeer) => void;
  onRefreshDevice?: (deviceId: string) => void;
  refreshingDeviceIds?: ReadonlySet<string>;
  emptyMessage?: string;
  /** Quedas observadas por peer nas últimas 48h (alertas ativos + resolvidos). */
  flapsByPeer?: Map<string, number>;
  /** Início da indisponibilidade atual, quando há alerta ativo. */
  downSinceByPeer?: Map<string, string>;
  now?: number;
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
            {SORTABLE_COLUMNS.slice(0, 1).map((column) => (
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
            <th>Família</th>
            {SORTABLE_COLUMNS.slice(1).map((column) => (
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
            <th>Quedas · 48h</th>
          </tr>
        </thead>
      </table>
      {devices.map((device) => (
        <section key={device.id} className="bgp-device">
          <header className="bgp-device__header">
            <span
              className={`host-status host-status--${device.bgpMonitoringEnabled ? 'up' : 'warning'}`}
            />
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
                    {peer.adminState === 'IGNORED' && (
                      <small className="bgp-admin bgp-admin--ignored">ADMIN: IGNORADO</small>
                    )}
                  </td>
                  <td data-label="Família">
                    <span className={`bgp-family bgp-family--${peer.addressFamily.toLowerCase()}`}>
                      {familyLabel(peer.addressFamily)}
                    </span>
                  </td>
                  <td data-label="Peer">
                    <strong>{peer.displayName}</strong>
                    <small>{peer.peerAddress}</small>
                    {isDdosMitigationUiEnabled() && peer.mitigationExcluded ? (
                      <span
                        className="mitigation-excluded-badge"
                        title="Excluído da mitigação (nunca mitigar este peer)"
                      >
                        🛡 Excluído da mitigação
                      </span>
                    ) : null}
                  </td>
                  <td data-label="ASN">
                    <span>{peer.remoteAs ?? '-'}</span>
                    {roleLabel(peer.role) && (
                      <small className="bgp-role">{roleLabel(peer.role)}</small>
                    )}
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
                  <td data-label="Quedas · 48h">
                    <FlapCell
                      flaps={flapsByPeer?.get(peer.id) ?? 0}
                      downSince={downSinceByPeer?.get(peer.id) ?? null}
                      now={now}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/*
            Celular: a lista de cards substitui as duas tabelas (cabeçalho de
            ordenação e linhas). Continua dentro da seção do equipamento, então
            o agrupamento peer -> equipamento é o mesmo do desktop.
          */}
          <ul
            className="bgp-cards"
            aria-label={`Peers BGP de ${device.displayName || device.hostname}`}
          >
            {sortBgpPeers(device.peers, sort).map((peer) => (
              <li key={peer.id}>
                <BgpPeerCard
                  peer={peer}
                  flaps={flapsByPeer?.get(peer.id) ?? 0}
                  downSince={downSinceByPeer?.get(peer.id) ?? null}
                  now={now}
                  onSelect={onSelectPeer}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
