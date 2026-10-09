import type {
  Alarm,
  AlarmMetadata,
  AlarmSeverity,
  NetworkAlarmTestSelectionInput,
  OpticalProximityReference,
} from '@gmj/shared';
import { resolveNetworkAlarmTestSelection } from '@gmj/shared';
import { safeDestination } from '../media/media-secret-box';
import type { MediaChannelPort } from '../media/n8n-media-transport';
import {
  WebhookDeliveryError,
  type MediaDeliveryOutcome,
  type WebhookDeliverySender,
} from '../media/n8n-media-transport';
import type { MediaAlarmTestPort } from '../media/media-integration-service';
import { buildNetworkAlarmTestAlarm } from './alarm-test-fixtures';

/**
 * TRANSPORTE de midia dos alarmes de REDE (purpose NETWORK_ALARMS).
 *
 * F9.5: o canal e resolvido SO por `resolveOutbound('NETWORK_ALARMS')` — nunca
 * pelo canal da mitigacao e nunca pelo ENV legado. O mesmo sender HTTP, o mesmo
 * serializer e o mesmo log operacional da camada de midias atendem os eventos
 * reais (OPENED/ESCALATED/RESOLVED) e o botao TESTAR ALARME (`test: true`).
 */

import {
  isChartableAlarmType,
  type AlarmChartMedia,
  type AlarmChartSource,
  type AlarmChartSpecOptions,
} from '../media/alarm-chart-snapshot';

export const NETWORK_ALARM_EVENTS = [
  'NETWORK_ALARM_OPENED',
  'NETWORK_ALARM_ESCALATED',
  'NETWORK_ALARM_RESOLVED',
] as const;
export type NetworkAlarmEvent = (typeof NETWORK_ALARM_EVENTS)[number];

/** Evento de log do TESTAR ALARME (MediaDeliveryLog.event e String). */
export const NETWORK_ALARM_TEST_EVENT = 'NETWORK_ALARM_TEST' as const;

/** Evento publicado no payload, no contrato que o n8n consome. */
export type NetworkAlarmPublicEvent = 'OPENED' | 'ESCALATED' | 'RESOLVED';

export const NETWORK_ALARM_PUBLIC_EVENT: Record<NetworkAlarmEvent, NetworkAlarmPublicEvent> = {
  NETWORK_ALARM_OPENED: 'OPENED',
  NETWORK_ALARM_ESCALATED: 'ESCALATED',
  NETWORK_ALARM_RESOLVED: 'RESOLVED',
};

/** Inverso: evento publico escolhido no TESTAR ALARME -> chave real do fluxo. */
export const NETWORK_ALARM_EVENT_KEY: Record<NetworkAlarmPublicEvent, NetworkAlarmEvent> = {
  OPENED: 'NETWORK_ALARM_OPENED',
  ESCALATED: 'NETWORK_ALARM_ESCALATED',
  RESOLVED: 'NETWORK_ALARM_RESOLVED',
};

const SEVERITY_RANK: Record<AlarmSeverity, number> = {
  INFO: 1,
  WARNING: 2,
  MAJOR: 3,
  CRITICAL: 4,
};

export interface NetworkAlarmOpticalPayload {
  lane: number | null;
  rxPowerDbm: number | null;
  /** Compatibilidade: ALARM low/high (mesmo valor de `lowAlarmDbm`). */
  lowThresholdDbm: number | null;
  highThresholdDbm: number | null;
  /** HARD (ALARM) â€” nomes explicitos da fase WARNING. */
  lowAlarmDbm: number | null;
  highAlarmDbm: number | null;
  /** WARNING (.20-.23) do transceiver; null quando o equipamento nao publica. */
  lowWarningDbm: number | null;
  highWarningDbm: number | null;
  /** Janela usada no calculo de proximidade (WARNING quando publicada). */
  proximityReference: OpticalProximityReference | null;
  proximityPercent: number | null;
  dropDb: number | null;
  dropWindowMinutes: number | null;
  triggerReasons: string[] | null;
}

/**
 * Payload WHITELIST: apenas campos de exibicao do alarme. Nunca entram
 * community SNMP, senha SSH, DATABASE_URL, token, secret, output bruto de SNMP
 * ou de SSH.
 *
 * O bloco canonico (schemaVersion/purpose/event/test/device/interface/optical)
 * e o contrato novo; os campos flat continuam para nao quebrar o workflow que
 * ja consome os alarmes.
 */
export interface NetworkAlarmWebhookPayload {
  schemaVersion: number;
  purpose: 'NETWORK_ALARMS';
  event: NetworkAlarmPublicEvent;
  test: boolean;
  alarmId: string;
  message: string | null;
  device: { id: string; name: string };
  interface: { id: string; name: string; alias: string };
  metricKey: string | null;
  optical: NetworkAlarmOpticalPayload | null;
  occurredAt: string;
  /** Chave interna do evento: real (OPENED/ESCALATED/RESOLVED) ou NETWORK_ALARM_TEST. */
  eventKey: NetworkAlarmEvent | typeof NETWORK_ALARM_TEST_EVENT;
  /**
   * Severidade ANTERIOR da escalada (so existe quando o evento e ESCALATED e o
   * alarme realmente subiu de nivel). Ausente nos demais eventos, para nao
   * alterar o payload que o n8n ja consome.
   */
  previousSeverity?: AlarmSeverity;
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
  /**
   * Snapshot do gráfico do evento (aditivo). Ausente quando o canal nao esta
   * configurado, o tipo nao tem serie ou a renderizacao falhou — nesses casos o
   * n8n continua com o texto, sem perder nem atrasar o alarme.
   */
  media?: { chart: AlarmChartPayload };
}

/** Campos publicos do snapshot (o resto do estado interno nao vai para o n8n). */
export interface AlarmChartPayload {
  available: boolean;
  url: string | null;
  mimeType: string;
  period: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
}

function toChartPayload(chart: AlarmChartMedia): AlarmChartPayload {
  return {
    available: chart.available,
    url: chart.url,
    mimeType: chart.mimeType,
    period: chart.period,
    generatedAt: chart.generatedAt,
    expiresAt: chart.expiresAt,
  };
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
  options: {
    test?: boolean;
    eventKey?: NetworkAlarmEvent | typeof NETWORK_ALARM_TEST_EVENT;
    chart?: AlarmChartMedia | undefined;
  } = {},
): NetworkAlarmWebhookPayload {
  const metadata = alarm.metadata ?? null;
  const triggerReasons = metadata?.triggerReasons ? [...metadata.triggerReasons] : null;
  const lane = metadataValue(metadata, 'lane');
  const rxPowerDbm = metadataValue(metadata, 'rxPowerDbm');
  const lowThresholdDbm = metadataValue(metadata, 'rxLowAlarmDbm');
  const highThresholdDbm = metadataValue(metadata, 'rxHighAlarmDbm');
  const lowWarningDbm = metadataValue(metadata, 'rxLowWarningDbm');
  const highWarningDbm = metadataValue(metadata, 'rxHighWarningDbm');
  const proximityReference = metadataValue(metadata, 'proximityReference');
  const proximityPercent = metadataValue(metadata, 'proximityPercent');
  const dropDb = metadataValue(metadata, 'trendDropDb');
  const dropWindowMinutes = metadataValue(metadata, 'trendWindowMinutes');
  const hasOptical = [
    lane,
    rxPowerDbm,
    lowThresholdDbm,
    highThresholdDbm,
    lowWarningDbm,
    highWarningDbm,
    proximityReference,
    proximityPercent,
    dropDb,
    dropWindowMinutes,
    triggerReasons,
  ].some((value) => value !== null);
  const publicEvent = NETWORK_ALARM_PUBLIC_EVENT[event];
  const notified = alarm.notifiedSeverity ?? null;
  // Escalada REAL: a severidade ja notificada é a anterior. Nunca entra em
  // OPENED/RESOLVED para o payload existente seguir identico.
  const previousSeverity =
    publicEvent === 'ESCALATED' && notified && SEVERITY_RANK[notified] < SEVERITY_RANK[alarm.severity]
      ? notified
      : null;
  return {
    schemaVersion: 1,
    purpose: 'NETWORK_ALARMS',
    event: publicEvent,
    test: options.test ?? false,
    alarmId: alarm.id,
    message: alarm.message ?? null,
    device: { id: alarm.deviceId, name: alarm.deviceName },
    interface: { id: alarm.interfaceId, name: alarm.interfaceName, alias: alarm.interfaceLabel },
    metricKey: alarm.metricKey ?? null,
    optical: hasOptical
      ? {
          lane,
          rxPowerDbm,
          lowThresholdDbm,
          highThresholdDbm,
          lowAlarmDbm: lowThresholdDbm,
          highAlarmDbm: highThresholdDbm,
          lowWarningDbm,
          highWarningDbm,
          proximityReference,
          proximityPercent,
          dropDb,
          dropWindowMinutes,
          triggerReasons,
        }
      : null,
    occurredAt: alarm.startedAt,
    eventKey: options.eventKey ?? event,
    ...(previousSeverity ? { previousSeverity } : {}),
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
    lane,
    currentValue: alarm.currentValue ?? null,
    thresholdValue: alarm.thresholdValue ?? null,
    unit: alarm.unit ?? null,
    rxPowerDbm,
    rxLowAlarmDbm: lowThresholdDbm,
    rxHighAlarmDbm: highThresholdDbm,
    marginDb: metadataValue(metadata, 'marginDb'),
    proximityPercent,
    trendDropDb: dropDb,
    trendWindowMinutes: dropWindowMinutes,
    triggerReasons,
    currentPowerSource: metadataValue(metadata, 'currentPowerSource'),
    thresholdSource: metadataValue(metadata, 'thresholdSource'),
    startedAt: alarm.startedAt,
    resolvedAt: alarm.endedAt,
    ...(options.chart ? { media: { chart: toChartPayload(options.chart) } } : {}),
  };
}

/**
 * Alarme sintetico do TESTAR ALARME. Nao entra em banco: existe so em memoria,
 * marcado com `test: true` no payload. As fixtures por tipo vivem em
 * `alarm-test-fixtures.ts` e alimentam o MESMO builder dos alarmes reais.
 */
export { buildNetworkAlarmTestAlarm } from './alarm-test-fixtures';

/** Porta usada pelo servico de notificacao (facilita o teste do motor). */
export interface AlarmNotificationTransport {
  publish(event: NetworkAlarmEvent, alarm: Alarm): Promise<MediaDeliveryOutcome>;
}

export interface N8nAlarmTransportDeps {
  media: MediaChannelPort;
  send: WebhookDeliverySender;
  now?: () => Date;
  /**
   * Snapshot do gráfico do evento. Falha aqui NUNCA bloqueia o envio: o
   * payload sai sem `media.chart` (fallback texto-only). As opções só existem
   * no caminho TESTAR ALARME (`source` = interface real do histórico).
   */
  chartSnapshot?:
    | ((
        payload: NetworkAlarmWebhookPayload,
        options?: AlarmChartSpecOptions,
      ) => Promise<AlarmChartMedia>)
    | undefined;
}

export class N8nAlarmTransport implements AlarmNotificationTransport, MediaAlarmTestPort {
  private readonly now: () => Date;

  constructor(private readonly deps: N8nAlarmTransportDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Caminho dos alarmes REAIS (OPENED/ESCALATED/RESOLVED). */
  async publish(event: NetworkAlarmEvent, alarm: Alarm): Promise<MediaDeliveryOutcome> {
    return this.deliverAlarm(
      event,
      alarm,
      alarm.ruleId ?? null,
      buildNetworkAlarmWebhookPayload(alarm, event),
      { includeChart: true },
    );
  }

  /**
   * TESTAR ALARME: o MESMO serializer, o MESMO transporte e o MESMO sender dos
   * alarmes reais, trocando apenas o canal resolvido (NETWORK_ALARMS) e a
   * fixture sintetica (`test: true`, eventKey NETWORK_ALARM_TEST). O campo
   * `event` do payload reflete a selecao (OPENED/ESCALATED/RESOLVED), o tipo e a
   * severidade escolhidos. Nao cria linha em Alarm/OperationalOccurrence, nao
   * roda SNMP e nao altera badge nenhum.
   */
  async publishAlarmTest(
    input: {
      profileId?: string | null;
      includeChart?: boolean;
      /** Interface REAL usada SO como fonte do historico do PNG. */
      chartSource?: AlarmChartSource | null;
    } & NetworkAlarmTestSelectionInput = {},
  ): Promise<MediaDeliveryOutcome> {
    const selection = resolveNetworkAlarmTestSelection(input);
    const alarm = buildNetworkAlarmTestAlarm(selection, this.now());
    return this.deliverAlarm(
      NETWORK_ALARM_TEST_EVENT,
      alarm,
      input.profileId ?? null,
      buildNetworkAlarmWebhookPayload(alarm, NETWORK_ALARM_EVENT_KEY[selection.event], {
        test: true,
        eventKey: NETWORK_ALARM_TEST_EVENT,
      }),
      {
        includeChart: input.includeChart ?? false,
        chartSource: input.chartSource ?? null,
        test: true,
      },
    );
  }

  /**
   * Snapshot opcional do grafico. `includeChart: false` (default do TESTAR
   * ALARME) nem chama o renderer; qualquer excecao vira ausencia do bloco.
   */
  private async chartMedia(
    payload: NetworkAlarmWebhookPayload,
    options: { includeChart?: boolean; chartSource?: AlarmChartSource | null; test?: boolean },
  ): Promise<AlarmChartMedia | null> {
    const snapshot = this.deps.chartSnapshot;
    if (!snapshot || !options.includeChart || !isChartableAlarmType(payload.type)) return null;
    const snapshotOptions: AlarmChartSpecOptions = {
      ...(options.chartSource ? { source: options.chartSource } : {}),
      ...(options.test ? { test: true } : {}),
    };
    try {
      const media = await snapshot(payload, snapshotOptions);
      return media.available ? media : null;
    } catch {
      return null;
    }
  }

  private async deliverAlarm(
    event: string,
    alarm: Alarm,
    profileId: string | null,
    payload: NetworkAlarmWebhookPayload,
    options: { includeChart?: boolean; chartSource?: AlarmChartSource | null; test?: boolean } = {},
  ): Promise<MediaDeliveryOutcome> {
    // F9.5: somente o canal NETWORK_ALARMS (sem fallback cruzado).
    const channel = await this.deps.media.resolveOutbound('NETWORK_ALARMS');
    const destination = safeDestination(channel.url);
    const requestId = alarm.id;

    if (!channel.enabled || !channel.url) {
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event,
        profileId,
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

    const chart = await this.chartMedia(payload, options);
    const outgoing = chart ? { ...payload, media: { chart: toChartPayload(chart) } } : payload;

    await this.deps.media.recordOutboundAttempt({
      integrationId: channel.integrationId,
      event,
      profileId,
      requestId,
      destination,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(channel.token ? { 'X-NetVision-Token': channel.token } : {}),
    };

    try {
      const result = await this.deps.send(channel.url, outgoing, headers);
      await this.deps.media.recordOutboundDelivery({
        integrationId: channel.integrationId,
        event,
        profileId,
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
        profileId,
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
