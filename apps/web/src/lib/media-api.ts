// Cliente HTTP da camada de MÍDIAS (Fase 9).
//
// Nenhuma função devolve segredo: o backend só informa
// `outboundTokenConfigured` / `inboundTokenConfigured`. A única exceção é
// `rotateInboundToken`, que mostra o token novo UMA vez para o operador
// copiar — depois disso ele não é recuperável pela UI.

import type { NetworkAlarmTestSelectionInput } from '@gmj/shared';
import { request } from './api';

export type MediaOperationalStatus =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'NEVER_TESTED'
  | 'LAST_DELIVERY_OK'
  | 'LAST_DELIVERY_FAILED';

export type MediaConfigSource = 'DATABASE' | 'ENV' | 'MEMORY' | 'NONE';

export type MediaIntegrationPurpose = 'BGP_MITIGATION' | 'NETWORK_ALARMS';

export interface MediaIntegrationDto {
  id: string;
  name: string;
  type: 'WEBHOOK';
  purpose: MediaIntegrationPurpose;
  enabled: boolean;
  configSource: MediaConfigSource;
  status: MediaOperationalStatus;
  outboundConfigured: boolean;
  outboundUrl: string | null;
  outboundTokenConfigured: boolean;
  inboundEnabled: boolean;
  inboundConfigured: boolean;
  inboundTokenConfigured: boolean;
  inboundEndpointPath: string;
  lastOutboundAttemptAt: string | null;
  lastOutboundSuccessAt: string | null;
  lastOutboundFailureAt: string | null;
  lastOutboundStatusCode: number | null;
  lastOutboundLatencyMs: number | null;
  lastOutboundEvent: string | null;
  lastOutboundErrorSafe: string | null;
  lastInboundAt: string | null;
  lastInboundAction: string | null;
  lastInboundStatus: string | null;
  lastInboundRequestId: string | null;
  lastInboundErrorSafe: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaIntegrationsOverview {
  repositoryKind: 'DATABASE' | 'MEMORY';
  migrationReady: boolean;
  /** Canal DESTE purpose quando configurado e ligado (nunca o de outro purpose). */
  resolvedPurpose: MediaIntegrationPurpose | null;
  legacyEnv: {
    outboundUrlConfigured: boolean;
    outboundTokenConfigured: boolean;
    inboundTokenConfigured: boolean;
    inboundEndpointPath: string;
  };
  integration: MediaIntegrationDto | null;
}

export interface MediaDeliveryLogDto {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND';
  event: string | null;
  action: string | null;
  profileId: string | null;
  requestId: string | null;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  httpStatus: number | null;
  latencyMs: number | null;
  idempotent: boolean | null;
  safeError: string | null;
  destination: string | null;
  createdAt: string;
}

export interface MediaWebhookTestResult {
  ok: boolean;
  skipped: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  safeError: string | null;
  event: string;
  checkedAt: string;
}

export interface MediaSummary {
  configured: boolean;
  outboundConfigured: boolean;
  inboundConfigured: boolean;
  status: MediaOperationalStatus;
  configSource: MediaConfigSource;
  repositoryKind: 'DATABASE' | 'MEMORY';
  migrationReady: boolean;
  lastOutboundAt: string | null;
  lastOutboundStatusCode: number | null;
  lastInboundAt: string | null;
  lastInboundAction: string | null;
}

export function getMediaIntegrations(): Promise<MediaIntegrationsOverview> {
  return request<MediaIntegrationsOverview>('/api/media/integrations');
}

/** Overview de outro purpose (ex.: NETWORK_ALARMS informa o canal compartilhado). */
export function getMediaIntegrationsByPurpose(
  purpose: MediaIntegrationPurpose,
): Promise<MediaIntegrationsOverview> {
  const params = new URLSearchParams({ purpose });
  return request<MediaIntegrationsOverview>(`/api/media/integrations?${params.toString()}`);
}

export function getMediaSummary(): Promise<MediaSummary> {
  return request<MediaSummary>('/api/media/summary');
}

export function createMediaIntegration(input: {
  name: string;
  purpose: MediaIntegrationPurpose;
  enabled?: boolean;
  outboundUrl?: string | null;
  outboundToken?: string;
  inboundEnabled?: boolean;
  importFromEnv?: boolean;
}): Promise<MediaIntegrationDto> {
  return request<MediaIntegrationDto>('/api/media/integrations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateMediaIntegration(
  id: string,
  input: {
    name?: string;
    enabled?: boolean;
    outboundUrl?: string | null;
    outboundToken?: string;
    clearOutboundToken?: boolean;
    inboundEnabled?: boolean;
  },
): Promise<MediaIntegrationDto> {
  return request<MediaIntegrationDto>(`/api/media/integrations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function testMediaWebhook(id: string): Promise<MediaWebhookTestResult> {
  return request<MediaWebhookTestResult>(`/api/media/integrations/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  });
}

/**
 * TESTAR ALARME (F9.5): envia o payload sintetico pelo canal NETWORK_ALARMS,
 * com a mesma serializacao dos alarmes reais. Nunca toca na mitigacao.
 * F9.5.1: a selecao (tipo/evento/severidade) vai no corpo; sem ela vale o
 * default do simulador. `includeChart` (default OFF) liga o snapshot do
 * gráfico no payload de teste, usando uma interface real so como fonte de
 * histórico; `chartInterfaceId` escolhe essa interface.
 */
export function testMediaAlarm(
  id: string,
  selection?: NetworkAlarmTestSelectionInput & {
    includeChart?: boolean;
    chartInterfaceId?: string | null;
  },
): Promise<MediaWebhookTestResult> {
  return request<MediaWebhookTestResult>(
    `/api/media/integrations/${encodeURIComponent(id)}/test-alarm`,
    {
      method: 'POST',
      ...(selection ? { body: JSON.stringify(selection) } : {}),
    },
  );
}

export function rotateMediaInboundToken(
  id: string,
): Promise<{ token: string; integration: MediaIntegrationDto; warning: string }> {
  return request<{ token: string; integration: MediaIntegrationDto; warning: string }>(
    `/api/media/integrations/${encodeURIComponent(id)}/rotate-inbound-token`,
    { method: 'POST' },
  );
}

export function getMediaLogs(
  id: string,
  options: { direction?: 'OUTBOUND' | 'INBOUND'; limit?: number } = {},
): Promise<MediaDeliveryLogDto[]> {
  return getRecentMediaLogs(options, id);
}

/**
 * Log operacional global da camada de mídias. É o que a tela usa: entregas
 * feitas com a configuração legada do ENV não pertencem a nenhuma integração.
 */
export function getRecentMediaLogs(
  options: { direction?: 'OUTBOUND' | 'INBOUND'; limit?: number } = {},
  integrationId?: string,
): Promise<MediaDeliveryLogDto[]> {
  const params = new URLSearchParams();
  if (options.direction) params.set('direction', options.direction);
  params.set('limit', String(options.limit ?? 20));
  const path = integrationId
    ? `/api/media/integrations/${encodeURIComponent(integrationId)}/logs`
    : '/api/media/logs';
  return request<MediaDeliveryLogDto[]>(`${path}?${params.toString()}`);
}

export const MEDIA_STATUS_LABELS: Record<MediaOperationalStatus, string> = {
  DISABLED: 'Desativado',
  NOT_CONFIGURED: 'Não configurado',
  NEVER_TESTED: 'Configurado · nunca testado',
  LAST_DELIVERY_OK: 'Último envio OK',
  LAST_DELIVERY_FAILED: 'Erro no último envio',
};

export const MEDIA_SOURCE_LABELS: Record<MediaConfigSource, string> = {
  DATABASE: 'BANCO',
  ENV: 'ENV / LEGACY',
  MEMORY: 'MEMÓRIA (temporário)',
  NONE: 'NÃO CONFIGURADO',
};
