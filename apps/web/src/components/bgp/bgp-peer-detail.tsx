'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BgpAdminAction,
  BgpDashboardPeer,
  BgpHistoryPeriod,
  BgpPeerAdminStateResponse,
  MetricPoint,
} from '@gmj/shared';
import { formatBitsPerSecond } from '@gmj/shared';
import { RefreshCw, ShieldAlert, X } from 'lucide-react';
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
import { getBgpPeerHistory, getHistory, setBgpPeerAdminState } from '@/lib/api';
import { formatBgpTraffic, formatBgpUptime, formatRouteCount } from '@/lib/bgp-format';
import { BgpRouteSparkline } from './bgp-route-sparkline';
import { useMapStore } from '@/store/map-store';

function timeLabel(value: string): string {
  const date = new Date(value);
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleString('pt-BR') : '-';
}

function familyLabel(peer: BgpDashboardPeer): string {
  return peer.addressFamily === 'IPV6' ? 'IPv6' : 'IPv4';
}

function adminLabel(peer: BgpDashboardPeer): string {
  if (peer.adminState === 'IGNORED') return 'IGNORADO';
  if (peer.adminState === 'ENABLED') return 'Habilitado';
  return 'Não verificado';
}

export function BgpPeerDetail({
  peer,
  period,
  onClose,
  onRefreshed,
}: {
  peer: BgpDashboardPeer;
  period: BgpHistoryPeriod;
  onClose: () => void;
  /** Runs SSH discovery + SNMP polling and reloads this peer after an action. */
  onRefreshed?: (peerId: string, deviceId: string) => Promise<void> | void;
}) {
  const queryClient = useQueryClient();
  const openHostDetails = useMapStore((state) => state.openHostDetails);
  const openInterfaceInActiveMap = useMapStore((state) => state.openInterfaceInActiveMap);
  /**
   * Só oferecemos "abrir no mapa" quando o equipamento realmente está no mapa
   * ativo — nada de escolher um mapa por nós.
   */
  const activeMapHasDevice = useMapStore((state) =>
    Boolean(state.map?.devices.some((device) => device.id === peer.deviceId)),
  );
  const [pendingAction, setPendingAction] = useState<BgpAdminAction | null>(null);
  const [mapNavError, setMapNavError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionResult, setActionResult] = useState<BgpPeerAdminStateResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Synchronous guard: a double click must never trigger two operations. */
  const actionInFlight = useRef(false);
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

  const adminIgnored = peer.adminState === 'IGNORED';
  const localAsUnknown = !peer.localAs;

  async function refreshAfterAction(): Promise<void> {
    setRefreshing(true);
    try {
      await onRefreshed?.(peer.id, peer.deviceId);
      await queryClient.invalidateQueries({ queryKey: ['bgp-peer-history', peer.id] });
    } finally {
      setRefreshing(false);
    }
  }

  async function runAction(): Promise<void> {
    if (!pendingAction || actionInFlight.current) return;
    const action = pendingAction;
    actionInFlight.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await setBgpPeerAdminState(peer.id, action);
      setActionResult(result);
      if (!result.success) setActionError(result.message);
      setPendingAction(null);
      // The read-back runs in the backend; here the view is refreshed from the
      // device (SSH discovery + SNMP polling) instead of trusting the command.
      await refreshAfterAction();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Falha na ação administrativa');
      setPendingAction(null);
    } finally {
      actionInFlight.current = false;
      setActionBusy(false);
    }
  }

  async function refreshNow(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshed?.(peer.id, peer.deviceId);
    } finally {
      setRefreshing(false);
    }
  }

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
              <span>FAMÍLIA</span>
              <strong>{familyLabel(peer)}</strong>
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

          <section className="bgp-actions" aria-label="Ações operacionais">
            <header className="bgp-actions__header">
              <span>AÇÕES OPERACIONAIS</span>
              {peer.adminState === 'IGNORED' && <em className="bgp-admin--ignored">ADMIN: IGNORADO</em>}
            </header>
            <dl className="bgp-actions__facts">
              <div>
                <dt>Família</dt>
                <dd>{familyLabel(peer)}</dd>
              </div>
              <div>
                <dt>ASN local</dt>
                <dd>{peer.localAs ?? 'não identificado'}</dd>
              </div>
              <div>
                <dt>ASN remoto</dt>
                <dd>{peer.remoteAs ?? '-'}</dd>
              </div>
              <div>
                <dt>Admin</dt>
                <dd>{adminLabel(peer)}</dd>
              </div>
            </dl>
            {localAsUnknown && (
              <p className="bgp-actions__warning" role="alert">
                ASN local do processo BGP ainda não foi identificado. Execute Atualizar agora para
                fazer o discovery SSH.
              </p>
            )}
            {peer.addressFamily === 'IPV6' && (
              <p className="bgp-actions__note">
                Sessões IPv6 não possuem fonte SNMP de estado validada neste equipamento: o estado e
                as rotas são atualizados pelo discovery SSH (Atualizar agora).
              </p>
            )}
            {actionError && (
              <p className="bgp-actions__error" role="alert">
                {actionError}
              </p>
            )}
            {actionResult && !actionError && (
              <p className="bgp-actions__result" role="status">
                {actionResult.message}
              </p>
            )}
            <div className="bgp-actions__buttons">
              <button
                type="button"
                className="bgp-actions__refresh"
                disabled={refreshing}
                onClick={() => void refreshNow()}
              >
                <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> Atualizar agora
              </button>
              {adminIgnored ? (
                <button
                  type="button"
                  className="bgp-actions__enable"
                  disabled={localAsUnknown || refreshing}
                  onClick={() => setPendingAction('ENABLE')}
                >
                  Reabilitar sessão BGP
                </button>
              ) : (
                <button
                  type="button"
                  className="bgp-actions__disable"
                  disabled={localAsUnknown || refreshing}
                  onClick={() => setPendingAction('DISABLE')}
                >
                  <ShieldAlert size={13} /> Desabilitar sessão BGP
                </button>
              )}
            </div>

            <div className="bgp-actions__nav">
              <button type="button" onClick={() => openHostDetails(peer.deviceId)}>
                Abrir host no inventário
              </button>
              <button
                type="button"
                disabled={!peer.interface?.id || !activeMapHasDevice}
                title={
                  !peer.interface?.id
                    ? 'Sem interface correlacionada (MATCHED) para este peer'
                    : !activeMapHasDevice
                      ? 'O equipamento deste peer não está no mapa ativo'
                      : 'Abrir a interface correlacionada no mapa ativo'
                }
                onClick={() => {
                  if (!peer.interface?.id) return;
                  const opened = openInterfaceInActiveMap(peer.deviceId, peer.interface.id);
                  setMapNavError(
                    opened ? null : 'O equipamento deste peer não está no mapa ativo.',
                  );
                }}
              >
                Abrir interface no mapa
              </button>
            </div>
            {!peer.interface?.id && (
              <p className="bgp-actions__note">
                A interface local deste peer ainda não foi correlacionada com confiança
                (<strong>MATCHED</strong>). Sem correlação confirmada não há como localizar o enlace.
              </p>
            )}
            {mapNavError && (
              <p className="bgp-actions__error" role="alert">
                {mapNavError}
              </p>
            )}
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
                      stroke={event.currentState === 'ESTABLISHED' ? '#43c59e' : '#d25e61'}
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

      {pendingAction && (
        <div
          className="panel-overlay bgp-confirm"
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar ação administrativa BGP"
        >
          <div className="action-panel bgp-confirm__panel">
            <header>
              <div>
                <span>CONFIRMAÇÃO OBRIGATÓRIA</span>
                <h2>
                  {pendingAction === 'DISABLE'
                    ? 'Desabilitar sessão BGP'
                    : 'Reabilitar sessão BGP'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                aria-label="Fechar"
                disabled={actionBusy}
              >
                <X size={16} />
              </button>
            </header>
            <div className="panel-body">
              <dl className="bgp-confirm__facts">
                <div>
                  <dt>Equipamento</dt>
                  <dd>{peer.deviceDisplayName || peer.deviceHostname}</dd>
                </div>
                <div>
                  <dt>Peer</dt>
                  <dd>{peer.displayName}</dd>
                </div>
                <div>
                  <dt>Endereço</dt>
                  <dd>{peer.peerAddress}</dd>
                </div>
                <div>
                  <dt>Família</dt>
                  <dd>{familyLabel(peer)}</dd>
                </div>
                <div>
                  <dt>ASN remoto</dt>
                  <dd>{peer.remoteAs ?? '-'}</dd>
                </div>
                <div>
                  <dt>ASN local</dt>
                  <dd>{peer.localAs ?? 'não identificado'}</dd>
                </div>
                <div>
                  <dt>Estado atual</dt>
                  <dd>{peer.established ? 'ESTABLISHED' : peer.state}</dd>
                </div>
              </dl>
              <p className="bgp-confirm__message">
                {pendingAction === 'DISABLE'
                  ? 'A sessão BGP será administrativamente ignorada e deixará de trocar rotas até ser reabilitada.'
                  : 'A sessão BGP voltará a ser negociada e poderá trocar rotas novamente.'}
              </p>
              <div className="bgp-confirm__buttons">
                <button
                  type="button"
                  className="bgp-confirm__cancel"
                  disabled={actionBusy}
                  onClick={() => setPendingAction(null)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="bgp-confirm__submit"
                  disabled={actionBusy}
                  onClick={() => void runAction()}
                >
                  {pendingAction === 'DISABLE'
                    ? 'Confirmar desativação'
                    : 'Confirmar reabilitação'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
