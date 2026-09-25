'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BgpAddressFamilyFilter,
  BgpAlertDto,
  BgpDashboardPeer,
  BgpHistoryPeriod,
  BgpScope,
  BgpStateFilter,
} from '@gmj/shared';
import { RefreshCw, Settings2 } from 'lucide-react';
import { Button, MetaFact, ModuleHeader } from '@gmj/ui';
import {
  discoverBgp,
  getBgpAlerts,
  getBgpDashboard,
  getBgpPeer,
  getHosts,
  pollHost,
} from '@/lib/api';
import { formatRelative } from '@/lib/bgp-format';
import { BgpAlertsPanel } from './bgp-alerts-panel';
import { BgpFilters } from './bgp-filters';
import { BgpManageDevices } from './bgp-manage-devices';
import { BgpPeerDetail } from './bgp-peer-detail';
import { BgpPeerTable } from './bgp-peer-table';
import { BgpSummary } from './bgp-summary';
import { useMapStore } from '@/store/map-store';

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
  const bgpDeviceFilter = useMapStore((state) => state.bgpDeviceFilter);
  const setBgpDeviceFilter = useMapStore((state) => state.setBgpDeviceFilter);
  const [scope, setScope] = useState<BgpScope>('monitored');
  const [state, setState] = useState<BgpStateFilter>('all');
  const [family, setFamily] = useState<BgpAddressFamilyFilter>('all');
  const [period, setPeriod] = useState<BgpHistoryPeriod>('1h');
  const [search, setSearch] = useState('');
  const [selectedPeer, setSelectedPeer] = useState<BgpDashboardPeer | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [refreshingDeviceIds, setRefreshingDeviceIds] = useState<ReadonlySet<string>>(new Set());
  const [globalProgress, setGlobalProgress] = useState<{ current: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Falha por equipamento (a última de cada um; nunca sobrescreve as outras). */
  const [refreshFailures, setRefreshFailures] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const deferredSearch = useDeferredValue(search);
  const now = useNow(1_000);

  const dashboard = useQuery({
    queryKey: ['bgp', scope, state, family, deferredSearch, bgpDeviceFilter],
    queryFn: () =>
      getBgpDashboard({
        scope,
        state,
        family,
        ...(deferredSearch.trim() ? { q: deferredSearch.trim() } : {}),
        ...(bgpDeviceFilter ? { deviceId: bgpDeviceFilter } : {}),
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

  // Mesma query do painel de alertas: react-query deduplica, então os dois
  // consomem exatamente o mesmo snapshot de 48h.
  const alerts = useQuery({
    queryKey: ['bgp-alerts', scope],
    queryFn: () => getBgpAlerts({ scope, hours: 48 }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  /** Quedas por peer em 48h: ativas + resolvidas realmente observadas. */
  const flapsByPeer = useMemo(() => {
    const counts = new Map<string, number>();
    const data = alerts.data;
    if (!data) return counts;
    for (const alert of [...data.active, ...data.resolved]) {
      counts.set(alert.peerId, (counts.get(alert.peerId) ?? 0) + 1);
    }
    return counts;
  }, [alerts.data]);

  /** Início da indisponibilidade atual por peer (alerta ativo). */
  const downSinceByPeer = useMemo(() => {
    const since = new Map<string, string>();
    for (const alert of alerts.data?.active ?? []) {
      if (alert.startedAt) since.set(alert.peerId, alert.startedAt);
    }
    return since;
  }, [alerts.data]);

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
    let snmpError: string | null = null;
    try {
      try {
        await discoverBgp(deviceId);
      } catch {
        sshFailed = true;
      }
      try {
        await pollHost(deviceId);
      } catch (error) {
        snmpError = error instanceof Error ? error.message : 'erro desconhecido';
      }
    } finally {
      setRefreshingDeviceIds((current) => {
        const next = new Set(current);
        next.delete(deviceId);
        return next;
      });
    }
    setRefreshFailures((current) => {
      const entity = hosts.data?.find((host) => host.id === deviceId);
      const label = entity?.displayName || entity?.hostname || deviceId;
      const next = { ...current };
      const reasons: string[] = [];
      if (snmpError) reasons.push(`polling SNMP: ${snmpError}`);
      if (sshFailed) {
        reasons.push('discovery SSH falhou; estado e rotas vieram do SNMP');
      }
      if (reasons.length) {
        next[label] = reasons.join(' · ');
      } else {
        delete next[label];
      }
      return next;
    });
    await queryClient.invalidateQueries({ queryKey: ['bgp'] });
    await queryClient.invalidateQueries({ queryKey: ['bgp-alerts'] });
    await queryClient.invalidateQueries({ queryKey: ['bgp-peer-history'] });
    await queryClient.invalidateQueries({ queryKey: ['hosts'] });
    return { sshFailed };
  }

  /**
   * Requirement: after an administrative action the view is rebuilt from the
   * device (SNMP polling + SSH discovery) and every BGP cache is invalidated.
   */
  async function refreshPeerAfterAction(peerId: string, deviceId: string): Promise<void> {
    await refreshDeviceCore(deviceId);
    await queryClient.invalidateQueries({ queryKey: ['bgp-peer-history', peerId] });
    const updated = await getBgpPeer(peerId);
    if (updated) setSelectedPeer(updated);
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

  const hasFilters = Boolean(search.trim()) || state !== 'all' || family !== 'all';
  const devices = dashboard.data?.devices ?? [];
  const emptyMessage = hasFilters
    ? 'Nenhum peer corresponde aos filtros selecionados.'
    : scope === 'monitored' && monitoredWithoutPeers.length > 0
      ? 'Aguardando primeira coleta BGP dos equipamentos monitorados.'
      : 'Nenhum peer BGP descoberto.';

  const lastUpdatedAt = dashboard.dataUpdatedAt;

  return (
    <main className="hosts-shell bgp-shell">
      <ModuleHeader
        variant="inline"
        eyebrow="VISÃO OPERACIONAL DE BORDA"
        title="BGP"
        subtitle="Monitoramento de sessões BGP por equipamento."
        meta={
          <>
            <MetaFact
              label="peers"
              value={dashboard.data?.summary.peers ?? 0}
            />
            <MetaFact
              label="established"
              value={dashboard.data?.summary.established ?? 0}
              tone="up"
            />
            <MetaFact
              label="down"
              value={dashboard.data?.summary.down ?? 0}
              tone="down"
            />
            <MetaFact
              label="última coleta"
              value={lastUpdatedAt ? formatRelative(now - lastUpdatedAt) : 'sem coleta'}
              tone="info"
            />
          </>
        }
        actions={
          <>
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
          </>
        }
      />

      <BgpFilters
        scope={scope}
        state={state}
        family={family}
        period={period}
        search={search}
        onScopeChange={setScope}
        onStateChange={setState}
        onFamilyChange={setFamily}
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

      {Object.keys(refreshFailures).length > 0 && (
        <div className="bgp-notice bgp-notice--warning" role="status">
          <span className="bgp-notice__title">Falhas na última atualização</span>
          <ul className="bgp-notice__list">
            {Object.entries(refreshFailures).map(([label, message]) => (
              <li key={label}>
                <strong>{label}</strong>
                <span>{message}</span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setRefreshFailures({})}>
            Limpar
          </button>
        </div>
      )}

      {bgpDeviceFilter && (
        <div className="bgp-notice" role="status">
          Mostrando apenas o equipamento selecionado no inventário.
          <button type="button" onClick={() => setBgpDeviceFilter(null)}>
            Limpar filtro
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
                byFamily: { IPV4: 0, IPV6: 0 },
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
                flapsByPeer={flapsByPeer}
                downSinceByPeer={downSinceByPeer}
                now={now}
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
          onRefreshed={refreshPeerAfterAction}
        />
      )}
      {manageOpen && <BgpManageDevices onClose={() => setManageOpen(false)} />}
    </main>
  );
}

