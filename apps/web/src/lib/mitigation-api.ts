// Cliente HTTP da mitigacao DDoS.
//
// Nao existe funcao de execucao de comando: a API so expoe leitura, discovery,
// simulacao (texto) e ajuste administrativo do profile.

import type {
  BgpMitigationDiscoveryResponseDto,
  MitigationExclusionReason,
  BgpMitigationEventDto,
  BgpMitigationHealthDto,
  BgpMitigationPatchInput,
  BgpMitigationProfileDto,
  BgpMitigationSimulateInput,
  BgpMitigationSimulationDto,
  BgpMitigationSimulationRowDto,
} from '@gmj/shared';
import { request } from './api';

export function getMitigationHealth(): Promise<BgpMitigationHealthDto> {
  return request<BgpMitigationHealthDto>('/api/bgp/mitigation/health');
}

export function getMitigationProfiles(): Promise<BgpMitigationProfileDto[]> {
  return request<BgpMitigationProfileDto[]>('/api/bgp/mitigation/profiles');
}

export function getMitigationProfile(id: string): Promise<BgpMitigationProfileDto> {
  return request<BgpMitigationProfileDto>(
    `/api/bgp/mitigation/profiles/${encodeURIComponent(id)}`,
  );
}

export function discoverMitigationProfiles(input: {
  deviceId?: string;
  deviceIds?: string[];
}): Promise<BgpMitigationDiscoveryResponseDto> {
  return request<BgpMitigationDiscoveryResponseDto>('/api/bgp/mitigation/discover', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function simulateMitigationProfile(
  id: string,
  input: BgpMitigationSimulateInput,
): Promise<BgpMitigationSimulationDto> {
  return request<BgpMitigationSimulationDto>(
    `/api/bgp/mitigation/profiles/${encodeURIComponent(id)}/simulate`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function patchMitigationProfile(
  id: string,
  input: BgpMitigationPatchInput,
): Promise<BgpMitigationProfileDto> {
  return request<BgpMitigationProfileDto>(
    `/api/bgp/mitigation/profiles/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

/**
 * Exclusao administrativa do target ("nunca mitigar este peer").
 * Configuracao pura: nao roda discovery nem envia nada ao equipamento.
 */
export function setMitigationExclusion(
  id: string,
  input: { excluded: boolean; reason?: MitigationExclusionReason; note?: string | null },
): Promise<BgpMitigationProfileDto> {
  return request<BgpMitigationProfileDto>(
    `/api/bgp/mitigation/profiles/${encodeURIComponent(id)}/exclusion`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function getMitigationSimulations(): Promise<BgpMitigationSimulationRowDto[]> {
  return request<BgpMitigationSimulationRowDto[]>('/api/bgp/mitigation/simulations');
}

export function getMitigationEvents(): Promise<BgpMitigationEventDto[]> {
  return request<BgpMitigationEventDto[]>('/api/bgp/mitigation/events');
}

// ---- Fase 8: comandos da UI (mesma camada de servico do n8n) -------------

export type MitigationCommandAction =
  | 'STATUS'
  | 'SIMULATE_ACTIVATE'
  | 'ACTIVATE'
  | 'SIMULATE_REMOVE'
  | 'REMOVE';

export interface MitigationCommandSharedTarget {
  interfaceId: string | null;
  interfaceName: string | null;
  customer: string | null;
  peerAddress: string | null;
}

export interface MitigationCommandResult {
  ok: boolean;
  requestId: string;
  action: MitigationCommandAction;
  status: string;
  profileId: string;
  customer: string | null;
  device: string | null;
  interface: string | null;
  interfaceId: string | null;
  addressFamily: string | null;
  policy: string | null;
  /** Compatibilidade: mesmo valor de mitigationNode. */
  node: number | null;
  /** Node de DENY (BOGONS) do par. */
  bogonNode: number | null;
  /** Node de PERMIT (PREFIX8to24 + RT) do par. */
  mitigationNode: number | null;
  rt: string | null;
  sharedPolicy: boolean;
  sharedPolicyTargets: MitigationCommandSharedTarget[];
  affectedPeers: string[];
  verified: boolean;
  executedAt: string;
  idempotent: boolean;
  commandPreview: string[];
  verification: { command: string; summary: string } | null;
  /** Notificação (n8n): nunca altera o resultado da mitigação. */
  notification: { published: boolean; skipped: boolean };
  safeError?: string;
}

/**
 * Endpoint INTERNO da UI (sessao NetVision) que delega ao mesmo
 * MitigationCommandService usado pelo inbound do n8n.
 */
export function runMitigationCommand(
  profileId: string,
  input: { requestId: string; action: MitigationCommandAction },
): Promise<MitigationCommandResult> {
  return request<MitigationCommandResult>(
    `/api/bgp/mitigation/profiles/${encodeURIComponent(profileId)}/command`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}
