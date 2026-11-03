import { exactMitigationNodes } from './mitigation-contract';
import { parseHuaweiRoutePolicyNodesLenient } from './huawei-bgp-policy-parser';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
import {
  bgpPlanLabels,
} from './aglink-bgp-plan';

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
  /** Nodes 1 canonicos (deny + if-match ip-prefix BOGONS). */
  bogonNodes: number[];
  /** Nodes 2 canonicos (permit + somente apply extcommunity rt 268568:660). */
  mitigationNodes: number[];
  /** Node 1/2 ocupado fora do formato do contrato. */
  partialNodes: PolicyMitigationPartialNode[];
  /** Par fisico quando os dois nodes reservados estao exatamente no contrato. */
  pair: { bogonNode: number; mitigationNode: number } | null;
  detail: string;
}

/**
 * Contrato IPv4 definitivo: apenas os nodes 1 e 2 sao reservados. Nodes
 * permanentes (10, 1000, ...) sao ignorados aqui — nao sao propriedade da
 * mitigacao e nao entram como par.
 */
export interface PolicyMitigationInspectionInput {
  policyName: string;
  readBack: string;
  /** RTs de mitigacao do escopo; fora de 268568:660 o node 2 e divergente. */
  rts: readonly string[];
  labels?: { bogonPrefixList: string; targetPrefixList: string };
}

export function inspectPolicyMitigation(
  input: PolicyMitigationInspectionInput,
): PolicyMitigationPhysical {
  const labels = bgpPlanLabels(
    input.policyName,
    input.labels ?? {
      bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
      targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    },
  );
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

  // Nodes 1/2 sao reservados. Fora deles, so a ASSINATURA do contrato antigo
  // (if-match da lista alvo + RT de mitigacao no mesmo node) denuncia um par
  // legado que nao pode coexistir com o novo — RT660 ou BOGONS isolados em node
  // permanente do cliente nao provam ownership e sao ignorados.
  const rt = input.rts[0] ?? '268568:660';
  const exact = exactMitigationNodes(input.readBack, input.policyName);
  const outsideBogon = nodes.filter(
    (n) =>
      n.node !== 1 &&
      n.action === 'deny' &&
      n.ifMatchIpPrefix.length === 1 &&
      n.ifMatchIpPrefix[0] === labels.bogonPrefixList,
  );
  const outsideMitigation = nodes.filter(
    (n) =>
      n.node !== 2 &&
      ((n.action === 'permit' &&
        n.ifMatchIpPrefix.length === 0 &&
        n.routeTargets.length === 1 &&
        n.routeTargets[0] === rt) ||
        // forma legada: lista alvo + RT de mitigacao no mesmo node
        (n.ifMatchIpPrefix.includes(labels.targetPrefixList) && n.routeTargets.includes(rt))),
  );
  // Um BOGONS isolado em node permanente do cliente (ex.: LIVINET node 5) e
  // legitimo; o que nao pode existir e o PAR completo fora de 1/2.
  const legacyPairOutside =
    outsideBogon.length > 0 && outsideMitigation.length > 0
      ? [...outsideBogon, ...outsideMitigation]
      : [];
  for (const node of nodes) {
    if (node.node === 1) {
      if (exact.bogonOk) bogonNodes.push(1);
      else partialNodes.push({node: 1, action: node.action, reason: 'reserved node occupied by noncanonical configuration'});
    } else if (node.node === 2) {
      if (exact.mitigationOk) mitigationNodes.push(2);
      else partialNodes.push({node: 2, action: node.action, reason: 'reserved node occupied by noncanonical configuration'});
    } else if (legacyPairOutside.some((entry) => entry.node === node.node)) {
      partialNodes.push({node: node.node, action: node.action, reason: 'mitigation pair outside nodes 1/2'});
    }
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
      detail: `par de mitigacao ativo: deny node ${pair.bogonNode} (${labels.bogonPrefixList}) + permit node ${pair.mitigationNode} (permit irrestrito + RT exclusiva)`,
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
