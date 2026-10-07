'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@gmj/ui';
import { BellRing, ShieldCheck } from 'lucide-react';
import { alarmTypeLabel, type Alarm } from '@gmj/shared';
import { useAlarmIndex } from '@/lib/use-alarms';
import {
  MEDIA_SOURCE_LABELS,
  MEDIA_STATUS_LABELS,
  getMediaIntegrationsByPurpose,
  getRecentMediaLogs,
  type MediaDeliveryLogDto,
  type MediaIntegrationsOverview,
} from '@/lib/media-api';

/**
 * Somente eventos do purpose NETWORK_ALARMS entram nesta tela: o canal pode
 * ser compartilhado com a mitigação, mas o log de mitigação não é de alarme.
 */
export function isNetworkAlarmEvent(event: string | null | undefined): boolean {
  return Boolean(event && event.startsWith('NETWORK_ALARM'));
}

export interface AlarmChannelDescription {
  /** Texto curto do canal efetivo (o que o operador precisa saber). */
  channel: string;
  /** Detalhe tecnico safe: purpose resolvido, origem da configuracao. */
  detail: string;
  /** true quando o canal efetivo e o compartilhado da mitigacao DDoS. */
  shared: boolean;
}

/**
 * Traduz o overview do backend F7 (`resolvedPurpose`/`shared`) para a tela:
 * canal proprio, canal compartilhado com a mitigacao, ENV ou nao configurado.
 */
export function describeAlarmChannel(overview: MediaIntegrationsOverview): AlarmChannelDescription {
  const integration = overview.integration;
  const envConfigured = overview.legacyEnv.outboundUrlConfigured;
  if (overview.shared && overview.resolvedPurpose) {
    return {
      channel: 'Canal compartilhado com Mitigação DDoS',
      detail: `resolvedPurpose=${overview.resolvedPurpose} · shared=true`,
      shared: true,
    };
  }
  if (integration && integration.configSource === 'DATABASE') {
    return {
      channel: 'Canal próprio',
      detail: `purpose=${integration.purpose} · banco`,
      shared: false,
    };
  }
  if (envConfigured) {
    return {
      channel: 'ENV (legado)',
      detail: 'URL/token vindos das variáveis de ambiente',
      shared: false,
    };
  }
  return {
    channel: 'NÃO CONFIGURADO',
    detail: 'entregas deste purpose são puladas (SKIPPED)',
    shared: false,
  };
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

export function NetworkAlarmsMediaSection() {
  const overviewQuery = useQuery({
    queryKey: ['media-integrations', 'NETWORK_ALARMS'],
    queryFn: () => getMediaIntegrationsByPurpose('NETWORK_ALARMS'),
    refetchInterval: 30_000,
  });
  const logsQuery = useQuery({
    queryKey: ['media-logs', 'NETWORK_ALARMS'],
    queryFn: () => getRecentMediaLogs({ direction: 'OUTBOUND', limit: 50 }),
    refetchInterval: 30_000,
  });
  const alarmIndex = useAlarmIndex(true);

  const overview = overviewQuery.data ?? null;
  const integration = overview?.integration ?? null;
  const channel = overview ? describeAlarmChannel(overview) : null;
  const logs = (logsQuery.data ?? []).filter((log) => isNetworkAlarmEvent(log.event));

  return (
    <>
      <h3>
        <BellRing size={14} /> ALARMES DE REDE
      </h3>
      <div className="media-status">
        <div>
          <span>Ativo</span>
          <strong>{integration ? (integration.enabled ? 'SIM' : 'NÃO') : channel?.shared ? 'SIM (compartilhado)' : '—'}</strong>
        </div>
        <div>
          <span>Mídia</span>
          <strong>{integration ? integration.type.toLowerCase() : 'n8n (canal compartilhado)'}</strong>
        </div>
        <div>
          <span>Canal</span>
          <strong>{channel?.channel ?? '—'}</strong>
        </div>
        <div>
          <span>Detalhe</span>
          <strong>{channel?.detail ?? '—'}</strong>
        </div>
        <div>
          <span>Configuração</span>
          <strong>
            {integration
              ? MEDIA_SOURCE_LABELS[integration.configSource]
              : channel?.shared
                ? 'BANCO (canal da mitigação)'
                : MEDIA_SOURCE_LABELS.NONE}
          </strong>
        </div>
        <div>
          <span>Última entrega</span>
          <strong>
            {integration
              ? MEDIA_STATUS_LABELS[integration.status]
              : logs[0]
                ? logs[0].status
                : 'Nunca'}
          </strong>
        </div>
      </div>
      {channel?.shared ? (
        <div className="panel-note">
          <ShieldCheck size={17} />
          <span>
            Este purpose não tem integração própria: os eventos de alarme usam o MESMO canal da
            Mitigação DDoS (resolvedPurpose={overview?.resolvedPurpose}). Nenhuma credencial é
            copiada ou exibida nesta tela.
          </span>
        </div>
      ) : null}

      <h3>ENTREGAS DE ALARMES (NETWORK_ALARMS)</h3>
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
