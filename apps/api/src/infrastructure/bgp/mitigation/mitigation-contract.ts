import { equalClauses, policyNodeClauses } from './mitigation-policy-clauses';

/** Operator-approved IPv4 contract. Baseline attributes are evidence, never commands. */
export const IPV4_MITIGATION_CONTRACT = Object.freeze({
  bogonNode: 1,
  mitigationNode: 2,
  bogonPrefixList: 'BOGONS',
  rt: '268568:660',
});

export function exactMitigationNodes(text: string, policy: string) {
  const bogon = policyNodeClauses(text, policy, 1);
  const mitigation = policyNodeClauses(text, policy, 2);
  return {
    bogonOk: bogon?.action === 'deny' && equalClauses(bogon.clauses, ['if-match ip-prefix BOGONS']),
    mitigationOk:
      mitigation?.action === 'permit' &&
      equalClauses(mitigation.clauses, ['apply extcommunity rt 268568:660']),
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
      mitigation.ifMatchIpPrefix.length === 0 &&
      mitigation.routeTargets.length === 1 &&
      mitigation.routeTargets[0] === rt,
  };
}
