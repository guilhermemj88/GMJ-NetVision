import { parseHuaweiRoutePolicyNodesLenient } from './huawei-bgp-policy-parser';

// Porta de execucao do motor de mitigacao.
//
// Nesta entrega NAO existe executor real de Huawei: o unico implementado e o
// `MockMitigationExecutor`, que mantem um "equipamento" em memoria. Assim o
// fluxo inteiro (activate -> read-back -> verified) roda em mocks/preview,
// exatamente como pedido, sem nenhuma escrita real.
//
// A mitigacao e um PAR de nodes tratado como unidade logica:
//   bogonNode      -> deny   + if-match ip-prefix <BOGONS>
//   mitigationNode -> permit + if-match ip-prefix <PREFIX8to24> + RT
//
// O executor real entra numa entrega seguinte, implementando esta mesma porta
// (e continuara obrigado a fazer read-back: commit sozinho nunca e prova).

export interface MitigationActivationInput {
  policyName: string;
  bogonNode: number;
  mitigationNode: number;
  rt: string;
  /** Prefix-list do node de DENY (config do motor, nunca do Telegram/n8n). */
  bogonPrefixList: string;
  /** Prefix-list do node que aplica a RT. */
  targetPrefixList: string;
}

export interface MitigationRemovalInput {
  policyName: string;
  bogonNode: number;
  mitigationNode: number;
}

export interface MitigationExecutorResult {
  /** Saida textual do equipamento (nunca usada como prova isolada). */
  output: string;
}

export interface MitigationExecutor {
  /** READ-ONLY: estado atual da route-policy, usado no read-back. */
  readRoutePolicy(policyName: string): Promise<string>;
  activate(input: MitigationActivationInput): Promise<MitigationExecutorResult>;
  remove(input: MitigationRemovalInput): Promise<MitigationExecutorResult>;
}

interface MockNode {
  action: 'permit' | 'deny';
  ifMatchIpPrefix: string[];
  routeTargets: string[];
}

interface MockPolicy {
  /** node -> conteudo do node */
  nodes: Map<number, MockNode>;
}

/**
 * Executor de simulacao: guarda o estado em memoria para que o read-back
 * realmente comprove o efeito (os DOIS nodes, com acao, prefix-list e RT).
 */
export class MockMitigationExecutor implements MitigationExecutor {
  private readonly policies = new Map<string, MockPolicy>();
  readonly calls: string[] = [];

  private policy(policyName: string): MockPolicy {
    const existente = this.policies.get(policyName);
    if (existente) return existente;
    const nova: MockPolicy = { nodes: new Map() };
    this.policies.set(policyName, nova);
    return nova;
  }

  /** Pre-carrega uma policy como se ja existisse no equipamento (nodes PERMIT). */
  seedPolicy(policyName: string, nodes: readonly number[]): void {
    const policy = this.policy(policyName);
    for (const node of nodes) {
      if (!policy.nodes.has(node)) {
        policy.nodes.set(node, { action: 'permit', ifMatchIpPrefix: [], routeTargets: [] });
      }
    }
  }

  seedNodeRouteTarget(policyName: string, node: number, routeTarget: string): void {
    const policy = this.policy(policyName);
    const atual = policy.nodes.get(node) ?? {
      action: 'permit' as const,
      ifMatchIpPrefix: [],
      routeTargets: [],
    };
    if (!atual.routeTargets.includes(routeTarget)) atual.routeTargets.push(routeTarget);
    policy.nodes.set(node, atual);
  }

  /** Util nos testes: cria um node exatamente como pedido. */
  seedNode(
    policyName: string,
    node: number,
    conteudo: Partial<Pick<MockNode, 'action' | 'ifMatchIpPrefix' | 'routeTargets'>>,
  ): void {
    const policy = this.policy(policyName);
    policy.nodes.set(node, {
      action: conteudo.action ?? 'permit',
      ifMatchIpPrefix: [...(conteudo.ifMatchIpPrefix ?? [])],
      routeTargets: [...(conteudo.routeTargets ?? [])],
    });
  }

  async readRoutePolicy(policyName: string): Promise<string> {
    this.calls.push(`display route-policy ${policyName}`);
    const policy = this.policies.get(policyName);
    if (!policy) return `Error: The route-policy ${policyName} does not exist.\n`;
    const lines: string[] = [];
    for (const [node, conteudo] of [...policy.nodes.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`route-policy ${policyName} ${conteudo.action} node ${node}`);
      for (const prefixList of conteudo.ifMatchIpPrefix) {
        lines.push(` if-match ip-prefix ${prefixList}`);
      }
      for (const rt of conteudo.routeTargets) {
        lines.push(` apply extcommunity rt ${rt} additive`);
      }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  async activate(input: MitigationActivationInput): Promise<MitigationExecutorResult> {
    const commands = [
      'system-view',
      `route-policy ${input.policyName} deny node ${input.bogonNode}`,
      ` if-match ip-prefix ${input.bogonPrefixList}`,
      `route-policy ${input.policyName} permit node ${input.mitigationNode}`,
      ` if-match ip-prefix ${input.targetPrefixList}`,
      ` apply extcommunity rt ${input.rt} additive`,
      'commit',
    ];
    this.calls.push(...commands);
    const policy = this.policy(input.policyName);
    policy.nodes.set(input.bogonNode, {
      action: 'deny',
      ifMatchIpPrefix: [input.bogonPrefixList],
      routeTargets: [],
    });
    policy.nodes.set(input.mitigationNode, {
      action: 'permit',
      ifMatchIpPrefix: [input.targetPrefixList],
      routeTargets: [input.rt],
    });
    return { output: 'MOCK: par de nodes aplicado em memoria' };
  }

  async remove(input: MitigationRemovalInput): Promise<MitigationExecutorResult> {
    const commands = [
      'system-view',
      `undo route-policy ${input.policyName} node ${input.bogonNode}`,
      `undo route-policy ${input.policyName} node ${input.mitigationNode}`,
      'commit',
    ];
    this.calls.push(...commands);
    const policy = this.policies.get(input.policyName);
    if (policy) {
      policy.nodes.delete(input.bogonNode);
      policy.nodes.delete(input.mitigationNode);
    }
    return { output: 'MOCK: par de nodes removido em memoria' };
  }
}

export interface MitigationPairLabelsInput {
  bogonPrefixList: string;
  targetPrefixList: string;
}

export interface MitigationPairVerification {
  verified: boolean;
  summary: string;
  bogonOk: boolean;
  mitigationOk: boolean;
  /** Um dos dois nodes esta certo e o outro nao (reconciliation required). */
  partial: boolean;
}

/**
 * Read-back da ATIVACAO: os DOIS nodes precisam estar completos.
 *
 *  - BOGONS: existe, e DENY e tem `if-match ip-prefix <bogonPrefixList>`;
 *  - mitigacao: existe, e PERMIT, tem `if-match ip-prefix <targetPrefixList>`
 *    E aplica a RT esperada.
 *
 * RT correta sem a prefix-list alvo NAO e sucesso.
 */
export function verifyActivation(
  policyName: string,
  readBack: string,
  pair: { bogonNode: number; mitigationNode: number },
  rt: string,
  labels: MitigationPairLabelsInput,
): MitigationPairVerification {
  // Read-back real vem do `display route-policy` (formato display); o parser
  // lenient entende esse formato E o de configuracao.
  const nodes = parseHuaweiRoutePolicyNodesLenient(readBack).get(policyName) ?? [];
  const bogon = nodes.find((entry) => entry.node === pair.bogonNode);
  const mitigation = nodes.find((entry) => entry.node === pair.mitigationNode);

  const bogonOk =
    Boolean(bogon) &&
    bogon?.action === 'deny' &&
    (bogon?.ifMatchIpPrefix ?? []).includes(labels.bogonPrefixList);
  const mitigationOk =
    Boolean(mitigation) &&
    mitigation?.action === 'permit' &&
    (mitigation?.ifMatchIpPrefix ?? []).includes(labels.targetPrefixList) &&
    (mitigation?.routeTargets ?? []).includes(rt);

  const detalhes: string[] = [];
  if (!bogon) detalhes.push(`node BOGONS ${pair.bogonNode} ausente`);
  else if (bogon.action !== 'deny') detalhes.push(`node BOGONS ${pair.bogonNode} nao e deny`);
  else if (!bogon.ifMatchIpPrefix.includes(labels.bogonPrefixList)) {
    detalhes.push(`node BOGONS ${pair.bogonNode} sem if-match ip-prefix ${labels.bogonPrefixList}`);
  }
  if (!mitigation) detalhes.push(`node de mitigacao ${pair.mitigationNode} ausente`);
  else if (mitigation.action !== 'permit') {
    detalhes.push(`node de mitigacao ${pair.mitigationNode} nao e permit`);
  } else if (!mitigation.ifMatchIpPrefix.includes(labels.targetPrefixList)) {
    detalhes.push(
      `node de mitigacao ${pair.mitigationNode} sem if-match ip-prefix ${labels.targetPrefixList}`,
    );
  } else if (!mitigation.routeTargets.includes(rt)) {
    detalhes.push(`node de mitigacao ${pair.mitigationNode} sem a RT ${rt}`);
  }

  const verified = bogonOk && mitigationOk;
  return {
    verified,
    bogonOk,
    mitigationOk,
    partial: (bogonOk || mitigationOk) && !verified,
    summary: verified
      ? `par ativo: deny node ${pair.bogonNode} (${labels.bogonPrefixList}) + permit node ${pair.mitigationNode} (${labels.targetPrefixList} + RT ${rt})`
      : detalhes.join('; '),
  };
}

/**
 * Read-back da RETIRADA: os DOIS nodes precisam ter sumido.
 * Se apenas um sumiu, a mitigacao NAO esta retirada (reconciliation required).
 */
export function verifyRemoval(
  policyName: string,
  readBack: string,
  pair: { bogonNode: number; mitigationNode: number },
): MitigationPairVerification {
  const nodes = parseHuaweiRoutePolicyNodesLenient(readBack).get(policyName) ?? [];
  const bogonSumiu = !nodes.some((entry) => entry.node === pair.bogonNode);
  const mitigationSumiu = !nodes.some((entry) => entry.node === pair.mitigationNode);
  const verified = bogonSumiu && mitigationSumiu;
  const restantes: string[] = [];
  if (!bogonSumiu) restantes.push(`BOGONS ${pair.bogonNode}`);
  if (!mitigationSumiu) restantes.push(`mitigacao ${pair.mitigationNode}`);

  return {
    verified,
    bogonOk: bogonSumiu,
    mitigationOk: mitigationSumiu,
    partial: !verified && (bogonSumiu || mitigationSumiu),
    summary: verified
      ? `par removido: nodes ${pair.bogonNode} e ${pair.mitigationNode} ausentes`
      : `retirada incompleta: ainda presente(s) ${restantes.join(', ')}`,
  };
}
