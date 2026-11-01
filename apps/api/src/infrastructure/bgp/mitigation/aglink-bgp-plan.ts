import { parseHuaweiRoutePolicyNodesLenient } from './huawei-bgp-policy-parser';

/** AGLINK transit: keep the customer route selected; export through mitigation RT only. */
export const AGLINK_BGP_PLAN = Object.freeze({
  policy: 'PL-AGLINK_IPv4-IN',
  targetPrefixList: 'AGLINK-BLOCO-TODO-23',
  rt: '268568:660',
  normalRt: '268568:140',
  localPreference: 1100,
  prefixDefinition:
    'ip ip-prefix AGLINK-BLOCO-TODO-23 index 10 permit 167.250.126.0 23 greater-equal 23 less-equal 24',
  /**
   * Contrato definitivo: o node de mitigacao PRESERVA o roteamento normal.
   *
   * O VRP termina a route-policy no primeiro node que casa, entao o node 2
   * precisa repor sozinho o que o node 10 fazia (LP 1100 + RT 268568:140) e
   * apenas ACRESCENTAR a RT de mitigacao. `additive` mantem intactas as
   * extended communities ja recebidas do peer (incluindo RT 268568:330).
   *
   * Forma fisica validada no BHE-VTA-F1A (VRP 8.220): o equipamento nao usa
   * duas linhas `apply extcommunity` no mesmo node (0 ocorrencias) e usa a
   * forma multi-RT em uma unica instrucao (`apply extcommunity rt A rt B
   * additive`, 1 ocorrencia real).
   */
  activationApplyClauses: [
    'apply local-preference 1100',
    'apply extcommunity rt 268568:140 rt 268568:660 additive',
  ] as const,
});

export function bgpPlanLabels<T extends { targetPrefixList: string }>(
  policy: string,
  labels: T,
): T {
  return policy === AGLINK_BGP_PLAN.policy
    ? { ...labels, targetPrefixList: AGLINK_BGP_PLAN.targetPrefixList }
    : labels;
}

/** Read both VRP configuration and display route-policy; never infer attributes from runtime. */
function clauses(text: string, policy: string, node: number): string[] | null {
  let currentPolicy: string | null = null,
    currentNode: number | null = null;
  let found = false;
  const result: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' ');
    const config = /^route-policy (\S+) (permit|deny) node (\d+)$/i.exec(line);
    const display = /^Route-policy: (\S+)$/i.exec(line);
    const header = /^(permit|deny) : (\d+)\b/i.exec(line);
    if (config) {
      currentPolicy = config[1]!;
      currentNode = Number(config[3]);
    } else if (display) {
      currentPolicy = display[1]!;
      currentNode = null;
    } else if (header) currentNode = Number(header[2]);
    else if (line === '#' || line.startsWith('<')) {
      currentPolicy = null;
      currentNode = null;
    } else if (
      currentPolicy === policy &&
      currentNode === node &&
      /^(if-match|apply|goto)\b/.test(line)
    )
      result.push(line);
    if (currentPolicy === policy && currentNode === node) found = true;
  }
  return found ? result.sort() : null;
}
function equalClauses(actual: string[] | null, expected: string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}
export function aglinkBaselineIntact(text: string): boolean {
  const normal = (
    parseHuaweiRoutePolicyNodesLenient(text).get(AGLINK_BGP_PLAN.policy) ?? []
  ).filter((n) => n.node >= 10);
  return (
    normal.length === 2 &&
    normal.some((n) => n.node === 10 && n.action === 'permit') &&
    normal.some((n) => n.node === 1000 && n.action === 'deny') &&
    equalClauses(clauses(text, AGLINK_BGP_PLAN.policy, 10), [
      'if-match ip-prefix AGLINK-BLOCO-TODO-23',
      'apply local-preference 1100',
      'apply extcommunity rt 268568:140 additive',
    ]) &&
    equalClauses(clauses(text, AGLINK_BGP_PLAN.policy, 1000), [])
  );
}
export function aglinkActivationIntact(text: string, node: number): boolean {
  return (
    aglinkBaselineIntact(text) &&
    equalClauses(clauses(text, AGLINK_BGP_PLAN.policy, node), [
      'if-match ip-prefix AGLINK-BLOCO-TODO-23',
      ...AGLINK_BGP_PLAN.activationApplyClauses,
    ])
  );
}
