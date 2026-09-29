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
  policy: string | null;
  node: number | null;
  rt: string | null;
  verified: boolean | null;
}

export type WebhookSender = (url: string, payload: MitigationWebhookPayload) => Promise<void>;

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
    policy: notification.policy,
    node: notification.node,
    rt: notification.rt,
    verified: notification.verified,
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
}): NotificationPublisher {
  const { url, send } = options;
  return {
    async publish(notification: MitigationNotification): Promise<NotificationPublishResult> {
      if (!url) return { published: false, skipped: true };
      const payload = buildMitigationWebhookPayload(notification);
      try {
        await send(url, payload);
        return { published: true, skipped: false };
      } catch {
        return { published: false, skipped: false };
      }
    },
  };
}
