/**
 * Porta genérica de notificação do motor de mitigação.
 *
 * O domínio DDoS NÃO conhece Telegram, webhook, e-mail nem qualquer transporte.
 * Ele apenas publica um `MitigationNotification` em um `NotificationPublisher`.
 * A camada de MÍDIAS (Fase 9) escolhe e configura os transportes concretos.
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
  /**
   * A policy foi escrita e o read-back de texto confere, mas a verificacao FISICA
   * (efeito no BGP) falhou ou ficou inconclusiva. NUNCA e sucesso; sem rollback automatico.
   */
  | 'MITIGATION_UNVERIFIED_PHYSICAL'
  | 'SSH_DISCONNECTED'
  | 'SSH_RECONNECTED'
  | 'MITIGATION_SIMULATION_TRIGGERED'
  | 'MITIGATION_REMOVE_SIMULATED'
  | 'MITIGATION_REMOVED_VERIFIED'
  /**
   * DETECCAO SEM ESCRITA: o gatilho foi atingido, mas a mitigacao NAO foi
   * aplicada (execucao automatica desligada ou escrita nao autorizada).
   * `verified=false` e `simulation=true` por contrato: nunca confundir com
   * `MITIGATION_TRIGGERED`, que representa mitigacao aplicada/em curso.
   */
  | 'MITIGATION_DETECTION_BLOCKED'
  /** Evento sintético do botão TESTAR WEBHOOK: não cria mitigação. */
  | 'MITIGATION_TEST';

/**
 * Evento de notificação, com banda/tráfego SEMPRE em bps (bigint). Converter
 * para Gbps é responsabilidade do transporte/exibição, nunca do domínio.
 */
export interface MitigationNotification {
  event: MitigationNotificationEvent;
  /** Correlacao do evento (aparece tambem no payload do n8n). */
  eventId?: string | null;
  profileId?: string | null;
  addressFamily?: 'IPV4' | 'IPV6' | null;
  /** Aviso (nao bloqueio): a policy IN e compartilhada por outros targets. */
  sharedPolicy?: boolean;
  sharedPolicyTargets?: {
    interfaceName: string | null;
    peerAddress: string | null;
    customer: string | null;
    addressFamily: string | null;
  }[];
  occurredAt?: string | null;
  /** S5: identidade do EPISODIO de ataque (dedupe do alerta de deteccao). */
  episodeId?: string | null;
  /** S5: motivo pelo qual a escrita NAO foi autorizada. */
  blockedReason?: string | null;
  /** S5: direcao efetiva da telemetria e sua origem. */
  direction?: 'rx' | 'tx' | null;
  directionSource?: string | null;
  /**
   * S5: nomes de campo que NAO puderam ser resolvidos. O transporte deve exibir
   * "indisponivel" em vez de inventar valor.
   */
  fieldsUnavailable?: string[];
  /**
   * ESCOPO VERIFICADO: prefixos REAIS recebidos do cliente, lidos no mesmo
   * escopo do comando (perfil + policy + peer). `null`/ausente = sem evidencia
   * completa (`'prefixes'` entra em `fieldsUnavailable`).
   *
   * Identifica o ESCOPO afetado — nao substitui a prova fisica de RT/LP em cada
   * rota e nunca promove `verified` nem `delivered`.
   */
  prefixes?: string[] | null;
  /** Sempre `true` nesta versão (SIMULATION_ONLY): nenhuma alteração foi feita. */
  simulation: boolean;
  /**
   * INFORMATIVO: analise de crescimento do trafego. O motor NUNCA le este
   * campo para decidir — ele so viaja ate o transporte (n8n).
   */
  growth?: object | null;
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
  /** Compatibilidade: mesmo valor de mitigationNode. */
  node: number | null;
  /** Node de DENY (BOGONS). */
  bogonNode?: number | null;
  /** Node de PERMIT (PREFIX8to24 + RT). */
  mitigationNode?: number | null;
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
