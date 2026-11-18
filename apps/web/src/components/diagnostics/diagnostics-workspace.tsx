'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/app/providers';
import { getHostMpls, getHosts, getVsiDiagnosticStatus } from '@/lib/api';
import { VsiDiagnosticPanel } from '../vsi-diagnostic-panel';
import { VsiServiceWorkspace } from './service/service-workspace';
import styles from './diagnostics-workspace.module.css';

function freshnessLabel(value: string | null): string {
  if (!value) return 'sem coleta registrada';
  const age = Date.now() - Date.parse(value);
  if (!Number.isFinite(age) || age < 0) return 'horário indisponível';
  if (age < 60_000) return 'agora';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes} min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h atrás`;
  return `${Math.floor(hours / 24)} d atrás`;
}

/**
 * Área principal de Diagnóstico. O estado do recurso vem do backend em runtime
 * (`/api/diagnostics/status`); nenhum valor de build decide se a UI opera.
 */
export function DiagnosticsWorkspace() {
  const { user } = useAuth();
  const [hostId, setHostId] = useState('');
  const [vsiId, setVsiId] = useState('');

  const status = useQuery({
    queryKey: ['vsi-diagnostic-status'],
    queryFn: () => getVsiDiagnosticStatus(),
    staleTime: 15_000,
  });
  const hosts = useQuery({
    queryKey: ['diagnostics-hosts'],
    queryFn: () => getHosts(),
    staleTime: 60_000,
  });
  const overview = useQuery({
    queryKey: ['diagnostics-overview', hostId],
    queryFn: () => getHostMpls(hostId),
    enabled: Boolean(hostId),
    staleTime: 30_000,
  });

  const vsis = useMemo(
    () => (overview.data?.vsis ?? []).filter((vsi) => vsi.hostId === hostId),
    [overview.data, hostId],
  );
  const selectedVsi = vsis.find((vsi) => vsi.id === vsiId) ?? null;
  const enabled = status.data?.diagnosticEnabled === true;
  const trust = status.data?.diagnosticTrust ?? 'UNAVAILABLE';
  const canArm = user?.role === 'ADMIN';
  const canExecute = user?.role === 'ADMIN' || user?.role === 'OPERATOR';

  return (
    <section className={styles.workspace} aria-label="Diagnóstico">
      <header className={styles.header}>
        <h1>Diagnóstico</h1>
        <p>
          Área produtiva de diagnósticos. Primeiro módulo disponível: Diagnóstico VSI (somente
          leitura no equipamento).
        </p>
      </header>
      <section className={styles.module} aria-label="Diagnóstico VSI">
        <h2>Diagnóstico VSI</h2>
        <div className={styles.selectors}>
          <label>
            Equipamento
            <select
              value={hostId}
              onChange={(event) => {
                setHostId(event.target.value);
                setVsiId('');
              }}
            >
              <option value="">Selecione…</option>
              {(hosts.data ?? []).map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            VSI
            <select
              value={vsiId}
              onChange={(event) => setVsiId(event.target.value)}
              disabled={!hostId || vsis.length === 0}
            >
              <option value="">Selecione…</option>
              {vsis.map((vsi) => (
                <option key={vsi.id} value={vsi.id}>
                  {vsi.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <dl className={styles.state}>
          <div>
            <dt>Estado do recurso</dt>
            <dd className={enabled ? styles.on : styles.off}>
              {status.isPending ? 'consultando…' : enabled ? 'ATIVO' : 'DESATIVADO'}
            </dd>
          </div>
          <div>
            <dt>Trust</dt>
            <dd>{trust === 'AVAILABLE' ? 'disponível' : 'indisponível'}</dd>
          </div>
          <div>
            <dt>Inventário</dt>
            <dd>{freshnessLabel(overview.data?.lastSuccessAt ?? null)}</dd>
          </div>
        </dl>
        {selectedVsi ? (
          <VsiDiagnosticPanel
            hostId={selectedVsi.hostId}
            vsiId={selectedVsi.id}
            diagnosticEnabled={enabled}
            canArm={canArm}
            canExecute={canExecute}
          />
        ) : (
          <p className={styles.hint}>Selecione equipamento e VSI para operar o diagnóstico.</p>
        )}
        <p className={styles.future}>Espaço reservado para futuros diagnósticos.</p>
      </section>
      {/* Diagnostico por servico (varios PEs): somente leitura de resultados guardados; some quando a API nao o habilita. */}
      <VsiServiceWorkspace vsiName={selectedVsi?.name ?? null} />
    </section>
  );
}
