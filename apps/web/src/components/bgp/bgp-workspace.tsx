'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BgpAlertDto,
  BgpDashboardPeer,
  BgpHistoryPeriod,
  BgpScope,
  BgpStateFilter,
} from '@gmj/shared';
import { RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '@gmj/ui';
import { discoverBgp, getBgpDashboard, getBgpPeer, getHosts, pollHost } from '@/lib/api';
import { formatRelative } from '@/lib/bgp-format';
import { BgpAlertsPanel } from './bgp-alerts-panel';
import { BgpFilters } from './bgp-filters';
import { BgpManageDevices } from './bgp-manage-devices';
import { BgpPeerDetail } from './bgp-peer-detail';
import { BgpPeerTable } from './bgp-peer-table';
import { BgpSummary } from './bgp-summary';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function BgpWorkspace() {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<BgpScope>('monitored');
  const [state, setState] = useState<BgpStateFilter>('all');
  const [period, setPeriod] = useState<BgpHistoryPeriod>('1h');
  const [search, setSearch] = useState('');
  const [selectedPeer, setSelectedPeer] = useState<BgpDashboardPeer | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [refreshingDeviceIds, setRefreshingDeviceIds] = useState<ReadonlySet<string>>(new Set());
  const [globalProgress, setGlobalProgress] = useState<{ current: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const deferredSearch = useDeferredValue(search);
  const now = useNow(1_000);

  const dashboard = useQuery({
    queryKey: ['bgp', scope, state, deferredSearch],
    queryFn: () =>
      getBgpDashboard({
        scope,
        state,
        ...(deferredSearch.trim() ? { q: deferredSearch.trim() } : {}),
      }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const hosts = useQuery({
    queryKey: ['hosts'],
    queryFn: () => getHosts(),
    enabled: scope === 'monitored',
  });

  const allPeers = useMemo(
    () => dashboard.data?.devices.flatMap((device) => device.peers) ?? [],
    [dashboard.data],
  );

  const monitoredWithoutPeers = useMemo(() => {
    if (scope !== 'monitored' || !hosts.data || !dashboard.data) return [];
    const deviceIds = new Set(dashboard.data.devices.map((device) => device.id));
    return hosts.data.filter((host) => host.bgpMonitoringEnabled && !deviceIds.has(host.id));
  }, [scope, hosts.data, dashboard.data]);

  async function refreshDeviceCore(deviceId: string): Promise<{ sshFailed: boolean }> {
    setRefreshingDeviceIds((current) => new Set(current).add(deviceId));
    let sshFailed = false;
    try {
      try {
        await discoverBgp(deviceId);
      } catch {
        sshFailed = true;
      }
      try {
        await pollHost(deviceId);
      } catch (error) {
        setNotice(
          `Falha no polling SNMP de ${deviceId}: ${
            error instanceof Error ? error.message : 'erro desconhecido'
          }`,
        );
      }
    } finally {
      setRefreshingDeviceIds((current) => {
        const next = new Set(current);
        next.delete(deviceId);
        return next;
      });
    }
    if (sshFailed) setNotice('Discovery SSH falhou; estado e rotas atualizados por SNMP.');
    await queryClient.invalidateQueries({ queryKey: ['bgp'] });
    await queryClient.invalidateQueries({ queryKey: ['bgp-alerts'] });
    await queryClient.invalidateQueries({ queryKey: ['hosts'] });
    return { sshFailed };
  }

  async function refreshDevice(deviceId: string): Promise<void> {
    if (inFlight.current.has(deviceId)) return;
    inFlight.current.add(deviceId);
    try {
      await refreshDeviceCore(deviceId);
    } finally {
      inFlight.current.delete(deviceId);
    }
  }

  async function refreshMonitored(): Promise<void> {
    const targets = (dashboard.data?.devices ?? [])
      .filter((device) => device.bgpMonitoringEnabled)
      .map((device) => device.id);
    if (!targets.length) return;
    setGlobalProgress({ current: 0, total: targets.length });
    const concurrency = 2;
    for (let index = 0; index < targets.length; index += concurrency) {
      const batch = targets.slice(index, index + concurrency);
      await Promise.all(batch.map((deviceId) => refreshDeviceCore(deviceId)));
      setGlobalProgress({
        current: Math.min(index + concurrency, targets.length),
        total: targets.length,
      });
    }
    setGlobalProgress(null);
  }

  function handleAlertClick(alert: BgpAlertDto): void {
    const existing = allPeers.find((peer) => peer.id === alert.peerId);
    if (existing) {
      setSelectedPeer(existing);
      return;
    }
    void getBgpPeer(alert.peerId).then((peer) => {
      if (peer) setSelectedPeer(peer);
    });
  }

  const hasFilters = Boolean(search.trim()) || state !== 'all';
  const devices = dashboard.data?.devices ?? [];
  const emptyMessage = hasFilters
    ? 'Nenhum peer corresponde aos filtros selecionados.'
    : scope === 'monitored' && monitoredWithoutPeers.length > 0
      ? 'Aguardando primeira coleta BGP dos equipamentos monitorados.'
      : 'Nenhum peer BGP descoberto.';

  const lastUpdatedAt = dashboard.dataUpdatedAt;

  return (
    <main className="hosts-shell bgp-shell">
      <div className="hosts-header">
        <div>
          <span>VISÃO OPERACIONAL DE BORDA</span>
          <h1>BGP</h1>
          <p>
            Monitoramento de sessões BGP por equipamento ·{' '}
            {lastUpdatedAt ? formatRelative(now - lastUpdatedAt) : '—'}
          </p>
        </div>
        <div className="hosts-header__actions">
          {globalProgress ? (
            <span className="bgp-progress">
              Atualizando {globalProgress.current}/{globalProgress.total}...
            </span>
          ) : null}
          <Button
            compact
            variant="secondary"
            disabled={Boolean(globalProgress)}
            onClick={() => void refreshMonitored()}
          >
            <RefreshCw size={15} className={globalProgress ? 'spin' : ''} /> Atualizar monitorados
          </Button>
          <Button compact variant="secondary" onClick={() => setManageOpen(true)}>
            <Settings2 size={15} /> Gerenciar equipamentos
          </Button>
        </div>
      </div>

      <BgpFilters
        scope={scope}
        state={state}
        period={period}
        search={search}
        onScopeChange={setScope}
        onStateChange={setState}
        onPeriodChange={setPeriod}
        onSearchChange={setSearch}
      />

      {notice && (
        <div className="bgp-notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label="Fechar">
            ×
          </button>
        </div>
      )}

      <div className="bgp-layout">
        <div className="bgp-main">
          <BgpSummary
            summary={
              dashboard.data?.summary ?? {
                peers: 0,
                established: 0,
                down: 0,
                receivedPrefixes: 0,
              }
            }
          />

          {dashboard.isLoading ? (
            <div className="hosts-table-wrap">
              <div className="hosts-empty">
                <span>Carregando dados BGP...</span>
              </div>
            </div>
          ) : dashboard.isError ? (
            <div className="hosts-table-wrap">
              <div className="hosts-empty">
                <span>Falha ao carregar monitoramento BGP</span>
                <Button compact variant="secondary" onClick={() => void dashboard.refetch()}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          ) : (
            <>
              {scope === 'monitored' && monitoredWithoutPeers.length > 0 && (
                <section className="bgp-onboarding">
                  <header className="bgp-onboarding__title">
                    <span>Aguardando primeira coleta</span>
                  </header>
                  {monitoredWithoutPeers.map((host) => (
                    <div key={host.id} className="bgp-onboarding__row">
                      <div>
                        <strong>{host.displayName || host.hostname}</strong>
                        <small>{host.hostname}</small>
                      </div>
                      <span>Monitoramento BGP habilitado. Aguardando primeira coleta.</span>
                      <Button
                        compact
                        variant="secondary"
                        disabled={refreshingDeviceIds.has(host.id)}
                        onClick={() => void refreshDevice(host.id)}
                      >
                        <RefreshCw
                          size={13}
                          className={refreshingDeviceIds.has(host.id) ? 'spin' : ''}
                        />
                        Atualizar agora
                      </Button>
                    </div>
                  ))}
                </section>
              )}
              <BgpPeerTable
                devices={devices}
                onSelectPeer={setSelectedPeer}
                onRefreshDevice={(deviceId) => void refreshDevice(deviceId)}
                refreshingDeviceIds={refreshingDeviceIds}
                emptyMessage={emptyMessage}
              />
            </>
          )}
        </div>

        <BgpAlertsPanel scope={scope} onSelectAlert={handleAlertClick} />
      </div>

      {selectedPeer && (
        <BgpPeerDetail
          peer={selectedPeer}
          period={period}
          onClose={() => setSelectedPeer(null)}
        />
      )}
      {manageOpen && <BgpManageDevices onClose={() => setManageOpen(false)} />}
    </main>
  );
}

