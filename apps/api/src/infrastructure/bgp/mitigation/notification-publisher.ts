/**
 * Porta genérica de notificação do motor de mitigação.
 *
 * O domínio DDoS NÃO conhece Telegram, webhook, e-mail nem qualquer transporte.
 * Ele apenas publica um `MitigationNotification` em um `NotificationPublisher`.
 * A camada de MÍDIAS (futura) escolhe e configura os transportes concretos.
 *
 * Regra: o motor chama `notificationPublisher.publish(event)` — nunca
 * `telegram.send(...)` nem `webhook.send(...)`.
 */

export type MitigationNotificationEvent =
  | 'MITIGATION_TRIGGERED'
  | 'MITIGATION_STARTED'
  | 'MITIGATION_VERIFIED'
  | 'MITIGATION_RECOVERY_STARTED'
  | 'MITIGATION_ENDED'
  | 'MITIGATION_FAILED'
  | 'SSH_DISCONNECTED'
  | 'SSH_RECONNECTED'
  | 'MITIGATION_SIMULATION_TRIGGERED';

/**
 * Evento de notificação, com banda/tráfego SEMPRE em bps (bigint). Converter
 * para Gbps é responsabilidade do transporte/exibição, nunca do domínio.
 */
export interface MitigationNotification {
  event: MitigationNotificationEvent;
  /** Sempre `true` nesta versão (SIMULATION_ONLY): nenhuma alteração foi feita. */
  simulation: boolean;
  customer: string | null;
  device: string | null;
  interfaceName: string | null;
  peer: string | null;
  affectedPeers: string[];
  detectedBandwidthBps: bigint | null;
  bandwidthOverrideBps: bigint | null;
  effectiveBandwidthBps: bigint | null;
  trafficBps: bigint | null;
  thresholdBps: bigint | null;
  policy: string | null;
  node: number | null;
  rt: string | null;
  verified: boolean | null;
}

export interface NotificationPublishResult {
  published: boolean;
  skipped: boolean;
}

/**
 * Publicação "best effort": falha de mídia NUNCA afeta o motor. O retorno
 * informa apenas se foi publicado; exceções são engolidas pelo publisher.
 */
export interface NotificationPublisher {
  publish(notification: MitigationNotification): Promise<NotificationPublishResult>;
}

/** Publisher no-op: usado quando nenhuma mídia está configurada. */
export class NoopNotificationPublisher implements NotificationPublisher {
  async publish(_notification: MitigationNotification): Promise<NotificationPublishResult> {
    return { published: false, skipped: true };
  }
}

/** Publisher em memória para testes e para o caminho de simulação. */
export class InMemoryNotificationPublisher implements NotificationPublisher {
  readonly published: MitigationNotification[] = [];

  async publish(notification: MitigationNotification): Promise<NotificationPublishResult> {
    this.published.push(notification);
    return { published: true, skipped: false };
  }
}
