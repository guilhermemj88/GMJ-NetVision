'use client';

import { useEffect, useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, KeyRound, LoaderCircle, Power, Search, Send, ShieldOff, TriangleAlert, X } from 'lucide-react';
import { alarmTypeLabel, isChartableAlarmType, type Alarm, type InterfaceSearchResult, type NetworkAlarmTestEvent, type NetworkAlarmTestSeverity, type NetworkAlarmTestType } from '@gmj/shared';
import {
  NETWORK_ALARM_TEST_DEFAULT_SEVERITY,
  NETWORK_ALARM_TEST_EVENTS,
  NETWORK_ALARM_TEST_SEVERITIES,
  NETWORK_ALARM_TEST_TYPES,
  NETWORK_ALARM_TEST_TYPE_LABELS,
} from '@gmj/shared';
import { useAlarmIndex } from '@/lib/use-alarms';
import { searchInterfaces } from '@/lib/api';
import {
  MEDIA_SOURCE_LABELS,
  MEDIA_STATUS_LABELS,
  createMediaIntegration,
  getMediaIntegrationsByPurpose,
  getRecentMediaLogs,
  testMediaAlarm,
  updateMediaIntegration,
  type MediaDeliveryLogDto,
  type MediaIntegrationsOverview,
  type MediaWebhookTestResult,
} from '@/lib/media-api';

const PURPOSE = 'NETWORK_ALARMS' as const;
const DEFAULT_NAME = 'n8n — Alarmes de Rede';

/**
 * Somente eventos do purpose NETWORK_ALARMS entram nesta tela. O canal de
 * alarmes é INDEPENDENTE da mitigação DDoS (F9.5): nada aqui mostra, copia ou
 * compartilha URL/token da mitigação — e não existe bloco INBOUND.
 */
export function isNetworkAlarmEvent(event: string | null | undefined): boolean {
  return Boolean(event && event.startsWith('NETWORK_ALARM'));
}

/**
 * Referencia legivel do alarme a partir do `requestId` do log (que e o id do
 * alarme): equipamento, interface, tipo e severidade. Sem alarme conhecido
 * (historico antigo) mostra apenas o evento, nunca um payload bruto.
 */
export function alarmLogReference(
  log: MediaDeliveryLogDto,
  alarmsById: Map<string, Alarm>,
): string {
  const alarm = log.requestId ? alarmsById.get(log.requestId) : undefined;
  if (!alarm) return '';
  const lane = alarm.metadata?.lane == null ? '' : ` · Lane ${alarm.metadata.lane}`;
  return `${alarm.deviceName} · ${alarm.interfaceName}${lane} · ${alarmTypeLabel(alarm.type)} · ${alarm.severity}`;
}

export interface AlarmTestDraft {
  type: NetworkAlarmTestType;
  event: NetworkAlarmTestEvent;
  severity: NetworkAlarmTestSeverity;
  /** INCLUIR GRÁFICO: default OFF; liga o snapshot no payload de teste. */
  includeChart: boolean;
  /**
   * Interface REAL que empresta o histórico para o PNG (F9.5.2). Vale SOMENTE
   * no caminho de teste: o texto do alarme continua sendo a fixture e nenhum
   * estado operacional é criado.
   */
  chartInterfaceId: string | null;
}

/**
 * Simulador do TESTAR ALARME (F9.5.1): trocar o TIPO reposiciona a severidade
 * no default daquele tipo (o operador ainda pode escolher outra para testar
 * formatacao). O evento nunca altera a severidade.
 */
export function alarmTestDraftAfterTypeChange(
  draft: AlarmTestDraft,
  type: NetworkAlarmTestType,
): AlarmTestDraft {
  return { ...draft, type, severity: NETWORK_ALARM_TEST_DEFAULT_SEVERITY[type] };
}

const DEFAULT_ALARM_TEST_DRAFT: AlarmTestDraft = {
  type: 'INTERFACE_DOWN',
  event: 'OPENED',
  severity: NETWORK_ALARM_TEST_DEFAULT_SEVERITY.INTERFACE_DOWN,
  includeChart: false,
  chartInterfaceId: null,
};

/** O teste pediu gráfico E o tipo tem série histórica para desenhar. */
export function alarmTestNeedsChartInterface(draft: AlarmTestDraft): boolean {
  return draft.includeChart && isChartableAlarmType(draft.type);
}

/** Rótulo do resultado da busca: equipamento · interface · alias. */
export function chartSourceLabel(result: InterfaceSearchResult): string {
  const host = result.hostname || result.deviceName;
  return [host, result.interfaceName, result.alias].filter(Boolean).join(' · ');
}

/**
 * Seletor da INTERFACE DE REFERÊNCIA DO GRÁFICO: busca server-side no MESMO
 * endpoint do inventário usado pela busca global (debounce de 250 ms, limite de
 * 40 itens). Nada é carregado em massa e a escolha vive só na tela.
 */
export function AlarmTestChartSourceField({
  selected,
  onSelect,
  disabled,
}: {
  selected: InterfaceSearchResult | null;
  onSelect: (result: InterfaceSearchResult | null) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setDebouncedQuery('');
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(normalized), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const resultsQuery = useQuery({
    queryKey: ['interface-search', debouncedQuery],
    queryFn: () => searchInterfaces(debouncedQuery, 40),
    enabled: !disabled && debouncedQuery.length >= 2,
    staleTime: 15_000,
  });
  const results = resultsQuery.data ?? [];

  const choose = (result: InterfaceSearchResult) => {
    onSelect(result);
    setQuery('');
    setDebouncedQuery('');
  };

  if (selected) {
    return (
      <div className="media-test-sim__source" data-testid="chart-source-selected">
        <span className="media-test-sim__source-value">{chartSourceLabel(selected)}</span>
        <Button
          variant="ghost"
          onClick={() => onSelect(null)}
          disabled={disabled}
          aria-label="Remover interface de referência do gráfico"
        >
          <X size={14} /> REMOVER
        </Button>
      </div>
    );
  }

  return (
    <div className="media-test-sim__source">
      <Search size={14} />
      <input
        value={query}
        aria-label="Buscar interface de referência do gráfico"
        placeholder="Equipamento, interface, alias, ifIndex ou IP"
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      {resultsQuery.isFetching ? <LoaderCircle className="spin" size={14} /> : null}
      {debouncedQuery.length >= 2 ? (
        <div className="media-test-sim__source-results" role="listbox" aria-label="Interfaces encontradas">
          {resultsQuery.isError ? (
            <p className="media-panel__hint">Não foi possível consultar o inventário.</p>
          ) : results.length === 0 && !resultsQuery.isFetching ? (
            <p className="media-panel__hint">Nenhuma interface encontrada.</p>
          ) : (
            results.map((result) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={result.interfaceId}
                onClick={() => choose(result)}
              >
                <strong>{result.hostname || result.deviceName}</strong>
                <span>{result.interfaceName}</span>
                {result.alias ? <small>{result.alias}</small> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Linha compacta TIPO / EVENTO / SEVERIDADE + botao do simulador. */
export function AlarmTestSimulator({
  draft,
  onChange,
  chartSource,
  onChartSourceChange,
  onTest,
  disabled,
}: {
  draft: AlarmTestDraft;
  onChange: (draft: AlarmTestDraft) => void;
  chartSource: InterfaceSearchResult | null;
  onChartSourceChange: (result: InterfaceSearchResult | null) => void;
  onTest: () => void;
  disabled: boolean;
}) {
  const needsChartSource = alarmTestNeedsChartInterface(draft);
  const missingChartSource = needsChartSource && draft.chartInterfaceId === null;

  return (
    <div className="media-test-sim">
      <div className="media-test-sim__row">
        <label>
          <span>TIPO DE TESTE</span>
          <select
            aria-label="Tipo de teste do alarme"
            value={draft.type}
            onChange={(event) =>
              onChange(alarmTestDraftAfterTypeChange(draft, event.target.value as NetworkAlarmTestType))
            }
          >
            {NETWORK_ALARM_TEST_TYPES.map((type) => (
              <option key={type} value={type}>
                {type} — {NETWORK_ALARM_TEST_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>EVENTO</span>
          <select
            aria-label="Evento do alarme de teste"
            value={draft.event}
            onChange={(event) =>
              onChange({ ...draft, event: event.target.value as NetworkAlarmTestEvent })
            }
          >
            {NETWORK_ALARM_TEST_EVENTS.map((event) => (
              <option key={event} value={event}>
                {event}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>SEVERIDADE</span>
          <select
            aria-label="Severidade do alarme de teste"
            value={draft.severity}
            onChange={(event) =>
              onChange({ ...draft, severity: event.target.value as NetworkAlarmTestSeverity })
            }
          >
            {NETWORK_ALARM_TEST_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </label>
        <label className="media-test-sim__toggle">
          <input
            type="checkbox"
            aria-label="Incluir gráfico no alarme de teste"
            checked={draft.includeChart}
            onChange={(event) => onChange({ ...draft, includeChart: event.target.checked })}
          />
          <span>INCLUIR GRÁFICO [{draft.includeChart ? 'ON' : 'OFF'}]</span>
        </label>
        <Button
          variant="ghost"
          onClick={onTest}
          disabled={disabled || missingChartSource}
          title={
            missingChartSource
              ? 'Selecione a interface de referência do gráfico antes de testar'
              : undefined
          }
        >
          <Send size={15} /> TESTAR ALARME
        </Button>
      </div>
      {needsChartSource ? (
        <div className="media-test-sim__row media-test-sim__row--source">
          <span className="media-test-sim__row-label">INTERFACE DE REFERÊNCIA DO GRÁFICO</span>
          <AlarmTestChartSourceField
            selected={chartSource}
            onSelect={(result) => {
              onChartSourceChange(result);
              onChange({ ...draft, chartInterfaceId: result?.interfaceId ?? null });
            }}
            disabled={disabled}
          />
        </div>
      ) : null}
      <p className="media-panel__hint">
        Simulação: não cria alarme no NetVision.
        {needsChartSource
          ? ' Com gráfico: selecione uma interface real acima; somente o histórico dela será usado no PNG. O alarme de teste continua sintético e não cria estado operacional.'
          : draft.includeChart
            ? ' Este tipo de alarme não tem série histórica: o teste sai somente com o texto.'
            : ''}
      </p>
    </div>
  );
}

/** Banner do TESTAR ALARME (sucesso/falha), sem payload nem token. */
export function AlarmTestResultBanner({ result }: { result: MediaWebhookTestResult }) {
  if (result.ok) {
    return (
      <div className="media-test media-test--ok" role="status">
        <Send size={17} />
        Webhook de alarme enviado com sucesso
        {result.httpStatus !== null ? <Badge tone="info">HTTP {result.httpStatus}</Badge> : null}
        {result.latencyMs !== null ? <span>{result.latencyMs} ms</span> : null}
      </div>
    );
  }
  // `safeError` e a mensagem mais util (validacao do grafico, canal nao
  // configurado); o HTTP so entra quando existe resposta do destino.
  const headline =
    result.httpStatus !== null
      ? `Falha no webhook de alarmes · HTTP ${result.httpStatus}`
      : (result.safeError ?? (result.skipped ? 'Webhook de alarmes não configurado' : 'Falha no webhook de alarmes'));
  return (
    <div className="media-test media-test--fail" role="status">
      <TriangleAlert size={17} />
      {headline}
      {result.httpStatus !== null && result.safeError ? <span>{result.safeError}</span> : null}
    </div>
  );
}

/** Status do canal de alarmes: sem inbound, sem "último comando". */
export function alarmStatusRows(overview: MediaIntegrationsOverview | null) {
  const integration = overview?.integration ?? null;
  const outboundConfigured = Boolean(integration?.outboundUrl || integration?.outboundTokenConfigured);
  return [
    { label: 'Ativo', value: integration ? (integration.enabled ? 'SIM' : 'NÃO') : '—' },
    { label: 'Outbound configurado', value: outboundConfigured ? 'SIM' : 'NÃO' },
    {
      label: 'Configuração',
      value: integration ? MEDIA_SOURCE_LABELS[integration.configSource] : MEDIA_SOURCE_LABELS.NONE,
    },
    { label: 'Último envio', value: formatStamp(integration?.lastOutboundAttemptAt ?? null) },
    {
      label: 'Resultado',
      value: integration ? MEDIA_STATUS_LABELS[integration.status] : MEDIA_STATUS_LABELS.NOT_CONFIGURED,
    },
    { label: 'Último evento', value: integration?.lastOutboundEvent ?? '—' },
  ];
}

export function NetworkAlarmsMediaSection() {
  const queryClient = useQueryClient();
  const overviewQuery = useQuery({
    queryKey: ['media-integrations', PURPOSE],
    queryFn: () => getMediaIntegrationsByPurpose(PURPOSE),
  });
  const integration = overviewQuery.data?.integration ?? null;
  const integrationId = integration?.id ?? null;
  const migrationReady = overviewQuery.data?.migrationReady ?? true;
  const logsQuery = useQuery({
    // Log da PROPRIA integracao: entregas de mitigacao nunca aparecem aqui.
    queryKey: ['media-logs', PURPOSE, integrationId],
    queryFn: () => getRecentMediaLogs(
      { direction: 'OUTBOUND', limit: 30 },
      integrationId ?? undefined,
    ),
    refetchInterval: 30_000,
  });
  const alarmIndex = useAlarmIndex(true);

  const [urlDraft, setUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [testResult, setTestResult] = useState<MediaWebhookTestResult | null>(null);
  // Simulador do TESTAR ALARME (F9.5.1): escolha local, nada e persistido.
  const [testDraft, setTestDraft] = useState<AlarmTestDraft>(DEFAULT_ALARM_TEST_DRAFT);
  // Interface real escolhida para o histórico do PNG (rotulo da tela; a
  // requisicao envia apenas o id do draft).
  const [chartSource, setChartSource] = useState<InterfaceSearchResult | null>(null);

  const integrationUrl = integration?.outboundUrl ?? null;
  useEffect(() => {
    setUrlDraft(integrationUrl ?? '');
  }, [integrationUrl, integrationId]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['media-integrations'] });
    void queryClient.invalidateQueries({ queryKey: ['media-logs'] });
    void queryClient.invalidateQueries({ queryKey: ['media-summary'] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = urlDraft.trim() ? urlDraft.trim() : null;
      const token = tokenDraft.trim() ? tokenDraft.trim() : undefined;
      if (!integration) {
        return createMediaIntegration({
          name: DEFAULT_NAME,
          purpose: PURPOSE,
          outboundUrl: url,
          ...(token ? { outboundToken: token } : {}),
        });
      }
      return updateMediaIntegration(integration.id, {
        outboundUrl: url,
        ...(token ? { outboundToken: token } : {}),
      });
    },
    onSuccess: () => {
      setTokenDraft('');
      setTokenVisible(false);
      refresh();
    },
  });

  const enabledToggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!integration) throw new Error('Salve a configuração antes de ativar/desativar');
      return updateMediaIntegration(integration.id, { enabled });
    },
    onSuccess: refresh,
  });

  const testMutation = useMutation({
    mutationFn: async (draft: AlarmTestDraft) => {
      if (!integration) throw new Error('Salve a configuração antes de testar');
      return testMediaAlarm(integration.id, {
        type: draft.type,
        event: draft.event,
        severity: draft.severity,
        includeChart: draft.includeChart,
        // So vai no corpo quando existe: a API valida a interface no inventario.
        ...(draft.chartInterfaceId ? { chartInterfaceId: draft.chartInterfaceId } : {}),
      });
    },
    onSuccess: (result) => {
      setTestResult(result);
      refresh();
    },
    onError: (error: unknown) => {
      setTestResult({
        ok: false,
        skipped: false,
        httpStatus: null,
        latencyMs: null,
        safeError: error instanceof Error ? error.message : 'Falha ao testar o webhook',
        event: 'NETWORK_ALARM_TEST',
        checkedAt: new Date().toISOString(),
      });
    },
  });

  const busy = saveMutation.isPending || enabledToggle.isPending || testMutation.isPending;
  // Blindagem extra (F9.5): mesmo que a rota devolva algo misturado, a aba de
  // alarmes nunca mostra evento de mitigacao.
  const logs = (logsQuery.data ?? []).filter((log) => isNetworkAlarmEvent(log.event));
  const statusRows = alarmStatusRows(overviewQuery.data ?? null);

  return (
    <>
      <h3>
        <BellRing size={14} /> ALARMES DE REDE
      </h3>
      {!migrationReady ? (
        <div className="panel-note media-panel__warn">
          <TriangleAlert size={17} />
          <span>
            Migration da camada de mídias ainda não aplicada neste ambiente: a configuração fica em
            memória e é perdida ao reiniciar a API.
          </span>
        </div>
      ) : null}

      <h3>STATUS</h3>
      <div className="media-status">
        {statusRows.map((row) => (
          <div key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
      <div className="panel-note">
        <ShieldOff size={17} />
        <span>
          Canal exclusivo dos alarmes: este webhook não recebe nada da Mitigação DDoS e não possui
          inbound. Tokens são independentes e nunca são exibidos depois de salvos.
        </span>
      </div>

      <h3>
        <Send size={14} /> OUTBOUND — NetVision → n8n
      </h3>
      <div className="media-form">
        <label>
          <span>Webhook URL</span>
          <input
            type="url"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="https://n8n.exemplo.com/webhook/netvision-network-alarms"
          />
        </label>
        <label>
          <span>Token (X-NetVision-Token)</span>
          <input
            type={tokenVisible ? 'text' : 'password'}
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder={integration?.outboundTokenConfigured ? '••••••••••••' : 'não configurado'}
            aria-label="Token outbound de alarmes"
          />
        </label>
        <div className="media-panel__actions">
          <Button variant="primary" onClick={() => saveMutation.mutate()} disabled={busy}>
            {saveMutation.isPending ? <LoaderCircle size={15} /> : null}
            SALVAR
          </Button>
          <Button
            variant="secondary"
            onClick={() => setTokenVisible((value) => !value)}
            disabled={busy}
          >
            <KeyRound size={15} /> {tokenVisible ? 'OCULTAR' : 'ALTERAR TOKEN'}
          </Button>
          <Button
            variant={integration?.enabled ? 'secondary' : 'primary'}
            onClick={() => enabledToggle.mutate(!(integration?.enabled ?? false))}
            disabled={busy || !integration}
            title={
              integration?.enabled
                ? 'Desliga o envio de alarmes (mantém URL e token)'
                : 'Liga o envio de alarmes com a URL/token atuais'
            }
          >
            {enabledToggle.isPending ? <LoaderCircle size={15} /> : <Power size={15} />}{' '}
            {integration?.enabled ? 'DESATIVAR' : 'ATIVAR'}
          </Button>
        </div>
        <AlarmTestSimulator
          draft={testDraft}
          onChange={setTestDraft}
          chartSource={chartSource}
          onChartSourceChange={setChartSource}
          onTest={() => testMutation.mutate(testDraft)}
          disabled={busy || !integration}
        />
        <p className="media-panel__hint">
          O TESTAR ALARME usa o MESMO payload dos alarmes reais (com <code>test: true</code>), não
          cria alarme e não mexe na mitigação.
        </p>
        {tokenVisible ? (
          <p className="media-panel__hint">
            Digite o novo token no campo acima e clique SALVAR. O token anterior deixa de valer.
          </p>
        ) : null}
        {testResult ? <AlarmTestResultBanner result={testResult} /> : null}
      </div>

      <h3>ÚLTIMAS ENTREGAS</h3>
      {logs.length === 0 ? (
        <p className="media-panel__hint">
          Nenhuma entrega de alarme registrada. Eventos OPENED/ESCALATED/RESOLVED aparecem aqui
          quando a regra tem mídia habilitada.
        </p>
      ) : (
        <table className="media-log">
          <thead>
            <tr>
              <th>QUANDO</th>
              <th>EVENTO / ALARME</th>
              <th>RESULTADO</th>
              <th>LATÊNCIA</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const reference = alarmLogReference(log, alarmIndex);
              return (
                <tr key={log.id} className={log.status === 'SUCCESS' ? '' : 'is-failed'}>
                  <td>{formatStamp(log.createdAt)}</td>
                  <td>
                    <strong>{log.event ?? '—'}</strong>
                    {reference ? <small>{reference}</small> : null}
                  </td>
                  <td>
                    {log.httpStatus !== null ? (
                      <Badge tone={log.status === 'SUCCESS' ? 'info' : 'neutral'}>
                        HTTP {log.httpStatus}
                      </Badge>
                    ) : (
                      (log.safeError ?? log.status)
                    )}
                  </td>
                  <td>{log.latencyMs !== null ? `${log.latencyMs} ms` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="media-panel__hint">
        O log mostra evento, alarme, status, HTTP e latência — nunca credenciais, endereços de
        webhook ou payload bruto.
      </p>
    </>
  );
}

export function formatStamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
