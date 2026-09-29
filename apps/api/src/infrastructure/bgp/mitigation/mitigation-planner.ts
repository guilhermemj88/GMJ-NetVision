import type { MitigationBlockReason, PrefixStatus } from './mitigation-types';

export interface TemporaryNodeSelection {
  /** Node escolhido (1–9) ou `null` quando bloqueado. */
  node: number | null;
  firstNormalNode: number | null;
  /** Faixa completa de nodes disponíveis ANTES do primeiro node normal. */
  nodesBeforeFirstNormal: number[];
  blocked: boolean;
  reason: MitigationBlockReason | null;
}

export interface TemporaryNodeInput {
  /** Nodes normais já existentes na route-policy (lidos do equipamento). */
  normalNodes: readonly number[];
  /** Nodes já ocupados (normais + temporários criados pelo NetVision). */
  occupiedNodes: readonly number[];
  /** Teto do candidato temporário (preferimos 1..9). */
  maxCandidate?: number;
}

/**
 * Escolhe o node temporário de mitigação sem sobrescrever nada.
 *
 * A regra é: achar o menor node normal existente e usar o primeiro node livre
 * antes dele (preferindo 1, 2, 3…, limitado a `maxCandidate` = 9). Um node já
 * ocupado — normal ou temporário — nunca é reaproveitado.
 */
export function selectTemporaryNode(
  input: TemporaryNodeInput,
): TemporaryNodeSelection {
  const maxCandidate = input.maxCandidate ?? 9;
  const normal = [...new Set(input.normalNodes)]
    .filter((node) => Number.isInteger(node) && node > 0)
    .sort((a, b) => a - b);
  const occupied = new Set(
    [...input.occupiedNodes].filter((node) => Number.isInteger(node) && node > 0),
  );

  const firstNormalNode = normal[0] ?? null;
  const ceiling = firstNormalNode === null ? maxCandidate : Math.min(firstNormalNode - 1, maxCandidate);
  const nodesBeforeFirstNormal: number[] = [];
  for (let node = 1; node <= ceiling; node += 1) nodesBeforeFirstNormal.push(node);

  const candidate = nodesBeforeFirstNormal.find((node) => !occupied.has(node)) ?? null;
  if (candidate !== null) {
    return {
      node: candidate,
      firstNormalNode,
      nodesBeforeFirstNormal,
      blocked: false,
      reason: null,
    };
  }

  return {
    node: null,
    firstNormalNode,
    nodesBeforeFirstNormal,
    blocked: true,
    reason: 'NO_SAFE_TEMPORARY_NODE',
  };
}

export function prefixStatus(prefixCount: number | null, limit: number): PrefixStatus {
  if (prefixCount === null || !Number.isFinite(prefixCount)) return 'UNKNOWN';
  if (prefixCount > limit) return 'EXCEEDED';
  if (prefixCount >= limit * 0.8) return 'WARNING';
  return 'SAFE';
}

export interface PolicyPeerAssignment {
  policyName: string;
  peerAddress: string;
}

/** Agrupa os peers que compartilham cada route-policy (IN). */
export function peersByPolicy(assignments: readonly PolicyPeerAssignment[]): Map<string, string[]> {
  const byPolicy = new Map<string, string[]>();
  for (const assignment of assignments) {
    const peers = byPolicy.get(assignment.policyName) ?? [];
    if (!peers.includes(assignment.peerAddress)) peers.push(assignment.peerAddress);
    byPolicy.set(assignment.policyName, peers);
  }
  return byPolicy;
}

export interface MitigationBlockDecision {
  blocked: boolean;
  reason: MitigationBlockReason | null;
}

/**
 * Regras de segurança que, independentemente do tráfego, impedem a mitigação
 * automática por "permit all". Estas mesmas regras são usadas pelo worker e
 * pela simulação (com os valores injetados).
 */
export function safetyBlocks(input: {
  bandwidthGbps: number | null;
  prefixCount: number | null;
  prefixLimit: number;
  interfaceCorrelation: 'MATCHED' | 'AMBIGUOUS' | 'NONE';
  policyExists: boolean;
  peerExists: boolean;
}): MitigationBlockDecision {
  if (!input.peerExists) return { blocked: true, reason: 'PEER_NOT_FOUND' };
  if (input.bandwidthGbps === null) return { blocked: true, reason: 'BANDWIDTH_UNKNOWN' };
  if (input.interfaceCorrelation !== 'MATCHED') {
    return { blocked: true, reason: 'INTERFACE_AMBIGUOUS' };
  }
  if (!input.policyExists) return { blocked: true, reason: 'POLICY_NOT_FOUND' };
  const status = prefixStatus(input.prefixCount, input.prefixLimit);
  if (status === 'EXCEEDED') return { blocked: true, reason: 'PREFIX_LIMIT_EXCEEDED' };
  if (status === 'UNKNOWN') return { blocked: true, reason: 'PREFIX_UNKNOWN' };
  return { blocked: false, reason: null };
}
