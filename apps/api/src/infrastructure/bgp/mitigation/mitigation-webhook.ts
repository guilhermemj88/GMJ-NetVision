export type MitigationWebhookEvent =
  | 'MITIGATION_TRIGGERED'
  | 'MITIGATION_STARTED'
  | 'MITIGATION_VERIFIED'
  | 'MITIGATION_RECOVERY_STARTED'
  | 'MITIGATION_ENDED'
  | 'MITIGATION_FAILED'
  | 'SSH_DISCONNECTED'
  | 'SSH_RECONNECTED'
  | 'MITIGATION_SIMULATION_TRIGGERED';

export interface MitigationWebhookPayload {
  event: MitigationWebhookEvent;
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

export interface MitigationWebhookInput {
  event: MitigationWebhookEvent;
  customer: string | null;
  device: string | null;
  interfaceName: string | null;
  peer: string | null;
  affectedPeers: string[];
  bandwidthGbps: number | null;
  trafficBps: number | null;
  thresholdBps: number | null;
  policy: string | null;
  node: number | null;
  rt: string | null;
  verified?: boolean | null;
}

/**
 * Monta o payload com `simulation: true` SEMPRE, nesta versão. É a marca que o
 * n8n usa para formatar "SIMULAÇÃO — nenhuma alteração foi realizada".
 */
export function buildMitigationWebhookPayload(input: MitigationWebhookInput): MitigationWebhookPayload {
  return {
    event: input.event,
    simulation: true,
    customer: input.customer,
    device: input.device,
    interface: input.interfaceName,
    peer: input.peer,
    affectedPeers: input.affectedPeers,
    bandwidthGbps: input.bandwidthGbps,
    trafficGbps: input.trafficBps === null ? null : roundGbps(input.trafficBps),
    thresholdGbps: input.thresholdBps === null ? null : roundGbps(input.thresholdBps),
    policy: input.policy,
    node: input.node,
    rt: input.rt,
    verified: input.verified ?? null,
  };
}

function roundGbps(bps: number): number {
  return Math.round((bps / 1_000_000_000) * 100) / 100;
}

export type WebhookSender = (url: string, payload: MitigationWebhookPayload) => Promise<void>;

export interface WebhookDispatchResult {
  sent: boolean;
  skipped: boolean;
}

/**
 * Envio "best effort": falha de webhook NUNCA afeta o motor. O retorno informa
 * apenas se foi enviado/saltado; exceções são engolidas por quem chama.
 */
export async function dispatchMitigationWebhook(
  url: string | null,
  payload: MitigationWebhookPayload,
  send: WebhookSender,
): Promise<WebhookDispatchResult> {
  if (!url) return { sent: false, skipped: true };
  try {
    await send(url, payload);
    return { sent: true, skipped: false };
  } catch {
    return { sent: false, skipped: false };
  }
}
