'use client';

import { useQuery } from '@tanstack/react-query';
import { MetaFact } from '@gmj/ui';
import { request } from '@/lib/api';

interface AutoAllReport {
  phases: { enforcementScope: string; physicalExecutionAuthorized: boolean; cadenceMs: number };
  lease: { enabled: boolean; acquired: boolean; lost: boolean; holderBackendPid: number | null };
  clients: Array<{
    profileId: string;
    interfaceId: string | null;
    eligible: boolean;
    reasons: string[];
    direction: 'rx' | 'tx' | null;
    bandwidthBps: string | null;
    score: {
      progress: string;
      samplesOver: number;
      requiredSamples: number;
      outcome: string;
      reason: string | null;
      firstAbnormalAt: string | null;
      decisionMs: number | null;
    } | null;
  }>;
}
interface PollerReport {
  running: boolean;
  monitoredInterfaces: number;
  entries: Array<{
    interfaceId: string;
    profileIds: string[];
    quality: string;
    rxBps: number | null;
    txBps: number | null;
    contractedPercent: Record<string, number>;
  }>;
}
export interface AutoAllLiveData {
  all: AutoAllReport;
  poller: PollerReport;
}
const rate = (bps: number | null | undefined) =>
  bps == null ? '—' : `${(bps / 1e6).toFixed(1)} Mbps`;

/** Read-only diagnostics from the actual engine and collector, never inferred from UI actions. */
export function MitigationAutoAllFacts({
  data,
  names,
}: {
  data: AutoAllLiveData;
  names: Record<string, string>;
}) {
  const { all, poller } = data;
  if (all.phases.enforcementScope !== 'AUTO_ALL') return null;
  return (
    <section aria-label="AUTO-ALL ao vivo" data-testid="auto-all-live">
      <h3>AUTO-ALL · acompanhamento ao vivo</h3>
      <div className="mitigation-cards">
        <MetaFact label="clientes" value={all.clients.length} />
        <MetaFact label="elegíveis" value={all.clients.filter((c) => c.eligible).length} />
        <MetaFact label="interfaces monitoradas" value={poller.monitoredInterfaces} />
        <MetaFact
          label="lease"
          value={all.lease.lost ? 'PERDIDA' : all.lease.acquired ? 'ADQUIRIDA' : 'SEM POSSE'}
          tone={all.lease.acquired ? 'up' : 'warning'}
        />
        <MetaFact label="coletor" value={poller.running ? 'EM EXECUÇÃO' : 'PARADO'} />
        <MetaFact
          label="execução BGP física"
          value={all.phases.physicalExecutionAuthorized ? 'AUTORIZADA' : 'DESABILITADA'}
        />
      </div>
      <div className="mitigation-table-wrap">
        <table className="mitigation-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Elegibilidade</th>
              <th>Direção</th>
              <th>RX / TX</th>
              <th>Utilização</th>
              <th>Amostras</th>
              <th>Confirmação</th>
              <th>Primeira anormal</th>
              <th>Decisão</th>
            </tr>
          </thead>
          <tbody>
            {all.clients.map((c) => {
              const sample = poller.entries.find((e) => e.profileIds.includes(c.profileId));
              const confirmed = c.score != null && c.score.samplesOver >= c.score.requiredSamples;
              return (
                <tr key={c.profileId} data-profile-id={c.profileId}>
                  <td>{names[c.profileId] ?? c.profileId}</td>
                  <td>{c.eligible ? 'ELEGÍVEL' : c.reasons.join(', ')}</td>
                  <td>{c.direction?.toUpperCase() ?? '—'}</td>
                  <td>
                    RX {rate(sample?.rxBps)} / TX {rate(sample?.txBps)}
                  </td>
                  <td>
                    {sample?.contractedPercent[c.profileId] == null
                      ? '—'
                      : `${sample.contractedPercent[c.profileId]!.toFixed(1)}%`}
                  </td>
                  <td data-testid="auto-all-progress">{c.score?.progress ?? '—'}</td>
                  <td>
                    {confirmed ? 'DETECÇÃO CONFIRMADA' : (c.score?.outcome ?? 'AGUARDANDO')}
                    <br />
                    {c.score?.reason === 'AUTO_EXECUTION_DISABLED'
                      ? 'ESCRITA BLOQUEADA'
                      : c.score?.reason}
                  </td>
                  <td>
                    {c.score?.firstAbnormalAt
                      ? new Date(c.score.firstAbnormalAt).toLocaleTimeString()
                      : '—'}
                  </td>
                  <td>{c.score?.decisionMs == null ? '—' : `${c.score.decisionMs} ms`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export function MitigationAutoAllPanel({ names }: { names: Record<string, string> }) {
  const report = useQuery({
    queryKey: ['mitigation', 'auto-all-live'],
    retry: false,
    refetchInterval: 1000,
    queryFn: async (): Promise<AutoAllLiveData> => {
      const [all, poller] = await Promise.all([
        request<AutoAllReport>('/api/bgp/mitigation/auto-all'),
        request<PollerReport>('/api/bgp/mitigation/fast-poller'),
      ]);
      return { all, poller };
    },
  });
  return report.data ? <MitigationAutoAllFacts data={report.data} names={names} /> : null;
}
