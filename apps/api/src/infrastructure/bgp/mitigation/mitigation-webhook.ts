import type {
  MitigationNotification,
  NotificationPublisher,
  NotificationPublishResult,
} from './notification-publisher';

/**
 * ADAPTADOR DE TRANSPORTE (n8n). Não é o domínio.
 *
 * O motor de mitigação só conhece a porta `NotificationPublisher`; este arquivo
 * é a implementação concreta que fala HTTP com o n8n. A futura camada de MÍDIAS
 * pode adicionar outros transportes (Telegram, e-mail, ...) sem tocar no domínio.
 *
 * O payload de transporte usa Gbps apenas como representação de exibição; a
 * fonte canônica dentro do domínio continua sendo bps.
 */

export interface MitigationWebhookPayload {
  event: MitigationNotification['event'];
  simulation: boolean;
  customer: string | null;
  device: string | null;
  interface: string | null;
  peer: string | null;
  affectedPeers: string[];
  bandwidthGbps: number | null;
  trafficGbps: number | null;
  thresholdGbps: number | null;
  /**
   * R5-8: mesma medida em Mbps. Abaixo de 1 Gbps o campo Gbps arredonda para
   * 0; o transporte deve exibir Mbps nesse caso (nunca "0 Gbps").
   */
  trafficMbps: number | null;
  thresholdMbps: number | null;
  policy: string | null;
  /** Compatibilidade com consumidores antigos (= mitigationNode). */
  node: number | null;
  bogonNode: number | null;
  mitigationNode: number | null;
  rt: string | null;
  verified: boolean | null;
  /** Campos novos (Fase 7) - os antigos continuam identicos. */
  eventId: string | null;
  profileId: string | null;
  addressFamily: string | null;
  sharedPolicy: boolean;
  sharedPolicyTargets: {
    interfaceName: string | null;
    peerAddress: string | null;
    customer: string | null;
    addressFamily: string | null;
  }[];
  occurredAt: string | null;
  /** S5 (deteccao bloqueada): episodio, motivo, direcao e campos ausentes. */
  episodeId: string | null;
  blockedReason: string | null;
  direction: 'rx' | 'tx' | null;
  directionSource: string | null;
  fieldsUnavailable: string[];
  /**
   * ESCOPO VERIFICADO: prefixos reais recebidos do cliente. `null` = sem
   * evidencia completa (`fieldsUnavailable` contem `'prefixes'`). Aditivo: os
   * consumidores antigos ignoram o campo.
   */
  prefixes: string[] | null;
  /**
   * INFORMATIVO (n8n): analise de crescimento do trafego antes do limiar.
   * Nunca participa de decisao, gate, lease ou estado ENFORCE. Ausente em
   * eventos antigos — consumidores antigos ignoram o campo.
   */
  growth?: GrowthWebhookBlock | null;
}

export type GrowthClassificationDto = 'BRUSCO' | 'MODERADO' | 'GRADUAL_OU_ESTAVEL' | 'INDETERMINADO';

export interface GrowthWebhookBlock {
  baselineAverage5mPct: number | null;
  currentUtilizationPct: number | null;
  deltaPercentagePoints: number | null;
  delta30sPercentagePoints: number | null;
  growthClassification: GrowthClassificationDto;
  samples5m: number;
  samples30s: number;
  /** Limiar REAL do perfil; nunca fixo no codigo. */
  thresholdPct: number | null;
  thresholdReachedAt: string | null;
  trafficDirection: 'rx' | 'tx' | null;
  /**
   * Nunca inferido de utilizacao alta: so existe estado real por tras.
   * `SIMULACAO` cobre observacao sem escrita BGP.
   */
  mitigationStatus: 'APLICADA' | 'NAO_APLICADA' | 'SIMULACAO' | 'DESCONHECIDA';
  mitigationReason: string | null;
  /** Mensagem humana pronta para o canal. */
  message: string;
}

/** Mensagem humana do alerta — sem afirmar mitigacao que nao ocorreu. */
export function buildGrowthMessage(input: {
  customer: string | null;
  currentUtilizationPct: number | null;
  baselineAverage5mPct: number | null;
  deltaPercentagePoints: number | null;
  growthClassification: GrowthClassificationDto;
  mitigationStatus: GrowthWebhookBlock['mitigationStatus'];
}): string {
  const who = input.customer ?? 'Cliente';
  const now = input.currentUtilizationPct === null ? '—' : `${input.currentUtilizationPct}%`;
  const before =
    input.baselineAverage5mPct === null ? '—' : `${input.baselineAverage5mPct}%`;
  const delta =
    input.deltaPercentagePoints === null
      ? '—'
      : `${input.deltaPercentagePoints >= 0 ? '+' : ''}${input.deltaPercentagePoints}`;
  const classification =
    input.growthClassification === 'GRADUAL_OU_ESTAVEL'
      ? 'GRADUAL'
      : input.growthClassification;
  const status =
    input.mitigationStatus === 'APLICADA'
      ? 'Mitigação aplicada.'
      : input.mitigationStatus === 'SIMULACAO'
        ? 'Alerta confirmado — mitigação não executada (simulação).'
        : 'Alerta confirmado — mitigação não executada.';
  return (
    `${who} atingiu ${now} da banda contratada. ` +
    `Média anterior de 5 minutos: ${before}. ` +
    `Variação: ${delta} pontos percentuais. ` +
    `Crescimento: ${classification}. ` +
    `Motivo: limiar de utilização atingido. ${status}`
  );
}

/** O sender recebe os headers prontos: o token vai em HEADER, nunca na URL. */
export type WebhookSender = (
  url: string,
  payload: MitigationWebhookPayload,
  headers: Record<string, string>,
) => Promise<void>;

function toMbps(bps: bigint | null): number | null {
  if (bps === null) return null;
  return Math.round((Number(bps) / 1_000_000) * 100) / 100;
}

function toGbps(bps: bigint | null): number | null {
  if (bps === null) return null;
  return Math.round((Number(bps) / 1_000_000_000) * 100) / 100;
}

/** Converte uma notificação canônica (bps) no payload de exibição do n8n. */
export function buildMitigationWebhookPayload(
  notification: MitigationNotification,
): MitigationWebhookPayload {
  return {
    event: notification.event,
    simulation: notification.simulation,
    customer: notification.customer,
    device: notification.device,
    interface: notification.interfaceName,
    peer: notification.peer,
    affectedPeers: notification.affectedPeers,
    bandwidthGbps: toGbps(notification.effectiveBandwidthBps),
    trafficGbps: toGbps(notification.trafficBps),
    thresholdGbps: toGbps(notification.thresholdBps),
    trafficMbps: toMbps(notification.trafficBps),
    thresholdMbps: toMbps(notification.thresholdBps),
    policy: notification.policy,
    node: notification.mitigationNode ?? notification.node,
    bogonNode: notification.bogonNode ?? null,
    mitigationNode: notification.mitigationNode ?? notification.node ?? null,
    rt: notification.rt,
    verified: notification.verified,
    eventId: notification.eventId ?? null,
    profileId: notification.profileId ?? null,
    addressFamily: notification.addressFamily ?? null,
    sharedPolicy: notification.sharedPolicy ?? false,
    sharedPolicyTargets: notification.sharedPolicyTargets ?? [],
    occurredAt: notification.occurredAt ?? null,
    episodeId: notification.episodeId ?? null,
    blockedReason: notification.blockedReason ?? null,
    direction: notification.direction ?? null,
    directionSource: notification.directionSource ?? null,
    fieldsUnavailable: notification.fieldsUnavailable ?? [],
    prefixes: notification.prefixes ?? null,
    growth: (notification.growth as GrowthWebhookBlock | null | undefined) ?? null,
  };
}

/**
 * Publisher de webhook: implementa a porta genérica e delega o envio ao
 * `sender` injetado. Sem URL configurada, apenas pula; falha de rede é engolida
 * para nunca afetar o motor.
 */
export function createWebhookNotificationPublisher(options: {
  url: string | null;
  send: WebhookSender;
  /** Enviado em X-NetVision-Token; NUNCA logado nem colocado na URL. */
  token?: string | null;
}): NotificationPublisher {
  const { url, send, token } = options;
  return {
    async publish(notification: MitigationNotification): Promise<NotificationPublishResult> {
      if (!url) return { published: false, skipped: true };
      const payload = buildMitigationWebhookPayload(notification);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(token ? { 'X-NetVision-Token': token } : {}),
      };
      try {
        await send(url, payload, headers);
        return { published: true, skipped: false };
      } catch {
        return { published: false, skipped: false };
      }
    },
  };
}
