import { equalClauses, policyNodeClauses } from './mitigation-policy-clauses';
import {
  deriveMitigationNode2Contract,
  mitigationNode2Clauses,
  type MitigationNode2Contract,
} from './mitigation-node2-contract';

/** Operator-approved IPv4 contract. Baseline attributes are evidence, never commands. */
export const IPV4_MITIGATION_CONTRACT = Object.freeze({
  bogonNode: 1,
  mitigationNode: 2,
  bogonPrefixList: 'BOGONS',
  rt: '268568:660',
});

/**
 * Read-back EXATO dos nodes 1 e 2.
 *
 * O node 2 deve ser exatamente o clone estreito do node permanente do cliente
 * (if-match + local-preference + RT 660, sem additive). `contract` (do
 * preflight) e a referencia quando existe; sem ele o contrato e derivado dos
 * nodes PERMANENTES do proprio texto lido - que o drift check garante
 * identicos ao baseline. Policy sem contrato derivavel NUNCA tem node 2 ok.
 */
export function exactMitigationNodes(
  text: string,
  policy: string,
  contract?: MitigationNode2Contract | null,
) {
  const bogon = policyNodeClauses(text, policy, 1);
  const mitigation = policyNodeClauses(text, policy, 2);
  let expected: string[] | null = null;
  if (contract) expected = mitigationNode2Clauses(contract);
  else {
    const derived = deriveMitigationNode2Contract(text, policy);
    if (derived.eligible) expected = mitigationNode2Clauses(derived.contract);
  }
  return {
    bogonOk: bogon?.action === 'deny' && equalClauses(bogon.clauses, ['if-match ip-prefix BOGONS']),
    mitigationOk:
      mitigation?.action === 'permit' && expected !== null && equalClauses(mitigation.clauses, expected),
  };
}

export function assertIpv4MitigationContract(plan: {
  bogonNode: number; mitigationNode: number; rt?: string; bogonPrefixList?: string;
}): void {
  if (plan.bogonNode !== 1 || plan.mitigationNode !== 2 ||
      (plan.rt !== undefined && plan.rt !== '268568:660') ||
      (plan.bogonPrefixList !== undefined && plan.bogonPrefixList !== 'BOGONS'))
    throw new Error('MITIGATION_CONTRACT_MISMATCH: only nodes 1/2, BOGONS and exclusive RT268568:660');
}

/**
 * Nodes que PRECEDEM o par reservado (node 0 e o unico possivel no VRP).
 *
 * Um `permit node 0` captura todo NLRI antes do node 1: a mitigacao fica
 * inerte e o read-back dos nodes 1/2 continua "correto". Por isso qualquer node
 * com precedencia e tratado como conflito NAO AUTORIZADO: bloqueia a escrita e
 * impede declarar MITIGATED. Nao existe regra aprovada para conviver com ele.
 */
export function precedenceConflictNodes(nodes: readonly { node: number }[]): number[] {
  return nodes
    .filter((entry) => entry.node < IPV4_MITIGATION_CONTRACT.bogonNode)
    .map((entry) => entry.node)
    .sort((left, right) => left - right);
}

/**
 * Mesmo contrato, a partir dos nodes ja parseados (sem o texto cru).
 *
 * Usado por camadas informativas (discovery) para nao classificar o node 2
 * canonico como "node normal do cliente". O gate de escrita usa o texto cru.
 */
export function exactMitigationNodesFromParsed(
  nodes: readonly {
    node: number;
    action: 'permit' | 'deny';
    ifMatchIpPrefix: readonly string[];
    routeTargets: readonly string[];
  }[],
  rt: string,
): { bogonOk: boolean; mitigationOk: boolean } {
  const bogon = nodes.find((entry) => entry.node === 1);
  const mitigation = nodes.find((entry) => entry.node === 2);
  return {
    bogonOk:
      bogon?.action === 'deny' &&
      bogon.ifMatchIpPrefix.length === 1 &&
      bogon.ifMatchIpPrefix[0] === 'BOGONS',
    mitigationOk:
      mitigation?.action === 'permit' &&
      mitigation.ifMatchIpPrefix.length === 1 &&
      mitigation.routeTargets.length === 1 &&
      mitigation.routeTargets[0] === rt,
  };
}
