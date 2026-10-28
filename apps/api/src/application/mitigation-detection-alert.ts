import type { HostRecord } from '@gmj/shared';
import type { MitigationNotification, NotificationPublisher } from '../infrastructure/bgp/mitigation/notification-publisher';
import type { MitigationAutoDecision } from '../worker/mitigation/mitigation-auto-engine';

/**
 * PRODUTOR do alerta de deteccao bloqueada (S5 / REVIEW-05 R5-8).
 *
 * Extraido de `routes.ts` para ser testavel: o caminho que monta e envia o
 * `MITIGATION_DETECTION_BLOCKED` e o mesmo em producao e nos testes, sem
 * duplicar a regra de `fieldsUnavailable`, de nome de equipamento/interface ou
 * da semantica de `delivered`.
 *
 * Contrato:
 *  - `simulation: true` e `verified: false` SEMPRE: nunca e mitigacao aplicada;
 *  - `eventId` estavel por EPISODIO (retry nao muda o id);
 *  - campo nao resolvido vai `null` e entra em `fieldsUnavailable` — nunca um
 *    valor inventado;
 *  - `delivered:true` so quando o transporte confirma (regra do transporte).
 */

export interface DetectionAlertHosts {
  getHost(id: string): Promise<HostRecord | null>;
}

export interface DetectionAlertPublisherDeps {
  hosts: DetectionAlertHosts;
  transport: Pick<NotificationPublisher, 'publish'>;
}

export interface DetectionAlertDeliveryResult {
  delivered: boolean;
  detail?: string | null;
}

function toBps(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Monta a notificacao de deteccao. Exportado para o teste conferir o payload
 * exato que sai para o webhook.
 */
export function buildDetectionAlertNotification(input: {
  decision: MitigationAutoDecision;
  deviceName: string | null;
  interfaceName: string | null;
}): MitigationNotification {
  const { decision, deviceName, interfaceName } = input;
  const unavailable: string[] = [];
  if (deviceName === null) unavailable.push('device');
  if (interfaceName === null) unavailable.push('interface');
  if (!decision.policyName) unavailable.push('policy');
  if (!decision.customer) unavailable.push('customer');
  if (!decision.peerAddress) unavailable.push('peer');
  if (!decision.direction) unavailable.push('direction');
  if (!decision.directionSource) unavailable.push('directionSource');
  if (!decision.addressFamily) unavailable.push('family');
  if (decision.trafficBps === null) unavailable.push('traffic');
  if (decision.thresholdBps === null) unavailable.push('threshold');

  return {
    event: 'MITIGATION_DETECTION_BLOCKED',
    eventId: `auto-detection-${decision.episodeId ?? decision.profileId}`,
    episodeId: decision.episodeId ?? null,
    profileId: decision.profileId,
    addressFamily: decision.addressFamily ?? null,
    occurredAt: decision.at,
    simulation: true,
    customer: decision.customer,
    device: deviceName,
    interfaceName,
    peer: decision.peerAddress ?? null,
    affectedPeers: [...(decision.peerAddresses ?? [])],
    detectedBandwidthBps: null,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: null,
    trafficBps: toBps(decision.trafficBps),
    thresholdBps: toBps(decision.thresholdBps),
    policy: decision.policyName ?? null,
    node: null,
    rt: null,
    verified: false,
    blockedReason: decision.reason,
    direction: decision.direction ?? null,
    directionSource: decision.directionSource ?? null,
    fieldsUnavailable: unavailable,
    sharedPolicy: decision.sharedPolicy === true,
    sharedPolicyTargets: [],
  };
}

/**
 * Cria o handler usado pelo motor (`onBlockedActivation`). Best effort por
 * contrato do motor: nunca lanca — devolve `delivered:false` para o retry.
 */
export function createDetectionAlertPublisher(deps: DetectionAlertPublisherDeps) {
  return async (decision: MitigationAutoDecision): Promise<DetectionAlertDeliveryResult> => {
    // Nome de equipamento/interface para o NOC. O contrato NAO aceita id
    // interno: quando a resolucao falha o campo vai nulo e entra em
    // `fieldsUnavailable`. `||` (nao `??`) porque `displayName` vazio tambem e
    // "sem nome" (R5-8).
    let deviceName: string | null = null;
    let interfaceName: string | null = null;
    try {
      const host = await deps.hosts.getHost(decision.deviceId);
      deviceName = host?.displayName || host?.hostname || null;
      interfaceName =
        (host?.interfaces ?? []).find((item) => item.id === decision.interfaceId)?.name || null;
    } catch {
      // Best effort: alerta nunca falha por lookup de inventario.
    }

    const notification = buildDetectionAlertNotification({ decision, deviceName, interfaceName });
    try {
      const result = await deps.transport.publish(notification);
      return {
        delivered: result.published === true && result.skipped !== true,
        detail:
          result.published === true
            ? null
            : 'transporte nao publicou (webhook nao configurado ou erro)',
      };
    } catch (error) {
      return {
        delivered: false,
        detail: error instanceof Error ? error.message : 'falha de transporte',
      };
    }
  };
}
