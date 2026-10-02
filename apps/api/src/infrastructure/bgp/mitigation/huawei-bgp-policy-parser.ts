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

import { normalizeIpAddress } from '@gmj/shared';

/** Address-family de UNICAST (a unica que traz route-policy de import por peer). */
export type HuaweiBgpAddressFamily = 'IPV4' | 'IPV6';

/**
 * Chave canonica dos mapas: familia + endereco/nome.
 *
 * Sem a familia, um peer-group (ou um texto de peer) repetido em `ipv4-family` e
 * `ipv6-family` colidiria e uma familia herdaria a policy da outra - a causa do
 * bug de correlacao. A chave usa um separador que nunca aparece em nomes VRP.
 */
export function bgpPolicyKey(addressFamily: HuaweiBgpAddressFamily, key: string): string {
  return `${addressFamily}\u0000${key}`;
}

export interface HuaweiBgpPolicyConfiguration {
  /** `${family}\0${peerAddressNormalizado}` -> policy IN declarada no peer */
  directPeerPolicies: Map<string, string>;
  /** `${family}\0${peerAddressNormalizado}` -> peer-group */
  peerGroups: Map<string, string>;
  /** `${family}\0${peerGroup}` -> policy IN */
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

/** `peer 10.0.0.1 route-policy PL-IN import` (import apenas). Avaliada por LINHA. */
const PEER_POLICY_IMPORT =
  /^[ \t]*peer[ \t]+(\S+)[ \t]+route-policy[ \t]+(\S+)[ \t]+import[ \t]*$/i;
/** `peer 10.0.0.1 group PL-HORIZONTES` */
const PEER_GROUP = /^[ \t]*peer[ \t]+(\S+)[ \t]+group[ \t]+(\S+)[ \t]*$/i;
/** ` ipv4-family unicast` / ` ipv6-family unicast` (cabeçalho de bloco do VRP). */
const FAMILY_HEADER = /^[ \t]*(ipv4|ipv6)-family[ \t]+(\S+)/i;
/** `route-policy PL-IN permit node 11` */
const ROUTE_POLICY_NODE =
  /^[ \t]*route-policy[ \t]+(\S+)[ \t]+(permit|deny)[ \t]+node[ \t]+(\d+)[ \t]*$/i;
/** ` apply extcommunity rt 268568:660 additive` (dentro de um node) */
const APPLY_EXTCOMMUNITY_RT = /^[ \t]*apply[ \t]+extcommunity[ \t]+rt[ \t]+(\S+)/i;
/** ` if-match ip-prefix PREFIX8to24` (dentro de um node) */
const IF_MATCH_IP_PREFIX = /^[ \t]*if-match[ \t]+ip-prefix[ \t]+(\S+)/i;

/**
 * Parser STATEFUL por address-family do dump
 * `display current-configuration configuration bgp`.
 *
 * O VRP imprime o peer no bloco GLOBAL (`as-number`, `description`) e a policy
 * EFETIVA dentro de `ipv4-family unicast` / `ipv6-family unicast`. Uma varredura
 * global (regex sobre o texto inteiro) misturava familias: o mesmo texto de peer
 * ou de peer-group podia resolver a policy de OUTRA familia, e blocos que nao
 * sao unicast (ex.: `ipv4-family flow`) entravam como se fossem IPv4.
 *
 * Regras:
 *  - apenas `route-policy <nome> import` conta (export NUNCA vira IN);
 *  - a policy so vale DENTRO do bloco `<family> unicast` correspondente, sem
 *    fallback cross-family;
 *  - qualquer outro contexto (`ipv4-family flow`, multicast, vpn-instance...)
 *    nao alimenta IPV4/IPV6;
 *  - linha em coluna 0 encerra o bloco corrente (`#`, `bgp 64500`, `return`).
 */
export function parseHuaweiBgpPolicyConfiguration(config: string): HuaweiBgpPolicyConfiguration {
  const directPeerPolicies = new Map<string, string>();
  const peerGroups = new Map<string, string>();
  const groupPolicies = new Map<string, string>();

  let family: HuaweiBgpAddressFamily | null = null;

  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) continue;

    const header = FAMILY_HEADER.exec(line);
    if (header) {
      const kind = header[1]?.toLowerCase();
      const subtype = header[2]?.toLowerCase();
      // Somente `<ipv4|ipv6>-family unicast` interessa a mitigacao.
      family = subtype === 'unicast' ? (kind === 'ipv6' ? 'IPV6' : 'IPV4') : null;
      continue;
    }

    // Linha em coluna 0 fecha o bloco corrente (topo do `bgp`, `#`, `return`).
    if (!/^[ \t]/.test(line)) {
      family = null;
      continue;
    }
    if (!family) continue;

    const peerPolicy = PEER_POLICY_IMPORT.exec(line);
    if (peerPolicy) {
      const key = peerPolicy[1];
      const policyName = peerPolicy[2];
      if (key && policyName) {
        if (isAddressLike(key)) {
          // Endereco IP: chave CANONICA (o VRP imprime IPv6 em MAIUSCULAS).
          const normalized = normalizeIpAddress(key);
          if (normalized) directPeerPolicies.set(bgpPolicyKey(family, normalized), policyName);
        } else {
          // Nome de peer-group: NUNCA e normalizado como IP.
          groupPolicies.set(bgpPolicyKey(family, key), policyName);
        }
      }
      continue;
    }

    const peerGroup = PEER_GROUP.exec(line);
    if (peerGroup) {
      const peerAddress = peerGroup[1];
      const groupName = peerGroup[2];
      if (!peerAddress || !groupName) continue;
      const normalizedPeer = normalizeIpAddress(peerAddress);
      // Fail-closed: associacao invalida nao e persistida.
      if (!normalizedPeer) continue;
      peerGroups.set(bgpPolicyKey(family, normalizedPeer), groupName);
    }
  }

  return { directPeerPolicies, peerGroups, groupPolicies };
}

// Resolve a policy de import de um peer DENTRO da family informada: declaracao
// direta vence; na ausencia dela, herda a policy do peer-group DA MESMA FAMILY.
// Nunca existe fallback cross-family (IPv4 nao herda IPv6 e vice-versa).
export function resolvePeerInboundPolicy(
  peerAddress: string,
  addressFamily: HuaweiBgpAddressFamily,
  configuration: HuaweiBgpPolicyConfiguration,
): string | null {
  // Defensivo: o chamador pode passar a forma crua do equipamento.
  const normalized = normalizeIpAddress(peerAddress) ?? peerAddress;
  const direct = configuration.directPeerPolicies.get(bgpPolicyKey(addressFamily, normalized));
  if (direct) return direct;
  const group = configuration.peerGroups.get(bgpPolicyKey(addressFamily, normalized));
  if (!group) return null;
  return configuration.groupPolicies.get(bgpPolicyKey(addressFamily, group)) ?? null;
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
