'use client';

import { useQuery } from '@tanstack/react-query';
import type { BgpDashboardPeer, BgpHistoryPeriod, MetricPoint } from '@gmj/shared';
import { formatBitsPerSecond } from '@gmj/shared';
import { X } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getBgpPeerHistory, getHistory } from '@/lib/api';
import { formatBgpTraffic, formatBgpUptime, formatRouteCount } from '@/lib/bgp-format';
import { BgpRouteSparkline } from './bgp-route-sparkline';

function timeLabel(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR') : '-';
}

export function BgpPeerDetail({
  peer,
  period,
  onClose,
}: {
  peer: BgpDashboardPeer;
  period: BgpHistoryPeriod;
  onClose: () => void;
}) {
  const history = useQuery({
    queryKey: ['bgp-peer-history', peer.id, period],
    queryFn: () => getBgpPeerHistory(peer.id, period),
  });
  const ifaceId = peer.interface?.id ?? null;
  const traffic = useQuery({
    queryKey: ['history', ifaceId, period],
    queryFn: () => getHistory(ifaceId as string, period),
    enabled: Boolean(ifaceId),
  });

  const routeData = (history.data?.samples ?? []).map((sample) => ({
    label: timeLabel(sample.timestamp),
    value: sample.receivedPrefixes,
  }));
  const trafficData = (traffic.data ?? []).map((point: MetricPoint) => ({
    label: timeLabel(point.timestamp),
    rx: point.rxBps,
    tx: point.txBps,
  }));

  return (
    <div className="panel-overlay" role="dialog" aria-modal="true" aria-label="Detalhes do peer BGP">
      <div className="action-panel bgp-detail">
        <header>
          <div>
            <span>PEER BGP</span>
            <h2>{peer.displayName}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </header>
        <div className="panel-body bgp-detail__body">
          <section className="bgp-detail__hero">
            <div>
              <span>PEER</span>
              <strong>{peer.peerAddress}</strong>
            </div>
            <div>
              <span>ASN</span>
              <strong>{peer.remoteAs ?? '-'}</strong>
            </div>
            <div>
              <span>ESTADO</span>
              <strong className={peer.established ? 'is-up' : 'is-down'}>
                {peer.established ? 'ESTABLISHED' : peer.state}
              </strong>
            </div>
            <div>
              <span>ROTAS</span>
              <strong>{formatRouteCount(peer.receivedPrefixes)}</strong>
            </div>
            <div>
              <span>UPTIME</span>
              <strong>{formatBgpUptime(peer.establishedSince)}</strong>
            </div>
          </section>

          <section className="bgp-detail__grid">
            <div className="bgp-detail__facts">
              <dl>
                <div>
                  <dt>Equipamento</dt>
                  <dd>{peer.deviceDisplayName || peer.deviceHostname}</dd>
                </div>
                <div>
                  <dt>Hostname</dt>
                  <dd>{peer.deviceHostname}</dd>
                </div>
                <div>
                  <dt>Interface</dt>
                  <dd>{peer.interface ? `${peer.interface.name ?? '-'} (${peer.interface.id})` : '-'}</dd>
                </div>
                <div>
                  <dt>Alias / Descrição</dt>
                  <dd>{peer.interface?.alias || peer.interface?.description || '-'}</dd>
                </div>
                <div>
                  <dt>Tráfego da interface</dt>
                  <dd>
                    RX {formatBgpTraffic(peer.interface?.rxBps)} · TX{' '}
                    {formatBgpTraffic(peer.interface?.txBps)}
                  </dd>
                </div>
                <div>
                  <dt>Último polling</dt>
                  <dd>{dateText(peer.lastPollingAt)}</dd>
                </div>
                <div>
                  <dt>Último discovery</dt>
                  <dd>{dateText(peer.lastDiscoveryAt)}</dd>
                </div>
              </dl>
            </div>

            <div className="bgp-detail__sparkline">
              <span>ROTAS RECEBIDAS · {period}</span>
              <BgpRouteSparkline
                height={44}
                samples={(history.data?.samples ?? []).map((sample) => sample.receivedPrefixes)}
              />
            </div>
          </section>

          <section className="bgp-detail__chart">
            <div className="chart-heading">
              <div>
                <span>HISTÓRICO</span>
                <strong>Rotas recebidas</strong>
              </div>
            </div>
            {routeData.length ? (
              <ResponsiveContainer width="100%" height={170}>
                <LineChart data={routeData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="#1d2c34" strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fill: '#5e747e', fontSize: 9 }} tickLine={false} />
                  <YAxis
                    tick={{ fill: '#5e747e', fontSize: 9 }}
                    tickLine={false}
                    domain={['auto', 'auto']}
                    width={54}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#101920',
                      border: '1px solid #304650',
                      fontSize: 10,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name="Rotas"
                    stroke="#65cce7"
                    strokeWidth={1.4}
                    dot={false}
                    isAnimationActive={false}
                  />
                  {(history.data?.events ?? []).map((event) => (
                    <ReferenceLine
                      key={`${event.occurredAt}-${event.currentStateCode}`}
                      x={timeLabel(event.occurredAt)}
                      stroke="#d25e61"
                      strokeDasharray="3 3"
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="bgp-detail__empty">Sem amostras no período selecionado.</p>
            )}
            {(history.data?.events ?? []).length > 0 && (
              <div className="bgp-detail__events">
                <span>EVENTOS</span>
                {history.data!.events.map((event, index) => (
                  <em key={index}>
                    {event.previousState} → {event.currentState} ·{' '}
                    {new Date(event.occurredAt).toLocaleString('pt-BR')}
                  </em>
                ))}
              </div>
            )}
          </section>

          <section className="bgp-detail__chart">
            <div className="chart-heading">
              <div>
                <span>TRÁFEGO DA INTERFACE</span>
                <strong>{peer.interface ? `${peer.interface.name ?? 'Interface'} · RX/TX` : 'Sem interface associada'}</strong>
              </div>
            </div>
            {peer.interface && trafficData.length ? (
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={trafficData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="#1d2c34" strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fill: '#5e747e', fontSize: 9 }} tickLine={false} />
                  <YAxis tick={{ fill: '#5e747e', fontSize: 9 }} tickLine={false} width={54} />
                  <Tooltip
                    formatter={(value) =>
                      formatBitsPerSecond(typeof value === 'number' ? value : 0)
                    }
                    contentStyle={{
                      background: '#101920',
                      border: '1px solid #304650',
                      fontSize: 10,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="rx"
                    name="RX"
                    stroke="#43c59e"
                    strokeWidth={1.4}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="tx"
                    name="TX"
                    stroke="#d9a24b"
                    strokeWidth={1.4}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="bgp-detail__empty">
                {peer.interface ? 'Sem métricas de tráfego no período.' : 'Nenhuma interface associada a este peer.'}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
