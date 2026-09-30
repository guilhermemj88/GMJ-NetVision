import type {
  MitigationNotification,
  NotificationPublisher,
  NotificationPublishResult,
} from '../bgp/mitigation/notification-publisher';
import {
  buildMitigationWebhookPayload,
  type MitigationWebhookPayload,
} from '../bgp/mitigation/mitigation-webhook';
import type { MediaIntegrationPurpose, ResolvedMediaChannel } from './media-types';

/**
 * TRANSPORTE da midia WEBHOOK (n8n).
 *
 * Este arquivo NAO e o dominio: ele implementa a porta `NotificationPublisher`
 * resolvendo URL/token pela camada de MIDIAS (banco > ENV) e registrando a
 * tentativa no log operacional. O mesmo caminho e usado pelo botao
 * TESTAR WEBHOOK — nao existe HTTP paralelo so para teste.
 */

export interface WebhookDeliveryResult {
  httpStatus: number;
  latencyMs: number;
}

/** Erro de entrega com status/duracao, para o log operacional. */
export class WebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly latencyMs: number | null,
    readonly safeError: string,
  ) {
    super(message);
    this.name = 'WebhookDeliveryError';
  }
}

export type WebhookDeliverySender = (
  url: string,
  payload: MitigationWebhookPayload,
  headers: Record<string, string>,
) => Promise<WebhookDeliveryResult>;

/**
 * Sender real: HTTP POST com timeout. O token vai em HEADER
 * (`X-NetVision-Token`), nunca na URL/query.
 */
export function createFetchWebhookSender(
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): WebhookDeliverySender {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return async (url, payload, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        throw new WebhookDeliveryError(
          `HTTP ${response.status}`,
          response.status,
          latencyMs,
          `Webhook respondeu HTTP ${response.status}`,
        );
      }
      return { httpStatus: response.status, latencyMs };
    } catch (error) {
      if (error instanceof WebhookDeliveryError) throw error;
      const latencyMs = Date.now() - started;
      const aborted = (error as { name?: string } | null)?.name === 'AbortError';
      throw new WebhookDeliveryError(
        aborted ? 'timeout' : 'network',
        null,
        latencyMs,
        aborted ? 'Timeout ao chamar o webhook' : 'Falha de rede ao chamar o webhook',
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface MediaDeliveryOutcome {
  ok: boolean;
  skipped: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  safeError: string | null;
  event: string;
}

/** Porta minima que o transporte precisa da camada de midias. */
export interface MediaChannelPort {
  resolveOutbound(purpose: MediaIntegrationPurpose): Promise<ResolvedMediaChannel>;
  recordOutboundAttempt(input: {
    integrationId: string | null;
    event: string;
    profileId: string | null;
    requestId: string | null;
    destination: string | null;
  }): Promise<void>;
  recordOutboundDelivery(input: {
    integrationId: string | null;
    event: string;
    profileId: string | null;
    requestId: string | null;
    destination: string | null;
    ok: boolean;
    httpStatus: number | null;
    latencyMs: number | null;
    safeError: string | null;
  }): Promise<void>;
}

export interface N8nMediaTransportDeps {
  media: MediaChannelPort;
  send: WebhookDeliverySender;
  now?: () => Date;
}

export class N8nMediaTransport implements NotificationPublisher {
  private readonly now: () => Date;

  constructor(private readonly deps: N8nMediaTransportDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Caminho OUTBOUND do motor de mitigacao (best-effort). */
  async publish(notification: MitigationNotification): Promise<NotificationPublishResult> {
    const outcome = await this.deliver({
      event: notification.event,
      profileId: notification.profileId ?? null,
      requestId: notification.eventId ?? null,
      payload: buildMitigationWebhookPayload(notification),
    });
    return { published: outcome.ok, skipped: outcome.skipped };
  }

  /** TESTAR WEBHOOK: mesmo transporte, payload de teste, nada de mitigacao real. */
  async publishTest(input: {
    customer?: string;
    policy?: string;
    rt?: string;
    node?: number | null;
    profileId?: string | null;
  } = {}): Promise<MediaDeliveryOutcome> {
    const notification: MitigationNotification = {
      event: 'MITIGATION_TEST',
      simulation: true,
      eventId: `test-${this.now().toISOString()}`,
      profileId: input.profileId ?? null,
      addressFamily: 'IPV4',
      sharedPolicy: false,
      sharedPolicyTargets: [],
      occurredAt: this.now().toISOString(),
      customer: input.customer ?? 'TESTE',
      device: 'GMJ NetVision',
      interfaceName: null,
      peer: null,
      affectedPeers: [],
      detectedBandwidthBps: null,
      bandwidthOverrideBps: null,
      effectiveBandwidthBps: null,
      trafficBps: null,
      thresholdBps: null,
      policy: input.policy ?? 'PL-TEST',
      node: input.node ?? 1,
      rt: input.rt ?? '268568:660',
      verified: null,
    };
    return this.deliver({
      event: notification.event,
      profileId: notification.profileId ?? null,
      requestId: notification.eventId ?? null,
      payload: buildMitigationWebhookPayload(notification),
    });
  }

  private async deliver(input: {
    event: string;
    profileId: string | null;
    requestId: string | null;
    payload: MitigationWebhookPayload;
  }): Promise<MediaDeliveryOutcome> {
    const channel = await this.deps.media.resolveOutbound('BGP_MITIGATION');
    const destination = safeHost(channel.url);
    if (!channel.enabled || !channel.url) {
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event: input.event,
        profileId: input.profileId,
        requestId: input.requestId,
        destination,
        ok: false,
        httpStatus: null,
        latencyMs: null,
        safeError: 'Webhook não configurado',
      });
      return {
        ok: false,
        skipped: true,
        httpStatus: null,
        latencyMs: null,
        safeError: 'Webhook não configurado',
        event: input.event,
      };
    }

    await this.deps.media.recordOutboundAttempt({
      integrationId: channel.integrationId,
      event: input.event,
      profileId: input.profileId,
      requestId: input.requestId,
      destination,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(channel.token ? { 'X-NetVision-Token': channel.token } : {}),
    };

    try {
      const result = await this.deps.send(channel.url, input.payload, headers);
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event: input.event,
        profileId: input.profileId,
        requestId: input.requestId,
        destination,
        ok: true,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        safeError: null,
      });
      return {
        ok: true,
        skipped: false,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        safeError: null,
        event: input.event,
      };
    } catch (error) {
      const delivery =
        error instanceof WebhookDeliveryError
          ? error
          : new WebhookDeliveryError('webhook', null, null, 'Falha ao chamar o webhook');
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event: input.event,
        profileId: input.profileId,
        requestId: input.requestId,
        destination,
        ok: false,
        httpStatus: delivery.httpStatus,
        latencyMs: delivery.latencyMs,
        safeError: delivery.safeError,
      });
      return {
        ok: false,
        skipped: false,
        httpStatus: delivery.httpStatus,
        latencyMs: delivery.latencyMs,
        safeError: delivery.safeError,
        event: input.event,
      };
    }
  }
}

/** Apenas scheme://host: URL de webhook nao deve vazar path/query no log. */
function safeHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
