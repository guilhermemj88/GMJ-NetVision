// Parser READ-ONLY da configuracao BGP do Huawei VRP.
//
// Objetivo: descobrir a policy de IMPORT de cada peer e os nodes ja existentes de
// cada route-policy, a partir de um unico dump de configuracao. Nada aqui executa
// comando no equipamento - e so analise de texto.
//
// O parser e GENERICO de proposito: ele NAO sabe qual e a route-target nem quais
// prefix-lists pertencem a mitigacao. Ele devolve, por node: acao (permit/deny),
// prefix-lists citadas em `if-match ip-prefix` e RTs aplicadas. Quem decide
// ("este node ja mitiga?") e a camada de mitigacao, comparando com a configuracao
// do motor. Assim um node normal que aplica `extcommunity rt 268568:110` nao e
// confundido com mitigacao, e um `deny` qualquer nao vira BOGONS.
//
// Regras deliberadas:
//  - apenas `route-policy <nome> import` e considerada (export NUNCA vira IN);
//  - peer que referencia um peer-group herda a policy do grupo, mas a policy
//    declarada diretamente no peer tem precedencia (semantica do VRP);
//  - chave que parece endereco IP e um peer; qualquer outra chave e um grupo.

export interface HuaweiBgpPolicyConfiguration {
  /** peerAddress -> policy IN declarada diretamente no peer */
  directPeerPolicies: Map<string, string>;
  /** peerAddress -> peer-group */
  peerGroups: Map<string, string>;
  /** peer-group -> policy IN */
  groupPolicies: Map<string, string>;
}

export interface HuaweiRoutePolicyNode {
  node: number;
  action: 'permit' | 'deny';
  /** Prefix-lists citadas em `if-match ip-prefix ...` dentro do node. */
  ifMatchIpPrefix: string[];
  /** Route-targets aplicadas por `apply extcommunity rt ...` dentro do node. */
  routeTargets: string[];
}

function isAddressLike(key: string): boolean {
  return key.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(key);
}

/** `peer 10.0.0.1 route-policy PL-IN import` (import apenas). */
const PEER_POLICY_IMPORT =
  /^[ \t]*peer[ \t]+(\S+)[ \t]+route-policy[ \t]+(\S+)[ \t]+import[ \t]*$/gim;
/** `peer 10.0.0.1 group PL-HORIZONTES` */
const PEER_GROUP = /^[ \t]*peer[ \t]+(\S+)[ \t]+group[ \t]+(\S+)[ \t]*$/gim;
/** `route-policy PL-IN permit node 11` */
const ROUTE_POLICY_NODE =
  /^[ \t]*route-policy[ \t]+(\S+)[ \t]+(permit|deny)[ \t]+node[ \t]+(\d+)[ \t]*$/i;
/** ` apply extcommunity rt 268568:660 additive` (dentro de um node) */
const APPLY_EXTCOMMUNITY_RT = /^[ \t]*apply[ \t]+extcommunity[ \t]+rt[ \t]+(\S+)/i;
/** ` if-match ip-prefix PREFIX8to24` (dentro de um node) */
const IF_MATCH_IP_PREFIX = /^[ \t]*if-match[ \t]+ip-prefix[ \t]+(\S+)/i;

export function parseHuaweiBgpPolicyConfiguration(config: string): HuaweiBgpPolicyConfiguration {
  const directPeerPolicies = new Map<string, string>();
  const peerGroups = new Map<string, string>();
  const groupPolicies = new Map<string, string>();

  for (const match of config.matchAll(PEER_POLICY_IMPORT)) {
    const key = match[1];
    const policyName = match[2];
    if (!key || !policyName) continue;
    if (isAddressLike(key)) directPeerPolicies.set(key, policyName);
    else groupPolicies.set(key, policyName);
  }

  for (const match of config.matchAll(PEER_GROUP)) {
    const peerAddress = match[1];
    const groupName = match[2];
    if (!peerAddress || !groupName) continue;
    peerGroups.set(peerAddress, groupName);
  }

  return { directPeerPolicies, peerGroups, groupPolicies };
}

// Resolve a policy de import de um peer: declaracao direta vence; na ausencia dela,
// herda a policy do peer-group. Sem nenhuma das duas -> null.
export function resolvePeerInboundPolicy(
  peerAddress: string,
  configuration: HuaweiBgpPolicyConfiguration,
): string | null {
  const direct = configuration.directPeerPolicies.get(peerAddress);
  if (direct) return direct;
  const group = configuration.peerGroups.get(peerAddress);
  if (!group) return null;
  return configuration.groupPolicies.get(group) ?? null;
}

// Percorremos linha a linha porque prefix-lists e RTs vem do corpo do node, e nao
// da linha de cabecalho. O objeto do node e mutado por referencia dentro do mapa.
export function parseHuaweiRoutePolicyNodes(
  config: string,
): Map<string, HuaweiRoutePolicyNode[]> {
  const policies = new Map<string, HuaweiRoutePolicyNode[]>();
  let current: HuaweiRoutePolicyNode | null = null;

  for (const line of config.split(/\r?\n/)) {
    const nodeMatch = ROUTE_POLICY_NODE.exec(line);
    if (nodeMatch) {
      const name = nodeMatch[1];
      const action = nodeMatch[2]?.toLowerCase();
      const node = Number(nodeMatch[3]);
      if (!name || (action !== 'permit' && action !== 'deny') || !Number.isInteger(node) || node <= 0) {
        current = null;
        continue;
      }
      current = { node, action, ifMatchIpPrefix: [], routeTargets: [] };
      const entry = policies.get(name) ?? [];
      entry.push(current);
      policies.set(name, entry);
      continue;
    }

    if (current) {
      const prefixList = IF_MATCH_IP_PREFIX.exec(line)?.[1];
      if (prefixList && !current.ifMatchIpPrefix.includes(prefixList)) {
        current.ifMatchIpPrefix.push(prefixList);
      }
      const routeTarget = APPLY_EXTCOMMUNITY_RT.exec(line)?.[1];
      if (routeTarget && !current.routeTargets.includes(routeTarget)) {
        current.routeTargets.push(routeTarget);
      }
    }

    // Linha nao indentada (ex.: "#") encerra o corpo do node corrente.
    if (line.trim().length > 0 && !/^[ \t]/.test(line)) current = null;
  }

  for (const entry of policies.values()) {
    entry.sort((left, right) => left.node - right.node);
  }

  return policies;
}

// Selectors genericos usados pela camada de mitigacao.
export function permitNodesOf(nodes: readonly HuaweiRoutePolicyNode[]): number[] {
  return nodes.filter((entry) => entry.action === 'permit').map((entry) => entry.node);
}

export function allNodesOf(nodes: readonly HuaweiRoutePolicyNode[]): number[] {
  return nodes.map((entry) => entry.node);
}

// Nodes de PERMIT que aplicam exatamente a route-target informada. A RT vem sempre
// de fora (config do motor) - nada de hardcode aqui.
export function nodesApplyingRouteTarget(
  nodes: readonly HuaweiRoutePolicyNode[],
  routeTarget: string,
): number[] {
  return nodes
    .filter((entry) => entry.action === 'permit' && entry.routeTargets.includes(routeTarget))
    .map((entry) => entry.node);
}

/** Nodes que citam a prefix-list informada (permit ou deny). */
export function nodesWithPrefixList(
  nodes: readonly HuaweiRoutePolicyNode[],
  prefixList: string,
): number[] {
  return nodes
    .filter((entry) => entry.ifMatchIpPrefix.includes(prefixList))
    .map((entry) => entry.node);
}

/**
 * Node BOGONS: DENY E if-match da prefix-list informada.
 * Um `deny` qualquer NAO entra aqui.
 */
export function bogonDenyNodes(
  nodes: readonly HuaweiRoutePolicyNode[],
  bogonPrefixList: string,
): number[] {
  return nodes
    .filter(
      (entry) => entry.action === 'deny' && entry.ifMatchIpPrefix.includes(bogonPrefixList),
    )
    .map((entry) => entry.node);
}

/**
 * Node de mitigacao: PERMIT + if-match da prefix-list alvo + RT esperada.
 * Ter a RT sem a prefix-list NAO caracteriza mitigacao.
 */
export function mitigationPermitNodes(
  nodes: readonly HuaweiRoutePolicyNode[],
  routeTarget: string,
  targetPrefixList: string,
): number[] {
  return nodes
    .filter(
      (entry) =>
        entry.action === 'permit' &&
        entry.routeTargets.includes(routeTarget) &&
        entry.ifMatchIpPrefix.includes(targetPrefixList),
    )
    .map((entry) => entry.node);
}

/**
 * Nomes das ip-prefix definidas na configuracao (`ip ip-prefix NOME index ...`).
 *
 * Leitura apenas de DEFINICOES: a linha de referencia dentro de uma route-policy
 * (` if-match ip-prefix NOME`) comeca indentada e nunca casa com esta expressao.
 */
export function parseConfiguredIpPrefixNames(config: string): string[] {
  const names = new Set<string>();
  for (const line of config.split(/\r?\n/)) {
    const match = /^ip[ \t]+ip-prefix[ \t]+(\S+)/i.exec(line);
    const name = match?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

/** `Route-policy: PL-X` (cabecalho do display interativo). */
const DISPLAY_POLICY_HEADER = /^[ \t]*Route-policy[ \t]*:[ \t]*(\S+)[ \t]*$/i;
/**
 * Node no formato do display: `  permit : 11 (matched counts: 2)`.
 * O sufixo `(matched counts: N)` e DINAMICO (muda com o trafego) e por isso e
 * ignorado — comparar read-back nunca pode depender dele.
 */
const DISPLAY_NODE_HEADER = /^[ \t]*(permit|deny)[ \t]*:[ \t]*(\d{1,9})\b/i;

/**
 * Parser do `display route-policy <nome>` (formato interativo do VRP).
 *
 * O equipamento NAO devolve a configuracao nesse comando: devolve um resumo com
 * `Route-policy: <nome>`, nodes na forma `permit : 11` / `deny : 50` e as
 * clausulas de match/apply indentadas. Este parser le exatamente esse formato,
 * reusando as MESMAS expressoes de clausula do parser de configuracao.
 */
export function parseHuaweiRoutePolicyDisplay(
  config: string,
): Map<string, HuaweiRoutePolicyNode[]> {
  const policies = new Map<string, HuaweiRoutePolicyNode[]>();
  let currentPolicy: string | null = null;
  let current: HuaweiRoutePolicyNode | null = null;

  for (const line of config.split(/\r?\n/)) {
    const header = DISPLAY_POLICY_HEADER.exec(line);
    if (header?.[1]) {
      currentPolicy = header[1];
      current = null;
      if (!policies.has(currentPolicy)) policies.set(currentPolicy, []);
      continue;
    }

    const nodeMatch = DISPLAY_NODE_HEADER.exec(line);
    if (nodeMatch && currentPolicy) {
      const action = nodeMatch[1]?.toLowerCase();
      const node = Number(nodeMatch[2]);
      if ((action === 'permit' || action === 'deny') && Number.isInteger(node) && node > 0) {
        current = { node, action, ifMatchIpPrefix: [], routeTargets: [] };
        policies.get(currentPolicy)!.push(current);
      } else {
        current = null;
      }
      continue;
    }

    if (!current) continue;
    const prefixList = IF_MATCH_IP_PREFIX.exec(line)?.[1];
    if (prefixList && !current.ifMatchIpPrefix.includes(prefixList)) {
      current.ifMatchIpPrefix.push(prefixList);
    }
    const routeTarget = APPLY_EXTCOMMUNITY_RT.exec(line)?.[1];
    if (routeTarget && !current.routeTargets.includes(routeTarget)) {
      current.routeTargets.push(routeTarget);
    }
  }

  for (const entry of policies.values()) {
    entry.sort((left, right) => left.node - right.node);
  }
  return policies;
}

/**
 * Parser LENIENT: entende tanto o formato de CONFIGURACAO quanto o de DISPLAY.
 *
 * Usado no read-back pos-commit (que roda `display route-policy`) e tambem
 * aceita a configuracao crua — em ambos os casos o resultado e o mesmo objeto.
 */
export function parseHuaweiRoutePolicyNodesLenient(
  text: string,
): Map<string, HuaweiRoutePolicyNode[]> {
  const merged = parseHuaweiRoutePolicyDisplay(text);
  for (const [policy, nodes] of parseHuaweiRoutePolicyNodes(text)) {
    merged.set(policy, nodes);
  }
  return merged;
}
