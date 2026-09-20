'use client';

import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BgpDashboardPeer, BgpHistoryPeriod, BgpScope, BgpStateFilter } from '@gmj/shared';
import { Settings2 } from 'lucide-react';
import { Button } from '@gmj/ui';
import { getBgpDashboard } from '@/lib/api';
import { BgpFilters } from './bgp-filters';
import { BgpManageDevices } from './bgp-manage-devices';
import { BgpPeerDetail } from './bgp-peer-detail';
import { BgpPeerTable } from './bgp-peer-table';
import { BgpSummary } from './bgp-summary';

export function BgpWorkspace() {
  const [scope, setScope] = useState<BgpScope>('monitored');
  const [state, setState] = useState<BgpStateFilter>('all');
  const [period, setPeriod] = useState<BgpHistoryPeriod>('1h');
  const [search, setSearch] = useState('');
  const [selectedPeer, setSelectedPeer] = useState<BgpDashboardPeer | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const dashboard = useQuery({
    queryKey: ['bgp', scope, state, deferredSearch],
    queryFn: () =>
      getBgpDashboard({
        scope,
        state,
        ...(deferredSearch.trim() ? { q: deferredSearch.trim() } : {}),
      }),
  });

  return (
    <main className="hosts-shell bgp-shell">
      <div className="hosts-header">
        <div>
          <span>VISÃO OPERACIONAL DE BORDA</span>
          <h1>BGP</h1>
          <p>Monitoramento de sessões BGP por equipamento, agrupado por device.</p>
        </div>
        <div className="hosts-header__actions">
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

      <div className="bgp-content">
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
        <BgpPeerTable devices={dashboard.data?.devices ?? []} onSelectPeer={setSelectedPeer} />
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
