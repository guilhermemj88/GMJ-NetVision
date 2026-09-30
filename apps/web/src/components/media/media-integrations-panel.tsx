'use client';

import { useEffect, useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Copy,
  KeyRound,
  LoaderCircle,
  Power,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useMapStore } from '@/store/map-store';
import {
  MEDIA_SOURCE_LABELS,
  MEDIA_STATUS_LABELS,
  createMediaIntegration,
  getMediaIntegrations,
  getRecentMediaLogs,
  rotateMediaInboundToken,
  testMediaWebhook,
  updateMediaIntegration,
  type MediaWebhookTestResult,
} from '@/lib/media-api';

const PURPOSE = 'BGP_MITIGATION' as const;
const DEFAULT_NAME = 'n8n — Mitigação DDoS';

/**
 * CONFIGURAÇÕES → MÍDIAS.
 *
 * Uma tela por integração de notificação (hoje só o n8n da mitigação DDoS).
 * Nenhum segredo é exibido depois de salvo: apenas "configurado: sim/não".
 * O token de entrada aparece UMA vez, logo após a rotação.
 */
export function MediaIntegrationsPanel() {
  const setPanel = useMapStore((state) => state.setPanel);
  const queryClient = useQueryClient();

  const overviewQuery = useQuery({
    queryKey: ['media-integrations'],
    queryFn: getMediaIntegrations,
  });
  const outboundQuery = useQuery({
    queryKey: ['media-logs', 'OUTBOUND'],
    queryFn: () => getRecentMediaLogs({ direction: 'OUTBOUND', limit: 20 }),
  });
  const inboundQuery = useQuery({
    queryKey: ['media-logs', 'INBOUND'],
    queryFn: () => getRecentMediaLogs({ direction: 'INBOUND', limit: 20 }),
  });

  const integration = overviewQuery.data?.integration ?? null;
  const legacy = overviewQuery.data?.legacyEnv ?? null;
  const migrationReady = overviewQuery.data?.migrationReady ?? true;

  const [urlDraft, setUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [testResult, setTestResult] = useState<MediaWebhookTestResult | null>(null);
  const [newInboundToken, setNewInboundToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const integrationUrl = integration?.outboundUrl ?? null;
  const integrationId = integration?.id ?? null;
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

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error('Salve a configuração antes de testar');
      return testMediaWebhook(integration.id);
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
        event: 'MITIGATION_TEST',
        checkedAt: new Date().toISOString(),
      });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: async () => {
      if (!integration) throw new Error('Salve a configuração antes de gerar o token');
      return rotateMediaInboundToken(integration.id);
    },
    onSuccess: (result) => {
      setNewInboundToken(result.token);
      setCopied(false);
      refresh();
    },
  });

  /**
   * Liga/desliga o OUTBOUND sem tocar em URL/token. Sem isso a tela mostrava
   * "Ativo: NÃO" e nao oferecia como reativar (a integracao so voltava a valer
   * recriando-a).
   */
  const enabledToggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!integration) throw new Error('Salve a configuração antes de ativar/desativar');
      return updateMediaIntegration(integration.id, { enabled });
    },
    onSuccess: refresh,
  });

  const inboundToggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!integration) throw new Error('Salve a configuração antes de alterar o inbound');
      return updateMediaIntegration(integration.id, { inboundEnabled: enabled });
    },
    onSuccess: refresh,
  });

  const importMutation = useMutation({
    mutationFn: () =>
      createMediaIntegration({
        name: DEFAULT_NAME,
        purpose: PURPOSE,
        importFromEnv: true,
        inboundEnabled: true,
      }),
    onSuccess: refresh,
  });

  const busy =
    saveMutation.isPending ||
    testMutation.isPending ||
    rotateMutation.isPending ||
    enabledToggle.isPending ||
    inboundToggle.isPending ||
    importMutation.isPending;

  return (
    <div
      className="panel-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && setPanel(null)}
    >
      <section
        className="action-panel action-panel--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Mídias"
      >
        <header>
          <div>
            <span>CONFIGURAÇÕES · MÍDIAS</span>
            <h2>n8n — Mitigação DDoS</h2>
          </div>
          <button type="button" aria-label="Fechar" onClick={() => setPanel(null)}>
            <X size={18} />
          </button>
        </header>

        <div className="panel-body media-panel">
          {!migrationReady ? (
            <div className="panel-note media-panel__warn">
              <TriangleAlert size={17} />
              <span>
                Migration da camada de mídias ainda não aplicada neste ambiente: a configuração
                fica em memória e é perdida ao reiniciar a API. O ENV continua valendo como
                fallback.
              </span>
            </div>
          ) : null}

          <h3>STATUS</h3>
          <div className="media-status">
            <div>
              <span>Ativo</span>
              <strong>{integration ? (integration.enabled ? 'SIM' : 'NÃO') : '—'}</strong>
            </div>
            <div>
              <span>Outbound configurado</span>
              <strong>
                {integration?.outboundTokenConfigured || legacy?.outboundUrlConfigured ? 'SIM' : 'NÃO'}
              </strong>
            </div>
            <div>
              <span>Inbound configurado</span>
              <strong>
                {integration?.inboundConfigured || legacy?.inboundTokenConfigured ? 'SIM' : 'NÃO'}
              </strong>
            </div>
            <div>
              <span>Configuração</span>
              <strong>
                {MEDIA_SOURCE_LABELS[
                  integration?.configSource ?? (legacy?.outboundUrlConfigured ? 'ENV' : 'NONE')
                ]}
              </strong>
            </div>
            <div>
              <span>Último envio</span>
              <strong>{formatStamp(integration?.lastOutboundAttemptAt ?? null)}</strong>
            </div>
            <div>
              <span>Resultado</span>
              <strong>
                {integration
                  ? MEDIA_STATUS_LABELS[integration.status]
                  : legacy?.outboundUrlConfigured
                    ? 'ENV / LEGACY · nunca testado'
                    : MEDIA_STATUS_LABELS.NOT_CONFIGURED}
              </strong>
            </div>
            <div>
              <span>Último evento</span>
              <strong>{integration?.lastOutboundEvent ?? '—'}</strong>
            </div>
            <div>
              <span>Último comando recebido</span>
              <strong>
                {integration?.lastInboundAction
                  ? `${integration.lastInboundAction} · ${formatStamp(integration.lastInboundAt)}`
                  : '—'}
              </strong>
            </div>
          </div>

          {!integration && legacy?.outboundUrlConfigured ? (
            <div className="media-panel__actions">
              <Button variant="secondary" onClick={() => importMutation.mutate()} disabled={busy}>
                <ArrowDownToLine size={15} /> IMPORTAR PARA CONFIGURAÇÃO
              </Button>
              <small>
                Existe configuração no ENV (legado). Importar copia URL e token para a configuração
                editável.
              </small>
            </div>
          ) : null}

          <h3>
            <ArrowUpFromLine size={14} /> OUTBOUND — NetVision → n8n
          </h3>
          <div className="media-form">
            <label>
              <span>Webhook URL</span>
              <input
                type="url"
                value={urlDraft}
                onChange={(event) => setUrlDraft(event.target.value)}
                placeholder="https://n8n.exemplo.com/webhook/netvision"
              />
            </label>
            <label>
              <span>Token (X-NetVision-Token)</span>
              <input
                type={tokenVisible ? 'text' : 'password'}
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder={integration?.outboundTokenConfigured ? '••••••••••••' : 'não configurado'}
                aria-label="Token outbound"
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
                    ? 'Desliga o envio outbound (mantém URL e token)'
                    : 'Liga o envio outbound com a URL/token atuais'
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
                <Send size={15} /> TESTAR WEBHOOK
              </Button>
            </div>
            <p className="media-panel__hint">
              O token nunca é reexibido depois de salvo e nunca vai na URL — só no header.
            </p>
            {tokenVisible ? (
              <p className="media-panel__hint">
                Digite o novo token no campo acima e clique SALVAR. O token anterior deixa de valer.
              </p>
            ) : null}
            {testResult ? <TestResultBanner result={testResult} /> : null}
          </div>

          <h3>
            <ArrowDownToLine size={14} /> INBOUND — n8n → NetVision
          </h3>
          <div className="media-form">
            <label>
              <span>Endpoint</span>
              <input
                type="text"
                readOnly
                value={integration?.inboundEndpointPath ?? legacy?.inboundEndpointPath ?? ''}
              />
            </label>
            <div className="media-inbound">
              <div>
                <span>Token</span>
                <strong>
                  {integration?.inboundTokenConfigured || legacy?.inboundTokenConfigured
                    ? 'CONFIGURADO'
                    : 'NÃO CONFIGURADO'}
                </strong>
              </div>
              <div>
                <span>Inbound</span>
                <strong>{integration?.inboundEnabled ? 'ATIVADO' : 'DESATIVADO'}</strong>
              </div>
              <div className="media-panel__actions">
                <Button
                  variant="secondary"
                  onClick={() => rotateMutation.mutate()}
                  disabled={busy || !integration}
                >
                  <RefreshCw size={15} /> GERAR NOVO TOKEN
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => inboundToggle.mutate(!(integration?.inboundEnabled ?? false))}
                  disabled={busy || !integration}
                >
                  {integration?.inboundEnabled ? 'DESATIVAR' : 'ATIVAR'}
                </Button>
              </div>
            </div>
            {newInboundToken ? (
              <div className="media-token-once" role="status">
                <strong>Novo token gerado. Copie agora.</strong>
                <span>Ele não será exibido novamente — atualize o n8n com este valor.</span>
                <code>{newInboundToken}</code>
                <div className="media-panel__actions">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void copyText(newInboundToken).then(() => setCopied(true));
                    }}
                  >
                    <Copy size={15} /> {copied ? 'COPIADO' : 'COPIAR'}
                  </Button>
                  <Button variant="ghost" onClick={() => setNewInboundToken(null)}>
                    OCULTAR
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <h3>ÚLTIMAS ENTREGAS</h3>
          <LogTable
            empty="Nenhuma tentativa de envio registrada."
            rows={(outboundQuery.data ?? []).map((log) => ({
              key: log.id,
              when: log.createdAt,
              label: log.event ?? '—',
              detail: log.destination ?? '',
              result:
                log.httpStatus !== null ? `HTTP ${log.httpStatus}` : (log.safeError ?? log.status),
              duration: log.latencyMs !== null ? `${log.latencyMs} ms` : '',
              ok: log.status === 'SUCCESS',
            }))}
          />

          <h3>ÚLTIMOS COMANDOS</h3>
          <LogTable
            empty="Nenhum comando recebido do n8n."
            rows={(inboundQuery.data ?? []).map((log) => ({
              key: log.id,
              when: log.createdAt,
              label: log.action ?? '—',
              detail: log.profileId ?? '',
              result: log.safeError ?? log.status,
              duration: log.idempotent ? 'idempotente' : '',
              ok: log.status === 'SUCCESS',
            }))}
          />

          <div className="panel-note">
            <ShieldCheck size={17} />
            <span>
              Tokens são guardados com AES-256-GCM e nunca voltam ao navegador. O n8n continua
              responsável pelo Telegram.
            </span>
          </div>
        </div>

        <footer>
          <Button variant="ghost" onClick={() => setPanel(null)}>
            Fechar
          </Button>
        </footer>
      </section>
    </div>
  );
}

function TestResultBanner({ result }: { result: MediaWebhookTestResult }) {
  if (result.ok) {
    return (
      <div className="media-test media-test--ok" role="status">
        <Send size={17} />
        Webhook enviado com sucesso
        {result.httpStatus !== null ? <Badge tone="info">HTTP {result.httpStatus}</Badge> : null}
        {result.latencyMs !== null ? <span>{result.latencyMs} ms</span> : null}
      </div>
    );
  }
  return (
    <div className="media-test media-test--fail" role="status">
      <TriangleAlert size={17} />
      {result.httpStatus !== null ? `Falha no webhook · HTTP ${result.httpStatus}` : 'Falha no webhook'}
      {result.safeError ? <span>{result.safeError}</span> : null}
    </div>
  );
}

interface LogRow {
  key: string;
  when: string;
  label: string;
  detail: string;
  result: string;
  duration: string;
  ok: boolean;
}

function LogTable({ rows, empty }: { rows: LogRow[]; empty: string }) {
  if (rows.length === 0) return <p className="media-panel__hint">{empty}</p>;
  return (
    <table className="media-log">
      <thead>
        <tr>
          <th>QUANDO</th>
          <th>REFERÊNCIA</th>
          <th>RESULTADO</th>
          <th>DURAÇÃO</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={row.ok ? '' : 'is-failed'}>
            <td>{formatStamp(row.when)}</td>
            <td>
              <strong>{row.label}</strong>
              {row.detail ? <small>{row.detail}</small> : null}
            </td>
            <td>{row.result}</td>
            <td>{row.duration}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatStamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard indisponível (contexto sem permissão): o token segue na tela.
  }
}
