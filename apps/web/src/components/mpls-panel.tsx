'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@gmj/ui';
import { AlertTriangle, ChevronDown, ChevronUp, Clock3, Network, Search } from 'lucide-react';
import {
  formatDuration,
  type MplsHostOverview,
  type MplsPw,
  type MplsStateEvent,
  type MplsStatus,
} from '@gmj/shared';
import { useQuery } from '@tanstack/react-query';
import { getHostMpls, getHostMplsEvents } from '@/lib/api';

type Filter = 'ALL' | 'UP' | 'DOWN' | 'DEGRADED';

function tokenFromPublicPath(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/view\/(?:map|noc)\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function dateLabel(value: string | null): string {
  if (!value) return 'N/D';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'N/D' : date.toLocaleString('pt-BR');
}

function elapsedSince(value: string): string | null {
  const date = new Date(value);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? formatDuration(seconds) : null;
}

function pwDuration(pw: MplsPw, events: MplsStateEvent[]): string {
  if (pw.status === 'UP') {
    if (pw.upStartTime) {
      const elapsed = elapsedSince(pw.upStartTime);
      if (elapsed) return `UP há ${elapsed}`;
    }
    return 'UP há N/D';
  }
  if (pw.status === 'DOWN' || pw.status === 'PLUG_OUT') {
    const event = events.find(
      (item) =>
        item.entityType === 'PW' && item.entityId === pw.id && item.currentStatus === pw.status,
    );
    if (event) {
      const elapsed = elapsedSince(event.occurredAt);
      if (elapsed) return `DOWN há ${elapsed}`;
    }
    return 'DOWN há N/D';
  }
  return 'Duração N/D';
}

function filterMatches(status: MplsStatus, filter: Filter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'DOWN') return status === 'DOWN' || status === 'ADMIN_DOWN';
  return status === filter;
}

export function MplsPanel({ hostId, readOnly }: { hostId: string; readOnly: boolean }) {
  const publicToken = readOnly ? tokenFromPublicPath() : null;
  const overview = useQuery({
    queryKey: ['host-mpls', hostId, publicToken],
    queryFn: () => getHostMpls(hostId, publicToken),
    staleTime: 30_000,
  });
  const events = useQuery({
    queryKey: ['host-mpls-events', hostId, publicToken],
    queryFn: () => getHostMplsEvents(hostId, 100, publicToken),
    staleTime: 30_000,
    enabled: overview.data?.supported === true,
  });

  if (overview.isPending) {
    return <section className="drawer-section mpls-empty">Consultando dados MPLS…</section>;
  }
  if (overview.isError) {
    return (
      <section className="drawer-section mpls-empty">
        <AlertTriangle size={18} /> Não foi possível carregar MPLS com segurança.
      </section>
    );
  }
  if (!overview.data.supported) {
    return (
      <section className="drawer-section mpls-empty">
        <Network size={20} />
        <strong>MPLS não disponível</strong>
        <span>
          {overview.data.lastErrorSafe ??
            'Nenhuma entrada VSI válida foi encontrada na HUAWEI-VPLS-EXT-MIB.'}
        </span>
        <small>Última tentativa: {dateLabel(overview.data.lastPollingAt)}</small>
      </section>
    );
  }
  return <MplsContent overview={overview.data} events={events.data ?? []} />;
}

export function MplsContent({
  overview,
  events,
}: {
  overview: MplsHostOverview;
  events: MplsStateEvent[];
}) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR');
  const vsis = useMemo(
    () =>
      overview.vsis.filter((vsi) => {
        if (!filterMatches(vsi.status, filter)) return false;
        if (!normalizedSearch) return true;
        const searchable = [
          vsi.name,
          ...vsi.pws.flatMap((pw) => [
            pw.remoteIp,
            pw.remoteHost?.name ?? '',
            pw.remoteHost?.hostname ?? '',
          ]),
        ]
          .join(' ')
          .toLocaleLowerCase('pt-BR');
        return searchable.includes(normalizedSearch);
      }),
    [overview.vsis, filter, normalizedSearch],
  );

  const toggleCollapsed = (vsiName: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(vsiName)) next.delete(vsiName);
      else next.add(vsiName);
      return next;
    });
  };

  return (
    <div className="mpls-panel">
      <section className="drawer-section">
        <div className="mpls-title">
          <span>
            <Network size={15} /> MPLS
          </span>
          <small>
            <Clock3 size={12} /> {dateLabel(overview.lastPollingAt)}
          </small>
        </div>
        <div className="mpls-summary">
          <div>
            <strong>{overview.summary.vsiTotal}</strong>
            <span>Serviços / VSI</span>
          </div>
          <div className="up">
            <strong>{overview.summary.vsiUp}</strong>
            <span>UP</span>
          </div>
          <div className="down">
            <strong>{overview.summary.vsiDown + overview.summary.vsiAdminDown}</strong>
            <span>DOWN</span>
          </div>
          <div className="warning">
            <strong>{overview.summary.vsiDegraded}</strong>
            <span>Degradado</span>
          </div>
        </div>
        <div className="mpls-pw-summary">
          <span>Pseudowires</span>
          <strong>
            {overview.summary.pwUp} / {overview.summary.pwTotal} UP
          </strong>
        </div>
      </section>

      <section className="drawer-section mpls-controls">
        <div className="mpls-filters" aria-label="Filtros MPLS">
          {(['ALL', 'UP', 'DOWN', 'DEGRADED'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : ''}
              onClick={() => setFilter(value)}
            >
              {value === 'ALL' ? 'Todos' : value === 'DEGRADED' ? 'Degradado' : value}
            </button>
          ))}
        </div>
        <label className="mpls-search">
          <Search size={13} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar VSI, peer ou equipamento"
          />
        </label>
      </section>

      <section className="mpls-vsi-list">
        {vsis.map((vsi) => {
          const isCollapsed = collapsed.has(vsi.name) && vsi.pws.length > 3;
          const visiblePws = isCollapsed ? vsi.pws.slice(0, 3) : vsi.pws;
          const up = vsi.pws.filter((pw) => pw.status === 'UP').length;
          return (
            <article key={vsi.id} className={`mpls-vsi-card status-${vsi.status.toLowerCase()}`}>
              <header>
                <div>
                  <strong>{vsi.name}</strong>
                  <span>VLAN {vsi.vlanId ?? 'N/D'}</span>
                </div>
                <Badge tone={vsi.status}>
                  {vsi.status === 'ADMIN_DOWN' ? 'ADMIN DOWN' : vsi.status}
                </Badge>
              </header>
              <div className="mpls-vsi-card__count">
                <span>PWs</span>
                <strong>
                  {up}/{vsi.pws.length} UP
                </strong>
              </div>
              <h4>Pontos remotos</h4>
              <div className="mpls-peer-list">
                {visiblePws.map((pw) => (
                  <div key={pw.id} className={`mpls-peer status-${pw.status.toLowerCase()}`}>
                    <span className="port-dot" />
                    <div>
                      <strong>{pw.remoteHost?.name ?? pw.remoteIp}</strong>
                      <small>{pw.remoteHost ? pw.remoteIp : 'Equipamento não identificado'}</small>
                    </div>
                    <div>
                      <strong>PW {pw.pwId}</strong>
                      <small>{pwDuration(pw, events)}</small>
                    </div>
                    <Badge tone={pw.status}>
                      {pw.status === 'PLUG_OUT' ? 'PLUG OUT' : pw.status}
                    </Badge>
                  </div>
                ))}
              </div>
              {vsi.pws.length > 3 && (
                <button
                  type="button"
                  className="mpls-expand"
                  onClick={() => toggleCollapsed(vsi.name)}
                >
                  {isCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                  {isCollapsed ? `Mostrar todos (${vsi.pws.length})` : 'Recolher peers'}
                </button>
              )}
              <details className="mpls-technical">
                <summary>Detalhes técnicos</summary>
                <div className="info-grid">
                  <Technical label="RD" value={vsi.rd} />
                  <Technical label="VSI ID" value={vsi.vsiId} />
                  <Technical label="MTU" value={vsi.mtu} />
                  <Technical label="VC Type" value={vsi.vcType} />
                  <Technical label="Sinalização" value={vsi.signalingType} />
                  <Technical label="Tunnel Policy" value={vsi.tunnelPolicy} />
                  <Technical
                    label="Admin / Oper"
                    value={`${vsi.adminStatus} / ${vsi.operationalStatus}`}
                  />
                  <Technical label="Fonte" value={vsi.source} />
                  <Technical label="Atualizado" value={dateLabel(vsi.lastSeenAt)} />
                </div>
                {vsi.pws.map((pw) => (
                  <div key={pw.id} className="mpls-pw-technical">
                    <strong>
                      PW {pw.pwId} · {pw.remoteIp}
                    </strong>
                    <div className="info-grid">
                      <Technical label="PW Type" value={pw.pwType} />
                      <Technical label="Inbound Label" value={pw.inboundLabel} />
                      <Technical label="Outbound Label" value={pw.outboundLabel} />
                      <Technical label="PW State" value={pw.state} />
                      <Technical label="Working State" value={pw.workingState} />
                      <Technical label="Up Start Time" value={dateLabel(pw.upStartTime)} />
                      <Technical label="Up Sum Time" value={pw.upSumTime} />
                      <Technical label="Tunnel Policy" value={pw.tunnelPolicy} />
                      <Technical label="Fonte" value={pw.source} />
                      <Technical label="Atualizado" value={dateLabel(pw.lastSeenAt)} />
                    </div>
                  </div>
                ))}
              </details>
            </article>
          );
        })}
        {!vsis.length && (
          <div className="mpls-no-results">Nenhuma VSI corresponde aos filtros.</div>
        )}
      </section>
    </div>
  );
}

function Technical({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong className="mono">{value === null || value === '' ? 'N/D' : String(value)}</strong>
    </div>
  );
}
