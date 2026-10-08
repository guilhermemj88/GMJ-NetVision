'use client';

import { useEffect, useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, KeyRound, LoaderCircle, Power, Send, ShieldOff, TriangleAlert } from 'lucide-react';
import { alarmTypeLabel, type Alarm } from '@gmj/shared';
import { useAlarmIndex } from '@/lib/use-alarms';
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
  return (
    <div className="media-test media-test--fail" role="status">
      <TriangleAlert size={17} />
      {result.skipped
        ? 'Webhook de alarmes não configurado'
        : result.httpStatus !== null
          ? `Falha no webhook de alarmes · HTTP ${result.httpStatus}`
          : 'Falha no webhook de alarmes'}
      {result.safeError ? <span>{result.safeError}</span> : null}
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
    mutationFn: async () => {
      if (!integration) throw new Error('Salve a configuração antes de testar');
      return testMediaAlarm(integration.id);
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
          <Button
            variant="ghost"
            onClick={() => testMutation.mutate()}
            disabled={busy || !integration}
          >
            <Send size={15} /> TESTAR ALARME
          </Button>
        </div>
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
