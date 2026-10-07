import type { Alarm, AlarmMetadata } from '@gmj/shared';
import { safeDestination } from '../media/media-secret-box';
import type { MediaChannelPort } from '../media/n8n-media-transport';
import {
  WebhookDeliveryError,
  type MediaDeliveryOutcome,
  type WebhookDeliverySender,
} from '../media/n8n-media-transport';

/**
 * TRANSPORTE de midia dos alarmes de REDE (purpose NETWORK_ALARMS).
 *
 * Reutiliza integralmente a camada de midias: o canal e resolvido por
 * `resolveOutbound` (integracao explicita > canal COMPARTILHADO do
 * BGP_MITIGATION > ENV), o token vem decriptado da propria resolucao (nunca e
 * copiado entre registros) e a entrega entra no MESMO log operacional.
 */

export const NETWORK_ALARM_EVENTS = [
  'NETWORK_ALARM_OPENED',
  'NETWORK_ALARM_ESCALATED',
  'NETWORK_ALARM_RESOLVED',
] as const;
export type NetworkAlarmEvent = (typeof NETWORK_ALARM_EVENTS)[number];

/**
 * Payload WHITELIST: apenas campos de exibicao do alarme. Nunca entram
 * community SNMP, senha SSH, DATABASE_URL, token, secret, output bruto de SNMP
 * ou de SSH.
 */
export interface NetworkAlarmWebhookPayload {
  event: NetworkAlarmEvent;
  alarmId: string;
  ruleId: string | null;
  type: string;
  severity: string;
  deviceId: string;
  deviceName: string;
  interfaceId: string;
  interfaceName: string;
  interfaceLabel: string;
  speedBps: number | null;
  linkId: string | null;
  linkLabel: string | null;
  direction: string | null;
  lane: number | null;
  currentValue: number | null;
  thresholdValue: number | null;
  unit: string | null;
  rxPowerDbm: number | null;
  rxLowAlarmDbm: number | null;
  rxHighAlarmDbm: number | null;
  marginDb: number | null;
  proximityPercent: number | null;
  trendDropDb: number | null;
  trendWindowMinutes: number | null;
  /** Motivos aplicaveis da avaliacao optica (ex.: RAPID_DROP + PROXIMITY). */
  triggerReasons: string[] | null;
  currentPowerSource: string | null;
  thresholdSource: string | null;
  startedAt: string;
  resolvedAt: string | null;
}

function metadataValue<K extends keyof AlarmMetadata>(
  metadata: AlarmMetadata | null | undefined,
  key: K,
): NonNullable<AlarmMetadata[K]> | null {
  const value = metadata?.[key];
  return value === undefined || value === null ? null : (value as NonNullable<AlarmMetadata[K]>);
}

export function buildNetworkAlarmWebhookPayload(
  alarm: Alarm,
  event: NetworkAlarmEvent,
): NetworkAlarmWebhookPayload {
  const metadata = alarm.metadata ?? null;
  return {
    event,
    alarmId: alarm.id,
    ruleId: alarm.ruleId ?? null,
    type: alarm.type,
    severity: alarm.severity,
    deviceId: alarm.deviceId,
    deviceName: alarm.deviceName,
    interfaceId: alarm.interfaceId,
    interfaceName: alarm.interfaceName,
    interfaceLabel: alarm.interfaceLabel,
    speedBps: metadataValue(metadata, 'speedBps'),
    linkId: alarm.linkId,
    linkLabel: alarm.linkLabel,
    direction: metadataValue(metadata, 'direction'),
    lane: metadataValue(metadata, 'lane'),
    currentValue: alarm.currentValue ?? null,
    thresholdValue: alarm.thresholdValue ?? null,
    unit: alarm.unit ?? null,
    rxPowerDbm: metadataValue(metadata, 'rxPowerDbm'),
    rxLowAlarmDbm: metadataValue(metadata, 'rxLowAlarmDbm'),
    rxHighAlarmDbm: metadataValue(metadata, 'rxHighAlarmDbm'),
    marginDb: metadataValue(metadata, 'marginDb'),
    proximityPercent: metadataValue(metadata, 'proximityPercent'),
    trendDropDb: metadataValue(metadata, 'trendDropDb'),
    trendWindowMinutes: metadataValue(metadata, 'trendWindowMinutes'),
    triggerReasons: metadata?.triggerReasons ? [...metadata.triggerReasons] : null,
    currentPowerSource: metadataValue(metadata, 'currentPowerSource'),
    thresholdSource: metadataValue(metadata, 'thresholdSource'),
    startedAt: alarm.startedAt,
    resolvedAt: alarm.endedAt,
  };
}

/** Porta usada pelo servico de notificacao (facilita o teste do motor). */
export interface AlarmNotificationTransport {
  publish(event: NetworkAlarmEvent, alarm: Alarm): Promise<MediaDeliveryOutcome>;
}

export interface N8nAlarmTransportDeps {
  media: MediaChannelPort;
  send: WebhookDeliverySender;
}

export class N8nAlarmTransport implements AlarmNotificationTransport {
  constructor(private readonly deps: N8nAlarmTransportDeps) {}

  async publish(event: NetworkAlarmEvent, alarm: Alarm): Promise<MediaDeliveryOutcome> {
    const channel = await this.deps.media.resolveOutbound('NETWORK_ALARMS', 'BGP_MITIGATION');
    const destination = safeDestination(channel.url);
    const requestId = alarm.id;

    if (!channel.enabled || !channel.url) {
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event,
        profileId: alarm.ruleId ?? null,
        requestId,
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
        event,
      };
    }

    await this.deps.media.recordOutboundAttempt({
      integrationId: channel.integrationId,
      event,
      profileId: alarm.ruleId ?? null,
      requestId,
      destination,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(channel.token ? { 'X-NetVision-Token': channel.token } : {}),
    };

    try {
      const result = await this.deps.send(
        channel.url,
        buildNetworkAlarmWebhookPayload(alarm, event),
        headers,
      );
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event,
        profileId: alarm.ruleId ?? null,
        requestId,
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
        event,
      };
    } catch (error) {
      const delivery = error instanceof WebhookDeliveryError
        ? error
        : new WebhookDeliveryError('webhook', null, null, 'Falha ao chamar o webhook');
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event,
        profileId: alarm.ruleId ?? null,
        requestId,
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
        event,
      };
    }
  }
}
