'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/app/providers';
import { getHostMpls, getHosts, getVsiDiagnosticStatus } from '@/lib/api';
import { getVsiMcpStatus } from '@/lib/vsi-mcp-status';
import { VsiDiagnosticPanel } from '../vsi-diagnostic-panel';
import { canArmLegacy, canExecuteLegacy, legacyAvailability, serviceCollectionAvailability } from './central/availability';
import { HostPicker } from './central/host-picker';
import { VsiInventoryCard } from './central/inventory-card';
import { VsiServiceWorkspace } from './service/service-workspace';
import central from './central/central.module.css';
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

const VSI_FILTER_THRESHOLD = 10;
const message = (error: unknown): string => (error instanceof Error ? error.message : 'erro desconhecido');

/**
 * Central de diagnostico VSI/VPLS. O operador escolhe EQUIPAMENTO e VSI aqui mesmo (independente do Mapa) em tres
 * etapas separadas: 1) selecionar, 2) ver resultado existente (inventario + resultados guardados), 3) solicitar nova
 * coleta.
 *
 * As etapas 1 e 2 so LEEM (banco/arquivos de resultado): escolher equipamento ou VSI nunca dispara SSH, SNMP nem
 * descoberta. A etapa 3 tem DUAS formas de coleta, decididas de forma independente:
 *  - Diagnostico LEGADO (Preparar janela / Diagnosticar): estado real de /api/diagnostics/status + papel do usuario.
 *    NAO depende de VSI_MCP_ENABLED e nao e afetado por falha ao consultar o estado do MCP.
 *  - Diagnostico VSI por SERVICO (nova coleta via MCP): so informa a disponibilidade (VSI_MCP_ENABLED). Esta tela nao
 *    executa coleta por MCP, entao nao ha botao dessa forma (nenhuma acao duplicada).
 */
export function DiagnosticsWorkspace() {
  const { user } = useAuth();
  const [hostId, setHostId] = useState('');
  const [vsiId, setVsiId] = useState('');
  const [vsiFilter, setVsiFilter] = useState('');

  const hosts = useQuery({ queryKey: ['diagnostics-hosts'], queryFn: () => getHosts(), staleTime: 60_000 });
  const overview = useQuery({
    queryKey: ['diagnostics-overview', hostId],
    queryFn: () => getHostMpls(hostId),
    enabled: Boolean(hostId),
    staleTime: 30_000,
  });
  // Estado do recurso de execucao ao vivo (runtime). Falha de consulta = indisponivel (fail-closed).
  const live = useQuery({ queryKey: ['vsi-mcp-status'], queryFn: () => getVsiMcpStatus(), staleTime: 15_000, retry: false });
  const serviceState = serviceCollectionAvailability({ pending: live.isPending, error: live.isError, data: live.data });
  // Legado: consulta SEMPRE (independente do MCP). Falha = nao confirmado = sem acao (fail-closed so para o legado).
  const legacyStatus = useQuery({ queryKey: ['vsi-diagnostic-status'], queryFn: () => getVsiDiagnosticStatus(), staleTime: 15_000, retry: false });

  const selectedHost = (hosts.data ?? []).find((host) => host.id === hostId) ?? null;
  // So VSIs do equipamento escolhido: uma selecao antiga nunca sobrevive a troca de host.
  const vsis = useMemo(() => (overview.data?.vsis ?? []).filter((vsi) => vsi.hostId === hostId), [overview.data, hostId]);
  const visibleVsis = useMemo(() => {
    const term = vsiFilter.trim().toLowerCase();
    return term ? vsis.filter((vsi) => vsi.name.toLowerCase().includes(term) || vsi.id === vsiId) : vsis;
  }, [vsis, vsiFilter, vsiId]);
  const selectedVsi = vsis.find((vsi) => vsi.id === vsiId) ?? null;

  const canArm = canArmLegacy(user?.role);
  const canExecute = canExecuteLegacy(user?.role);
  // Resultados detalhados: so OPERATOR/ADMIN (a API tambem impede). Sem sessao carregada = sem acesso (fail-closed).
  const canViewStored = user?.role === 'OPERATOR' || user?.role === 'ADMIN';
  const legacyState = legacyAvailability({ pending: legacyStatus.isPending, error: legacyStatus.isError, data: legacyStatus.data });

  function selectHost(next: string) {
    setHostId(next);
    setVsiId('');
    setVsiFilter('');
  }

  return (
    <section className={styles.workspace} aria-label="Diagnóstico">
      <header className={styles.header}>
        <h1>Diagnóstico</h1>
        <p>
          Central de diagnóstico VSI/VPLS. Escolha o equipamento e a VSI aqui mesmo: consultar inventário e resultados guardados é somente
          leitura e não executa nada no equipamento.
        </p>
      </header>

      <div className={central.steps}>
        {/* 1 — Selecionar */}
        <section className={central.step} aria-label="Selecionar VSI" data-step="select">
          <div className={central.stepHead}>
            <span className={central.stepNo} aria-hidden="true">1</span>
            <h2>Selecionar equipamento e VSI</h2>
          </div>
          <p className={central.stepSub}>Escolher não consulta o equipamento: o inventário vem do banco do NetVision.</p>
          <div className={central.grid}>
            <HostPicker
              hosts={hosts.data ?? []}
              loading={hosts.isPending}
              error={hosts.isError ? message(hosts.error) : null}
              selectedId={hostId}
              onSelect={selectHost}
            />
            <div className={central.field} data-vsi-picker>
              <label className={central.label} htmlFor="diag-vsi">
                VSI
              </label>
              {!hostId ? <p className={central.note}>Escolha um equipamento para ver as VSIs do inventário.</p> : null}
              {hostId && overview.isPending ? <p className={central.note}>Consultando o inventário do equipamento…</p> : null}
              {hostId && overview.isError ? (
                <p className={central.error} role="alert">
                  Não foi possível ler o inventário: {message(overview.error)}
                </p>
              ) : null}
              {hostId && overview.isSuccess && overview.data.supported === false ? (
                <p className={central.empty} data-empty="unsupported">
                  Este equipamento não tem inventário VSI/MPLS no NetVision (recurso não detectado). Nenhum dado foi inventado e nenhuma coleta
                  foi disparada.
                </p>
              ) : null}
              {hostId && overview.isSuccess && overview.data.supported !== false && vsis.length === 0 ? (
                <p className={central.empty} data-empty="vsis">
                  Nenhuma VSI no inventário deste equipamento. O NetVision lista só VSIs já descobertas ou cadastradas; esta tela não inicia
                  descoberta, SNMP nem SSH. Quando houver VSIs inventariadas, elas aparecem aqui.
                </p>
              ) : null}
              {hostId && overview.isSuccess && vsis.length > 0 ? (
                <>
                  {vsis.length > VSI_FILTER_THRESHOLD ? (
                    <input
                      type="search"
                      className={central.input}
                      aria-label="Filtrar VSIs"
                      placeholder={`Filtrar entre ${vsis.length} VSIs`}
                      value={vsiFilter}
                      onChange={(event) => setVsiFilter(event.target.value)}
                    />
                  ) : null}
                  <select
                    id="diag-vsi"
                    className={central.select}
                    aria-label="VSI"
                    value={selectedVsi ? selectedVsi.id : ''}
                    onChange={(event) => setVsiId(event.target.value)}
                  >
                    <option value="">Selecione…</option>
                    {visibleVsis.map((vsi) => (
                      <option key={vsi.id} value={vsi.id}>
                        {vsi.name} · {vsi.operationalStatus}
                      </option>
                    ))}
                  </select>
                  <p className={central.note}>
                    {visibleVsis.length} de {vsis.length} VSI{vsis.length === 1 ? '' : 's'} no inventário.
                  </p>
                </>
              ) : null}
            </div>
          </div>
          <dl className={central.summary} aria-label="Resumo da seleção">
            <div>
              <dt>Equipamento</dt>
              <dd>{selectedHost?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>VSI</dt>
              <dd>{selectedVsi?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>Inventário</dt>
              <dd>{hostId ? freshnessLabel(overview.data?.lastSuccessAt ?? null) : '—'}</dd>
            </div>
          </dl>
        </section>

        {/* 2 — Resultado existente */}
        <section className={central.step} aria-label="Resultados existentes" data-step="view">
          <div className={central.stepHead}>
            <span className={central.stepNo} aria-hidden="true">2</span>
            <h2>Resultado existente</h2>
          </div>
          <p className={central.stepSub}>Somente leitura: inventário persistido e, para OPERATOR e ADMIN, diagnósticos já guardados. Abrir não executa coleta.</p>
          {selectedVsi ? (
            <VsiInventoryCard vsi={selectedVsi} hostName={selectedHost?.name ?? selectedVsi.hostId} lastSuccessAt={overview.data?.lastSuccessAt ?? null} canViewStored={canViewStored} />
          ) : (
            <p className={central.note} data-hint="inventory">
              Selecione equipamento e VSI para ver o inventário (estado, PEs, ACs, PWs e labels).
              {canViewStored ? ' Os resultados guardados abaixo podem ser consultados sem selecionar.' : ''}
            </p>
          )}
          {canViewStored ? (
            <VsiServiceWorkspace vsiName={selectedVsi?.name ?? null} unavailableNotice />
          ) : (
            <p className={central.empty} role="status" data-results-restricted>
              Resultados detalhados do diagnóstico VSI/VPLS são restritos a OPERATOR e ADMIN. O seu perfil consulta apenas o inventário.
            </p>
          )}
        </section>

        {/* 3 — Solicitar nova coleta: duas formas, identificadas e decididas separadamente */}
        <section className={central.step} aria-label="Solicitar nova coleta" data-step="collect">
          <div className={central.stepHead}>
            <span className={central.stepNo} aria-hidden="true">3</span>
            <h2>Solicitar nova coleta</h2>
          </div>
          <p className={central.stepSub}>
            Duas formas distintas, com disponibilidade independente. Só o diagnóstico legado tem ações nesta tela.
          </p>

          <section className={central.collect} aria-label="Diagnóstico legado" data-collect="legacy" data-legacy-state={legacyState}>
            <h3>Diagnóstico legado · janela one-shot</h3>
            {legacyState === 'checking' ? <p className={central.note}>Verificando o estado do diagnóstico legado…</p> : null}
            {legacyState === 'unknown' ? (
              <div className={central.unavailable} role="status" data-legacy-unavailable="unknown">
                <strong>Estado do diagnóstico legado não confirmado</strong>
                <p>Não foi possível consultar o estado do serviço. Sem confirmação, nenhuma ação é oferecida. Isto não depende do MCP.</p>
              </div>
            ) : null}
            {legacyState === 'disabled' ? (
              <div className={central.unavailable} role="status" data-legacy-unavailable="disabled">
                <strong>Diagnóstico legado desativado nesta instalação</strong>
                <p>O serviço informa que está desativado; não há ação de execução.</p>
              </div>
            ) : null}
            {legacyState === 'no-trust' ? (
              <div className={central.unavailable} role="status" data-legacy-unavailable="no-trust">
                <strong>Diagnóstico legado sem perfil de acesso confiável</strong>
                <p>O serviço está ativo, mas não há perfil de acesso disponível para operar; não há ação de execução.</p>
              </div>
            ) : null}
            {legacyState === 'available' && !canExecute ? (
              <p className={central.note} data-legacy-role-note>
                Diagnóstico legado disponível. O seu perfil apenas consulta resultados; preparar janela e diagnosticar exigem OPERATOR ou ADMIN.
              </p>
            ) : null}
            {legacyState === 'available' && canExecute && !selectedVsi ? (
              <p className={central.note}>Selecione equipamento e VSI (etapa 1) para usar o diagnóstico legado.</p>
            ) : null}
            {legacyState === 'available' && canExecute && selectedVsi ? (
              <VsiDiagnosticPanel hostId={selectedVsi.hostId} vsiId={selectedVsi.id} diagnosticEnabled canArm={canArm} canExecute={canExecute} />
            ) : null}
          </section>

          <section className={central.collect} aria-label="Diagnóstico VSI por serviço" data-collect="service" data-service-state={serviceState}>
            <h3>Diagnóstico VSI por serviço · nova coleta via MCP</h3>
            {serviceState === 'checking' ? <p className={central.note}>Verificando a disponibilidade da coleta via MCP…</p> : null}
            {serviceState === 'unavailable' || serviceState === 'status-failed' ? (
              <div className={central.unavailable} role="status" data-live-unavailable>
                <strong>Recurso indisponível nesta instalação</strong>
                <p>
                  {serviceState === 'status-failed'
                    ? 'Não foi possível confirmar o estado da coleta via MCP; ela é tratada como indisponível. O diagnóstico legado não é afetado.'
                    : 'A nova coleta VSI por serviço (MCP/SSH) está desativada. O diagnóstico legado, o inventário e os resultados guardados seguem disponíveis conforme o estado de cada um.'}
                </p>
              </div>
            ) : null}
            {serviceState === 'available' ? (
              <p className={central.note} data-service-available>
                Coleta via MCP habilitada. Ela é solicitada pelo MCP, com aprovação de um ADMIN por equipamento; esta tela não a executa nem tem
                botão para isso. O resultado aparece em “Resultados guardados” (etapa 2).
              </p>
            ) : null}
          </section>
        </section>
      </div>
    </section>
  );
}
