'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BgpMitigationDiscoveryResponseDto,
  BgpMitigationProfileDto,
  BgpMitigationSimulationDto,
  MitigationExclusionReason,
} from '@gmj/shared';
import { Search } from 'lucide-react';
import { Button, MetaFact } from '@gmj/ui';
import { getHosts } from '@/lib/api';
import { getMediaSummary } from '@/lib/media-api';
import { useMapStore } from '@/store/map-store';
import {
  discoverMitigationProfiles,
  getMitigationHealth,
  getMitigationProfile,
  getMitigationProfiles,
  patchMitigationProfile,
  setMitigationExclusion,
  runMitigationCommand,
  simulateMitigationProfile,
  type MitigationCommandAction,
  type MitigationCommandResult,
} from '@/lib/mitigation-api';
import {
  blockReasonLabel,
  formatBandwidthBps,
  formatDateTime,
  formatGbps,
  formatPercent,
  prefixStatusLabel,
  profileModeLabel,
  exclusionReasonLabel,
  EXCLUSION_REASON_OPTIONS,
  readinessLabel,
  runtimeStateLabel,
  simulationResultLabel,
  workerStateLabel,
  mitigationEngineStatus,
} from '@/lib/mitigation-labels';

const BPS_PER_GBPS = 1_000_000_000;

function gbpsToBpsString(gbps: number): string {
  return BigInt(Math.round(gbps * BPS_PER_GBPS)).toString();
}

function bpsStringToGbps(bps: string | null): number | null {
  if (bps === null) return null;
  const value = Number(bps);
  return Number.isFinite(value) ? value / BPS_PER_GBPS : null;
}

/**
 * Estado da notificação da execução. Sucesso de mitigação com falha de webhook
 * continua sendo sucesso — são estados separados.
 */
function notificationOutcomeLabel(result: {
  notification?: { published: boolean; skipped: boolean };
}): string {
  const outcome = result.notification;
  if (!outcome || outcome.skipped) return 'NÃO CONFIGURADA';
  return outcome.published ? 'ENVIADA' : 'FALHOU';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** requestId unico por acao (idempotencia no servidor). */
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function BgpMitigationWorkspace() {
  const queryClient = useQueryClient();
  const [deviceId, setDeviceId] = useState('');
  const [discovery, setDiscovery] = useState<BgpMitigationDiscoveryResponseDto | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<BgpMitigationSimulationDto | null>(null);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [commandResult, setCommandResult] = useState<MitigationCommandResult | null>(null);
  const [pendingAction, setPendingAction] = useState<'ACTIVATE' | 'REMOVE' | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const setPanel = useMapStore((state) => state.setPanel);
  // Indicador discreto: a configuração completa fica em CONFIGURAÇÕES > MÍDIAS.
  const mediaSummary = useQuery({
    queryKey: ['media-summary'],
    queryFn: getMediaSummary,
    retry: false,
    refetchInterval: 120_000,
  });

  const health = useQuery({
    queryKey: ['mitigation', 'health'],
    queryFn: getMitigationHealth,
    refetchInterval: 60_000,
  });
  const profiles = useQuery({
    queryKey: ['mitigation', 'profiles'],
    queryFn: getMitigationProfiles,
  });
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: () => getHosts() });

  const rows = useMemo(
    () => discovery?.profiles ?? profiles.data ?? [],
    [discovery, profiles.data],
  );
  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );
  const readyCount = rows.filter((row) => row.readiness === 'READY').length;
  const notReadyCount = rows.filter((row) => row.readiness === 'NOT_READY').length;
  const sshHosts = useMemo(() => (hosts.data ?? []).filter((host) => host.sshEnabled), [hosts.data]);

  const discoveryMutation = useMutation({
    mutationFn: (target: string) => discoverMitigationProfiles({ deviceId: target }),
    onSuccess: (result) => {
      setDiscovery(result);
      setNotice(null);
      setSimulation(null);
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ['mitigation', 'profiles'] });
    },
    onError: (error) => setNotice(errorMessage(error, 'Falha na descoberta de clientes')),
  });

  const simulateMutation = useMutation({
    mutationFn: (input: {
      id: string;
      trafficGbps: number;
      samples: number;
      prefixCount: number | null;
    }) =>
      simulateMitigationProfile(input.id, {
        simulatedTrafficBps: gbpsToBpsString(input.trafficGbps),
        samples: input.samples,
        ...(input.prefixCount === null ? {} : { simulatedPrefixCount: input.prefixCount }),
      }),
    onSuccess: (result) => {
      setSimulation(result);
      setNotice(null);
    },
    onError: (error) => setNotice(errorMessage(error, 'Falha na simulação')),
  });

  const patchMutation = useMutation({
    mutationFn: (input: { id: string; overrideBps: string | null }) =>
      patchMitigationProfile(input.id, { bandwidthOverrideBps: input.overrideBps }),
    onSuccess: async (updated) => {
      setOverrideOpen(false);
      setNotice(null);
      setDiscovery((current) =>
        current
          ? {
              ...current,
              profiles: current.profiles.map((row) => (row.id === updated.id ? updated : row)),
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: ['mitigation', 'profiles'] });
    },
    onError: (error) => setNotice(errorMessage(error, 'Falha ao salvar o override de banda')),
  });

  const databaseWarning =
    health.data && !health.data.migrationReady
      ? 'Banco de dados ainda não migrado: os clientes aparecem pela descoberta, mas nada é persistido.'
      : null;

  // Acoes de mitigacao: MESMO MitigationCommandService usado pelo n8n inbound.
  const commandMutation = useMutation({
    mutationFn: (input: { id: string; action: MitigationCommandAction; requestId: string }) =>
      runMitigationCommand(input.id, { requestId: input.requestId, action: input.action }),
    onSuccess: async (result, variables) => {
      setCommandResult(result);
      setPendingAction(null);
      setEvidenceOpen(false);
      // releitura do profile/runtime - nao confiamos so no estado local
      await queryClient.invalidateQueries({ queryKey: ['mitigation', 'profiles'] });
      const fresh = await getMitigationProfile(variables.id).catch(() => null);
      if (fresh) {
        setDiscovery((current) =>
          current
            ? {
                ...current,
                profiles: current.profiles.map((row) => (row.id === fresh.id ? fresh : row)),
              }
            : current,
        );
      }
    },
    onError: (error, variables) => {
      setPendingAction(null);
      setCommandResult({
        ok: false,
        status: 'REQUEST_FAILED',
        notification: { published: false, skipped: true },
        requestId: variables.requestId,
        action: variables.action,
        profileId: variables.id,
        customer: null,
        device: null,
        interface: null,
        interfaceId: null,
        bogonNode: null,
        mitigationNode: null,
        addressFamily: null,
        policy: null,
        node: null,
        rt: null,
        sharedPolicy: false,
        sharedPolicyTargets: [],
        affectedPeers: [],
        verified: false,
        executedAt: new Date().toISOString(),
        idempotent: false,
        commandPreview: [],
        verification: null,
        safeError: errorMessage(error, 'Falha ao executar a ação'),
      });
    },
  });

  const exclusionMutation = useMutation({
    mutationFn: (input: {
      id: string;
      excluded: boolean;
      reason: MitigationExclusionReason;
      note: string;
    }) =>
      setMitigationExclusion(input.id, {
        excluded: input.excluded,
        ...(input.excluded ? { reason: input.reason, note: input.note.trim() || null } : {}),
      }),
    onSuccess: (updated) => {
      setNotice(
        updated.mitigationExcluded
          ? 'Exclusão salva: este peer não será mais mitigado.'
          : 'Exclusão removida: o peer volta a ser elegível para mitigação.',
      );
      setDiscovery((current) =>
        current
          ? {
              ...current,
              profiles: current.profiles.map((row) => (row.id === updated.id ? updated : row)),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['mitigation', 'profiles'] });
    },
    onError: (error) => setNotice(errorMessage(error, 'Falha ao salvar a exclusão')),
  });

  const engine = health.data?.autoEngine ?? null;
  const engineStatus = mitigationEngineStatus({
    mode: health.data?.mode ?? 'SIMULATION_ONLY',
    executor: health.data?.executor ?? 'MOCK',
    liveWriteEnabled: health.data?.liveWriteEnabled === true,
    autoState: engine?.state ?? null,
  });
  const profileCounts = health.data?.profiles ?? {
    total: rows.length,
    auto: 0,
    alertOnly: 0,
    disabled: 0,
  };

  function runCommand(action: MitigationCommandAction, profileId: string): void {
    commandMutation.mutate({ id: profileId, action, requestId: newRequestId() });
  }

  return (
    <section className="mitigation-shell" aria-label="Mitigação DDoS">
      <div
        className={`mitigation-banner mitigation-banner--${engineStatus.tone}`}
        role="status"
      >
        <span className="mitigation-banner__title">{engineStatus.title}</span>
        <span className="mitigation-banner__text">{engineStatus.text}</span>
      </div>

      <div className="mitigation-cards">
        <MetaFact
          label="modo global"
          value={engineStatus.modeLabel}
          tone={engineStatus.autoActive ? 'up' : 'info'}
        />
        <MetaFact
          label="motor"
          value={engine?.state ?? 'OFF'}
          tone={engine?.state === 'RUNNING' ? 'up' : 'info'}
        />
        <MetaFact
          label="executor"
          value={engineStatus.executorLabel}
          tone={engineStatus.executorLabel === 'HUAWEI' ? 'up' : 'info'}
        />
        <MetaFact
          label="live write"
          value={engineStatus.liveWriteLabel}
          tone={engineStatus.liveWriteLabel === 'SIM' ? 'up' : 'info'}
        />
        <MetaFact
          label="profiles AUTO / ALERT / OFF"
          value={`${profileCounts.auto} / ${profileCounts.alertOnly} / ${profileCounts.disabled}`}
        />
        <MetaFact
          label="última avaliação"
          value={formatDateTime(engine?.lastSuccessfulTickAt ?? engine?.lastTickAt ?? null)}
        />
        <MetaFact
          label="última decisão"
          value={
            engine?.lastDecision
              ? `${engine.lastDecision.outcome}${engine.lastDecision.reason ? ` · ${engine.lastDecision.reason}` : ''}`
              : '—'
          }
          tone={engine?.lastDecision?.outcome === 'ACTIVATED' ? 'up' : 'info'}
        />
        <MetaFact
          label="último ACTIVATE verificado"
          value={
            engine?.lastAutoActivateAt
              ? `${formatDateTime(engine.lastAutoActivateAt)} · ${engine.lastAutoActivateProfileId ?? '—'}`
              : '—'
          }
          tone={engine?.lastAutoActivateAt ? 'up' : 'info'}
        />
        {engine?.lastError ? <MetaFact label="último erro" value={engine.lastError} tone="down" /> : null}
        <MetaFact
          label="worker"
          value={workerStateLabel(health.data?.worker.state ?? 'STOPPED')}
          tone={health.data?.worker.state === 'READY' ? 'up' : 'info'}
        />
        <MetaFact label="clientes descobertos" value={rows.length} />
        <MetaFact label="aptos" value={readyCount} tone="up" />
        <MetaFact label="não aptos" value={notReadyCount} tone="down" />
        <MetaFact label="ignorados" value={discovery?.ignoredNoBandwidth ?? 0} />
        <MetaFact
          label="última descoberta"
          value={formatDateTime(discovery?.discoveredAt ?? health.data?.lastDiscoveryAt ?? null)}
        />
      </div>

      {databaseWarning && (
        <div className="mitigation-notice mitigation-notice--info" role="status">
          {databaseWarning}
        </div>
      )}

      {notice && (
        <div className="mitigation-notice mitigation-notice--warning" role="alert">
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label="Fechar aviso">
            ×
          </button>
        </div>
      )}

      <div className="mitigation-toolbar">
        <label className="mitigation-toolbar__field">
          <span>Equipamento</span>
          <select
            aria-label="Equipamento"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            <option value="">Selecione um equipamento</option>
            {sshHosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.displayName || host.hostname}
              </option>
            ))}
          </select>
        </label>
        <Button
          compact
          disabled={!deviceId || discoveryMutation.isPending}
          onClick={() => discoveryMutation.mutate(deviceId)}
        >
          <Search size={15} />{' '}
          {discoveryMutation.isPending ? 'Descobrindo…' : 'DESCOBRIR CLIENTES'}
        </Button>
        {discoveryMutation.isPending && (
          <span className="mitigation-loading" role="status">
            Analisando peers e descrições…
          </span>
        )}
      </div>

      {discovery && (
        <div className="mitigation-summary" role="status">
          <span>
            <strong>{discovery.scannedPeers}</strong> peers analisados
          </span>
          <span>
            <strong>{discovery.candidateInterfaces}</strong> clientes candidatos
          </span>
          <span>
            <strong>{discovery.ignoredNoBandwidth}</strong> interfaces ignoradas por não possuir banda
          </span>
          <span>
            <strong>{discovery.createdProfiles + discovery.updatedProfiles}</strong> policies prontas
          </span>
          <span>
            <strong>{discovery.blockedProfiles}</strong> não aptas
          </span>
        </div>
      )}

      {discovery && discovery.warnings.length > 0 && (
        <ul className="mitigation-warnings">
          {discovery.warnings.slice(0, 5).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {profiles.isLoading && !discovery ? (
        <div className="hosts-empty">
          <span>Carregando clientes de mitigação…</span>
        </div>
      ) : profiles.isError && !discovery ? (
        <div className="hosts-empty">
          <span>Não foi possível carregar os clientes de mitigação.</span>
          <Button compact variant="secondary" onClick={() => void profiles.refetch()}>
            Tentar novamente
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="hosts-empty">
          <span>
            Nenhum cliente descoberto. Use DESCOBRIR CLIENTES para analisar um equipamento.
          </span>
        </div>
      ) : (
        <div className="hosts-table-wrap mitigation-table-wrap">
          <table className="mitigation-table">
            <caption className="mitigation-table__caption">
              Clientes candidatos à mitigação (nenhuma ação automática nesta fase)
            </caption>
            <thead>
              <tr>
                <th scope="col">Estado</th>
                <th scope="col">Cliente</th>
                <th scope="col">Equipamento</th>
                <th scope="col">Interface</th>
                <th scope="col">Banda</th>
                <th scope="col">Tráfego</th>
                <th scope="col">Utilização</th>
                <th scope="col">Policy</th>
                <th scope="col">Peers</th>
                <th scope="col">Prefixos</th>
                <th scope="col">AF</th>
                <th scope="col">Node</th>
                <th scope="col">Ação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.readiness === 'READY' ? 'is-ready' : 'is-blocked'}>
                  <td>
                    <span className={`mitigation-badge is-${row.readiness.toLowerCase()}`}>
                      {readinessLabel(row.readiness)}
                    </span>
                  </td>
                  <td>
                    {row.addressFamily === 'IPV6' ? 'IPv6' : 'IPv4'}
                  </td>
                  <td>
                    {row.customer ?? '—'}
                    {row.mitigationExcluded ? (
                      <span className="mitigation-excluded-badge" title="Excluído da mitigação">
                        🛡 Excluído da mitigação
                      </span>
                    ) : null}
                  </td>
                  <td>{row.deviceName}</td>
                  <td>{row.interfaceName ?? '—'}</td>
                  <td>{formatBandwidthBps(row.effectiveBandwidthBps)}</td>
                  <td>—</td>
                  <td>—</td>
                  <td>{row.policyName ?? 'não encontrada'}</td>
                  <td>{row.peerAddresses.length}</td>
                  <td>
                    {row.prefixCount === null
                      ? `— / ${row.prefixLimit}`
                      : `${row.prefixCount} / ${row.prefixLimit}`}
                  </td>
                  <td>{row.plannedNode ?? '—'}</td>
                  <td>
                    <Button compact variant="secondary" onClick={() => setSelectedId(row.id)}>
                      DETALHES
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <aside
          className="mitigation-drawer"
          role="dialog"
          aria-modal="false"
          aria-label={`Detalhes de ${selected.customer ?? 'cliente'}`}
        >
          <header className="mitigation-drawer__header">
            <h3>Detalhes do cliente</h3>
            <Button compact variant="secondary" onClick={() => setSelectedId(null)}>
              FECHAR
            </Button>
          </header>

          <div className="mitigation-drawer__body">
          <div className="mitigation-detail__grid">
            <div>
              <span className="mitigation-detail__label">Cliente</span>
              <strong>{selected.customer ?? '—'}</strong>
            </div>
            <div>
              <span className="mitigation-detail__label">Equipamento</span>
              <strong>{selected.deviceName}</strong>
            </div>
            <div>
              <span className="mitigation-detail__label">Interface</span>
              <strong>{selected.interfaceName ?? '—'}</strong>
            </div>
            <div>
              <span className="mitigation-detail__label">Descrição</span>
              <strong>{selected.interfaceDescription ?? '—'}</strong>
            </div>
          </div>

          <div className="mitigation-detail__block mitigation-media-status">
            <h4>NOTIFICAÇÕES</h4>
            <p>
              {mediaSummary.data
                ? `n8n ${mediaSummary.data.configured ? '● configurado' : '○ não configurado'}`
                : 'n8n — verificando…'}
            </p>
            <Button compact variant="secondary" onClick={() => setPanel('media')}>
              CONFIGURAR MÍDIAS
            </Button>
          </div>

          <div className="mitigation-detail__block">
            <h4>BANDA</h4>
            <p>Detectada: {formatBandwidthBps(selected.detectedBandwidthBps)}</p>
            <p>
              Override:{' '}
              {selected.bandwidthOverrideBps === null
                ? 'não configurado'
                : formatBandwidthBps(selected.bandwidthOverrideBps)}
            </p>
            <p>Efetiva: {formatBandwidthBps(selected.effectiveBandwidthBps)}</p>
            <Button compact variant="secondary" onClick={() => setOverrideOpen(true)}>
              EDITAR OVERRIDE
            </Button>
          </div>

          <div className="mitigation-detail__block">
            <h4>BGP</h4>
            <p>Policy IN: {selected.policyName ?? 'não encontrada'}</p>
            <p>Família: {selected.addressFamily}</p>
            {selected.sharedPolicy && (
              <div className="mitigation-shared-policy" role="status">
                <strong>ATENÇÃO: esta policy é compartilhada.</strong>
                <span>A alteração também afetaria:</span>
                <ul>
                  {selected.sharedPolicyTargets.map((target) => (
                    <li key={`${target.interfaceId ?? 'sem'}-${target.peerAddress}`}>
                      {target.customer ?? '—'} · {target.interfaceName ?? '—'} · Peer:{' '}
                      {target.peerAddress}
                    </li>
                  ))}
                </ul>
                <small>Aviso, não bloqueio: a automação continua liberada.</small>
              </div>
            )}
            <p>Peer principal: {selected.primaryPeerAddress ?? '—'}</p>
            <p>Peers afetados: {selected.peerAddresses.join(', ') || '—'}</p>
            <p>
              Prefixos:{' '}
              {selected.prefixCount === null
                ? `— / ${selected.prefixLimit}`
                : `${selected.prefixCount} / ${selected.prefixLimit}`}
            </p>
            <p>Status: {prefixStatusLabel(selected.prefixStatus)}</p>
          </div>

          <div className="mitigation-detail__block">
            <h4>ROUTE-POLICY</h4>
            <p>
              Nodes existentes:{' '}
              {selected.existingNodes.length ? selected.existingNodes.join(', ') : 'nenhum'}
            </p>
            <p>
              Nodes de mitigação:{' '}
              {selected.mitigationNodes.length ? selected.mitigationNodes.join(', ') : 'nenhum'}
            </p>
            <p>Node BOGONS planejado: {selected.plannedBogonNode ?? '—'}</p>
            <p>Node mitigação planejado: {selected.plannedMitigationNode ?? selected.plannedNode ?? '—'}</p>
            <p>Prefix-list BOGONS: {selected.bogonPrefixList ?? 'BOGONS'}</p>
            <p>Prefix-list mitigação: {selected.targetPrefixList ?? 'PREFIX8to24'}</p>
            <p>Node planejado (compat): {selected.plannedNode ?? '—'}</p>
            <p>RT de mitigação: {selected.mitigationRt}</p>
          </div>

          <ExclusionEditor
            key={selected.id}
            row={selected}
            saving={exclusionMutation.isPending}
            onSave={(input) => exclusionMutation.mutate({ id: selected.id, ...input })}
          />

          <div className="mitigation-detail__block">
            <h4>SITUAÇÃO</h4>
            <p>Estado: {readinessLabel(selected.readiness)}</p>
            <p>Runtime: {runtimeStateLabel(selected.runtimeState)}</p>
            <p>Modo do perfil: {profileModeLabel(selected.mode)}</p>
            {selected.blockedReason && <p>Motivo: {blockReasonLabel(selected.blockedReason)}</p>}
            <div className="mitigation-mock-notice" role="status">
              <strong>MODO DE EXECUÇÃO: SIMULAÇÃO / MOCK</strong>
              <span>Nenhum comando será enviado ao equipamento.</span>
            </div>
            <div className="mitigation-actions">
              <Button
                compact
                disabled={!selected.persisted || commandMutation.isPending}
                onClick={() => {
                  setSimulation(null);
                  setSimulateOpen(true);
                }}
              >
                SIMULAR MITIGAÇÃO
              </Button>
              <Button
                compact
                disabled={
                  !selected.persisted || commandMutation.isPending || selected.mitigationExcluded
                }
                title={
                  selected.mitigationExcluded
                    ? 'Mitigação desativada administrativamente para este peer'
                    : undefined
                }
                onClick={() => setPendingAction('ACTIVATE')}
              >
                ATIVAR MITIGAÇÃO
              </Button>
              <Button
                compact
                variant="secondary"
                disabled={!selected.persisted || commandMutation.isPending}
                onClick={() => runCommand('SIMULATE_REMOVE', selected.id)}
              >
                SIMULAR RETIRADA
              </Button>
              <Button
                compact
                variant="secondary"
                disabled={!selected.persisted || commandMutation.isPending}
                onClick={() => setPendingAction('REMOVE')}
              >
                RETIRAR MITIGAÇÃO
              </Button>
            </div>
          </div>

          {commandMutation.isPending && (
            <p className="mitigation-loading" role="status">
              Executando em modo simulação…
            </p>
          )}

          {commandResult && (
            <div className="mitigation-result" aria-label="Resultado da execução">
              <h4>
                {commandResult.action === 'REMOVE' || commandResult.action === 'SIMULATE_REMOVE'
                  ? 'SIMULAÇÃO DE RETIRADA CONCLUÍDA'
                  : 'SIMULAÇÃO DE EXECUÇÃO CONCLUÍDA'}
              </h4>
              <p>Modo: MOCK / SIMULAÇÃO</p>
              <p>Status: {commandResult.status}</p>
              {commandResult.safeError && (
                <p className="mitigation-result__error">Erro: {commandResult.safeError}</p>
              )}
              <p>Policy: {commandResult.policy ?? '—'}</p>
              <p>Node: {commandResult.node ?? '—'}</p>
              <p>RT: {commandResult.rt ?? '—'}</p>
              <p>Shared policy: {commandResult.sharedPolicy ? 'sim' : 'não'}</p>
              <p className="mitigation-result__notification">
                Notificação: <strong>{notificationOutcomeLabel(commandResult)}</strong>
              </p>
              <p>Peers afetados: {commandResult.affectedPeers.length}</p>
              <p>Verified: {commandResult.verified ? 'sim' : 'não'}</p>
              <p>Idempotent: {commandResult.idempotent ? 'sim' : 'não'}</p>
              <p>ExecutedAt: {commandResult.executedAt}</p>
              {commandResult.verification && (
                <>
                  <p>Read-back: {commandResult.verified ? 'OK' : 'FALHOU'}</p>
                  <p>Comando de verificação: {commandResult.verification.command}</p>
                  <p>Resultado: {commandResult.verification.summary}</p>
                </>
              )}
              <Button compact variant="secondary" onClick={() => setEvidenceOpen((open) => !open)}>
                {evidenceOpen ? 'OCULTAR EVIDÊNCIA' : 'VER EVIDÊNCIA'}
              </Button>
              {evidenceOpen && (
                <pre className="mitigation-command-preview">
                  {JSON.stringify(
                    {
                      request: {
                        requestId: commandResult.requestId,
                        action: commandResult.action,
                        profileId: commandResult.profileId,
                      },
                      commandPreview: commandResult.commandPreview,
                      verification: commandResult.verification,
                      response: commandResult,
                    },
                    null,
                    2,
                  )}
                </pre>
              )}
            </div>
          )}
          </div>
        </aside>
      )}

      {selected && overrideOpen && (
        <OverrideEditor
          row={selected}
          saving={patchMutation.isPending}
          onCancel={() => setOverrideOpen(false)}
          onSave={(overrideBps) => patchMutation.mutate({ id: selected.id, overrideBps })}
        />
      )}

      {selected && pendingAction && (
        <section className="mitigation-modal" role="dialog" aria-label="Confirmar ação de mitigação">
          <div className="mitigation-modal__body">
            <h3>{pendingAction === 'ACTIVATE' ? 'CONFIRMAR ATIVAÇÃO' : 'CONFIRMAR RETIRADA'}</h3>
            <div className="mitigation-mock-notice" role="status">
              <strong>MODO DE EXECUÇÃO: SIMULAÇÃO / MOCK</strong>
              <span>Nenhum comando será enviado ao equipamento.</span>
            </div>
            {selected.sharedPolicy && (
              <div className="mitigation-shared-policy" role="status">
                <strong>
                  Esta route-policy é compartilhada e a alteração também afetaria:
                </strong>
                <ul>
                  {selected.sharedPolicyTargets.map((target) => (
                    <li key={`${target.interfaceId ?? 'sem'}-${target.peerAddress}`}>
                      {target.customer ?? '—'} · {target.interfaceName ?? '—'} · Peer:{' '}
                      {target.peerAddress}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p>
              <strong>{selected.customer ?? '—'}</strong> · {selected.interfaceName ?? '—'} ·{' '}
              {selected.addressFamily} · {selected.policyName ?? '—'}
            </p>
            <div className="mitigation-modal__actions">
              <Button compact variant="secondary" onClick={() => setPendingAction(null)}>
                CANCELAR
              </Button>
              <Button
                compact
                disabled={commandMutation.isPending}
                onClick={() => runCommand(pendingAction, selected.id)}
              >
                {pendingAction === 'ACTIVATE' ? 'CONFIRMAR ATIVAÇÃO' : 'CONFIRMAR RETIRADA'}
              </Button>
            </div>
          </div>
        </section>
      )}

      {selected && simulateOpen && (
        <SimulationModal
          row={selected}
          running={simulateMutation.isPending}
          simulation={simulation}
          onClose={() => setSimulateOpen(false)}
          onRun={(input) => simulateMutation.mutate({ id: selected.id, ...input })}
        />
      )}
    </section>
  );
}

/**
 * PROTEÇÃO CONTRA MITIGAÇÃO: exclusao administrativa do target. O estado do
 * formulario vive aqui (key={row.id} no pai), sem sincronizacao por efeito.
 */
function ExclusionEditor({
  row,
  saving,
  onSave,
}: {
  row: BgpMitigationProfileDto;
  saving: boolean;
  onSave: (input: {
    excluded: boolean;
    reason: MitigationExclusionReason;
    note: string;
  }) => void;
}) {
  const [excluded, setExcluded] = useState(row.mitigationExcluded === true);
  const [reason, setReason] = useState<MitigationExclusionReason>(
    row.mitigationExclusionReason ?? 'MANUAL',
  );
  const [note, setNote] = useState(row.mitigationExclusionNote ?? '');

  return (
    <div className="mitigation-detail__block mitigation-exclusion">
      <h4>PROTEÇÃO CONTRA MITIGAÇÃO</h4>
      {row.mitigationExcluded ? (
        <p className="mitigation-exclusion__badge" role="status">
          🛡 EXCLUÍDO DA MITIGAÇÃO
          {row.mitigationExclusionReason ? ` · ${exclusionReasonLabel(row.mitigationExclusionReason)}` : ''}
        </p>
      ) : null}
      <label className="mitigation-exclusion__toggle">
        <input
          type="checkbox"
          checked={excluded}
          onChange={(event) => setExcluded(event.target.checked)}
        />
        Nunca mitigar este peer
      </label>
      {excluded ? (
        <>
          <label>
            Motivo
            <select
              aria-label="Motivo da exclusão"
              value={reason}
              onChange={(event) => setReason(event.target.value as MitigationExclusionReason)}
            >
              {EXCLUSION_REASON_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {exclusionReasonLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Observação (opcional)
            <input
              type="text"
              aria-label="Observação da exclusão"
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </>
      ) : null}
      {row.mitigationExcluded && row.mitigationExclusionNote ? (
        <p className="mitigation-modal__hint">Observação: {row.mitigationExclusionNote}</p>
      ) : null}
      {row.mitigationExcluded ? (
        <p className="mitigation-modal__hint">
          Mitigação desativada administrativamente para este peer. Bloqueia NOVO ACTIVATE (UI,
          n8n e AUTO); a retirada de uma mitigação ativa continua permitida.
        </p>
      ) : null}
      <div className="mitigation-actions">
        <Button
          compact
          variant="secondary"
          disabled={!row.persisted || saving}
          onClick={() => onSave({ excluded, reason, note })}
        >
          SALVAR
        </Button>
      </div>
    </div>
  );
}

function OverrideEditor({
  row,
  saving,
  onCancel,
  onSave,
}: {
  row: BgpMitigationProfileDto;
  saving: boolean;
  onCancel: () => void;
  onSave: (overrideBps: string | null) => void;
}) {
  const [value, setValue] = useState(
    String(bpsStringToGbps(row.effectiveBandwidthBps ?? row.detectedBandwidthBps) ?? ''),
  );
  return (
    <section className="mitigation-modal" role="dialog" aria-label="Editar override de banda">
      <div className="mitigation-modal__body">
        <h3>OVERRIDE DE BANDA</h3>
        <p>
          Banda detectada: <strong>{formatBandwidthBps(row.detectedBandwidthBps)}</strong>
        </p>
        <label>
          Override manual (Gbps)
          <input
            aria-label="Override manual em Gbps"
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p className="mitigation-modal__hint">
          A descrição da interface nunca é alterada por este fluxo.
        </p>
        <div className="mitigation-modal__actions">
          <Button compact variant="secondary" onClick={onCancel}>
            CANCELAR
          </Button>
          <Button compact variant="secondary" disabled={saving} onClick={() => onSave(null)}>
            REMOVER OVERRIDE
          </Button>
          <Button
            compact
            disabled={saving || value.trim() === '' || !Number.isFinite(Number(value))}
            onClick={() => onSave(gbpsToBpsString(Number(value)))}
          >
            SALVAR
          </Button>
        </div>
      </div>
    </section>
  );
}

function SimulationModal({
  row,
  running,
  simulation,
  onClose,
  onRun,
}: {
  row: BgpMitigationProfileDto;
  running: boolean;
  simulation: BgpMitigationSimulationDto | null;
  onClose: () => void;
  onRun: (input: { trafficGbps: number; samples: number; prefixCount: number | null }) => void;
}) {
  const [traffic, setTraffic] = useState('38.7');
  const [samples, setSamples] = useState('3');
  const [prefixes, setPrefixes] = useState(row.prefixCount === null ? '' : String(row.prefixCount));

  return (
    <section className="mitigation-modal" role="dialog" aria-label="Simular mitigação">
      <div className="mitigation-modal__body">
        <header className="mitigation-modal__header">
          <h3>SIMULAÇÃO DE MITIGAÇÃO</h3>
          <Button compact variant="secondary" onClick={onClose}>
            FECHAR
          </Button>
        </header>

        <label>
          Tráfego simulado (Gbps)
          <input
            aria-label="Tráfego simulado em Gbps"
            inputMode="decimal"
            value={traffic}
            onChange={(event) => setTraffic(event.target.value)}
          />
        </label>
        <label>
          Número de amostras
          <input
            aria-label="Número de amostras"
            inputMode="numeric"
            value={samples}
            onChange={(event) => setSamples(event.target.value)}
          />
        </label>
        <label>
          Prefixos simulados (opcional)
          <input
            aria-label="Prefixos simulados"
            inputMode="numeric"
            value={prefixes}
            onChange={(event) => setPrefixes(event.target.value)}
          />
        </label>

        <div className="mitigation-modal__actions">
          <Button
            compact
            disabled={
              running || !Number.isFinite(Number(traffic)) || !Number.isFinite(Number(samples))
            }
            onClick={() =>
              onRun({
                trafficGbps: Number(traffic),
                samples: Number(samples),
                prefixCount: prefixes.trim() === '' ? null : Number(prefixes),
              })
            }
          >
            {running ? 'SIMULANDO…' : 'SIMULAR MITIGAÇÃO'}
          </Button>
        </div>

        {simulation && (
          <div className="mitigation-simulation" aria-label="Resultado da simulação">
            <h4>RESULTADO DA SIMULAÇÃO</h4>
            <p>Cliente: {simulation.customer ?? row.customer ?? '—'}</p>
            <p>
              Tráfego: {formatGbps(Number(simulation.simulatedTrafficBps) / BPS_PER_GBPS)} /{' '}
              {formatBandwidthBps(simulation.effectiveBandwidthBps)}
            </p>
            <p>Utilização: {formatPercent(simulation.utilizationPercent)}</p>
            <p>
              Limite: {formatBandwidthBps(simulation.thresholdBps)} /{' '}
              {simulation.thresholdPercent}%
            </p>
            <p>
              Confirmação: {simulation.samples} / {simulation.requiredSamples}
            </p>
            <p>Policy: {simulation.policyName}</p>
            <p>Peers afetados: {simulation.affectedPeers.length}</p>
            <p>
              Prefixos:{' '}
              {simulation.prefixCount === null
                ? `— / ${simulation.prefixLimit}`
                : `${simulation.prefixCount} / ${simulation.prefixLimit}`}{' '}
              {prefixStatusLabel(simulation.prefixStatus)}
            </p>
            <p>Node BOGONS planejado: {simulation.plannedBogonNode ?? '—'}</p>
            <p>Node mitigação planejado: {simulation.plannedMitigationNode ?? simulation.plannedNode ?? '—'}</p>
            <p>Prefix-list BOGONS: {simulation.bogonPrefixList ?? 'BOGONS'}</p>
            <p>Prefix-list mitigação: {simulation.targetPrefixList ?? 'PREFIX8to24'}</p>
            <p>RT: {simulation.mitigationRt}</p>
            {simulation.sharedPolicy && (
              <div className="mitigation-shared-policy" role="status">
                <strong>ATENÇÃO: esta policy é compartilhada.</strong>
                <span>A alteração também afetaria:</span>
                <ul>
                  {simulation.sharedPolicyTargets.map((target) => (
                    <li key={`${target.interfaceId ?? 'sem'}-${target.peerAddress}`}>
                      {target.customer ?? '—'} · {target.interfaceName ?? '—'} · Peer:{' '}
                      {target.peerAddress}
                    </li>
                  ))}
                </ul>
                <p>
                  Peers efetivamente afetados pela policy: {simulation.affectedPolicyPeerCount}
                </p>
              </div>
            )}
            <p className="mitigation-simulation__result">
              Resultado: <strong>{simulationResultLabel(simulation.result)}</strong>
            </p>
            {simulation.blockedReason && (
              <p className="mitigation-simulation__blocked">
                Motivo: {blockReasonLabel(simulation.blockedReason)}
              </p>
            )}

            {simulation.commandPreview.length > 0 && (
              <>
                <h4>COMANDOS QUE SERIAM EXECUTADOS</h4>
                <pre className="mitigation-command-preview">
                  {simulation.commandPreview.join('\n')}
                </pre>
                <p className="mitigation-command-warning">
                  ⚠️ SIMULAÇÃO — Esses comandos NÃO foram enviados ao equipamento.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
