import { parseHuaweiRoutePolicyNodesLenient } from './huawei-bgp-policy-parser';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';

// ESTRUTURA FISICA de mitigacao de UMA route-policy, a partir do read-back REAL
// (`display route-policy`). A classificacao e deliberadamente conservadora:
//
// - so entram nodes que referenciam as prefix-lists de mitigacao (BOGONS /
//   PREFIX8to24); nodes normais de outras funcionalidades NUNCA contam - nem
//   quando aplicam a MESMA RT sem a prefix-list de alvos (a mitigacao exige o
//   conjunto deny+BOGONS / permit+PREFIX8to24+RT);
// - qualquer node que referencie as listas fora do formato canonico e tratado
//   como SUSPEITO (bloqueia escrita e exige reconciliacao);
// - NORMAL exige ZERO nodes de mitigacao na policy inteira - nunca apenas a
//   ausencia do par planejado (que pode ter divergido do fisico).

export type PolicyMitigationPhysicalState = 'NORMAL' | 'MITIGATED' | 'RECONCILIATION_REQUIRED';

export interface PolicyMitigationPartialNode {
  node: number;
  action: 'permit' | 'deny';
  reason: string;
}

export interface PolicyMitigationPhysical {
  /** false = a policy nao apareceu no read-back (leitura inconclusiva). */
  recognized: boolean;
  state: PolicyMitigationPhysicalState;
  /** Nodes deny + if-match da lista de BOGONS. */
  bogonNodes: number[];
  /** Nodes permit + if-match da lista de alvos + RT de mitigacao. */
  mitigationNodes: number[];
  /** Nodes que referenciam as listas de mitigacao fora do formato canonico. */
  partialNodes: PolicyMitigationPartialNode[];
  /** Par fisico quando existe EXATAMENTE um par completo e nada suspeito. */
  pair: { bogonNode: number; mitigationNode: number } | null;
  detail: string;
}

export interface PolicyMitigationInspectionInput {
  policyName: string;
  readBack: string;
  /** RTs de mitigacao do escopo (normalmente uma por profile). */
  rts: readonly string[];
  labels?: { bogonPrefixList: string; targetPrefixList: string };
}

export function inspectPolicyMitigation(
  input: PolicyMitigationInspectionInput,
): PolicyMitigationPhysical {
  const labels = input.labels ?? {
    bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
    targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
  };
  const bogonNodes: number[] = [];
  const mitigationNodes: number[] = [];
  const partialNodes: PolicyMitigationPartialNode[] = [];

  const nodes = parseHuaweiRoutePolicyNodesLenient(input.readBack).get(input.policyName);
  if (!nodes || nodes.length === 0) {
    return {
      recognized: false,
      state: 'RECONCILIATION_REQUIRED',
      bogonNodes,
      mitigationNodes,
      partialNodes,
      pair: null,
      detail: `policy ${input.policyName} nao encontrada no read-back`,
    };
  }

  const rts = new Set(input.rts.filter((rt) => rt.length > 0));
  for (const node of nodes) {
    const refsBogon = node.ifMatchIpPrefix.includes(labels.bogonPrefixList);
    const refsTarget = node.ifMatchIpPrefix.includes(labels.targetPrefixList);
    // Node normal de outra funcionalidade: nao e mitigacao.
    if (!refsBogon && !refsTarget) continue;
    const matchingRts = node.routeTargets.filter((rt) => rts.has(rt));
    if (refsBogon && !refsTarget && node.action === 'deny') {
      bogonNodes.push(node.node);
      continue;
    }
    if (refsTarget && !refsBogon && node.action === 'permit' && matchingRts.length > 0) {
      mitigationNodes.push(node.node);
      continue;
    }
    const parts: string[] = [`${node.action} node ${node.node}`];
    if (refsBogon) parts.push(`if-match ${labels.bogonPrefixList}`);
    if (refsTarget) {
      parts.push(`if-match ${labels.targetPrefixList}`);
      if (matchingRts.length === 0) parts.push('sem RT de mitigacao');
    }
    partialNodes.push({ node: node.node, action: node.action, reason: parts.join(' + ') });
  }

  const sortedBogon = [...bogonNodes].sort((left, right) => left - right);
  const sortedMitigation = [...mitigationNodes].sort((left, right) => left - right);

  if (partialNodes.length > 0) {
    return {
      recognized: true,
      state: 'RECONCILIATION_REQUIRED',
      bogonNodes: sortedBogon,
      mitigationNodes: sortedMitigation,
      partialNodes,
      pair: null,
      detail: `estrutura de mitigacao incompativel: ${partialNodes
        .map((entry) => entry.reason)
        .join('; ')}`,
    };
  }

  if (sortedBogon.length === 0 && sortedMitigation.length === 0) {
    return {
      recognized: true,
      state: 'NORMAL',
      bogonNodes: sortedBogon,
      mitigationNodes: sortedMitigation,
      partialNodes,
      pair: null,
      detail: 'nenhum node de mitigacao presente na policy',
    };
  }

  if (sortedBogon.length === 1 && sortedMitigation.length === 1) {
    const pair = { bogonNode: sortedBogon[0]!, mitigationNode: sortedMitigation[0]! };
    return {
      recognized: true,
      state: 'MITIGATED',
      bogonNodes: sortedBogon,
      mitigationNodes: sortedMitigation,
      partialNodes,
      pair,
      detail: `par de mitigacao ativo: deny node ${pair.bogonNode} (${labels.bogonPrefixList}) + permit node ${pair.mitigationNode} (${labels.targetPrefixList} + RT)`,
    };
  }

  return {
    recognized: true,
    state: 'RECONCILIATION_REQUIRED',
    bogonNodes: sortedBogon,
    mitigationNodes: sortedMitigation,
    partialNodes,
    pair: null,
    detail:
      `estrutura de mitigacao multipla/parcial: ${sortedBogon.length} node(s) ${labels.bogonPrefixList} ` +
      `[${sortedBogon.join(', ')}], ${sortedMitigation.length} node(s) de mitigacao [${sortedMitigation.join(', ')}]`,
  };
}
