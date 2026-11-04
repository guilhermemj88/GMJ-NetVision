import { parseHuaweiRoutePolicyNodesLenient } from './huawei-bgp-policy-parser';
import { AGLINK_BGP_PLAN, aglinkBaselineIntact, bgpPlanLabels } from './aglink-bgp-plan';
import { DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
import type { PreservedClauses } from './mitigation-policy-clauses';
import type { MitigationBaselineRecord } from './mitigation-baseline-record';
import { exactMitigationNodes, precedenceConflictNodes } from './mitigation-contract';
import { buildMitigationActivateCommands, buildMitigationRemovalCommands } from './mitigation-write-guard';

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
  /**
   * Atributos NORMAIS do cliente que o node de mitigacao precisa repor
   * (derivados do baseline fisico pelo mesmo mecanismo para toda policy).
   */
  preservedClauses?: PreservedClauses;
  preflightBaseline?: MitigationBaselineRecord;
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

export interface MockMitigationExecutorOptions {
  /**
   * Node NORMAL preexistente do "cliente" simulado, materializado junto com a
   * policy. `null` = nenhum baseline (usado para exercitar o caminho
   * fail-closed). Default: node 10 com `if-match ip-prefix <lista autorizada>`.
   */
  baseline?: { node: number; targetPrefixList: string } | null;
}

/**
 * Executor de simulacao: guarda o estado em memoria para que o read-back
 * realmente comprove o efeito (os DOIS nodes, com acao, prefix-list e RT).
 */
export class MockMitigationExecutor implements MitigationExecutor {
  private readonly policies = new Map<string, MockPolicy>();
  private readonly baseline: { node: number; targetPrefixList: string } | null;
  readonly calls: string[] = [];

  constructor(
    options: MockMitigationExecutorOptions = {
      baseline: { node: 10, targetPrefixList: DEFAULT_TARGET_PREFIX_LIST },
    },
  ) {
    this.baseline =
      options.baseline === undefined
        ? { node: 10, targetPrefixList: DEFAULT_TARGET_PREFIX_LIST }
        : options.baseline;
  }

  private policy(policyName: string): MockPolicy {
    const existente = this.policies.get(policyName);
    if (existente) return existente;
    const nova: MockPolicy = { nodes: new Map() };
    // ESTADO INICIAL: um cliente real ja tem seu node normal na policy. O
    // ACTIVATE continua criando SOMENTE os nodes 1 e 2.
    if (this.baseline) {
      nova.nodes.set(this.baseline.node, {
        action: 'permit',
        ifMatchIpPrefix: [this.baseline.targetPrefixList],
        routeTargets: [],
      });
    }
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
        lines.push(` apply extcommunity rt ${rt}`);
      }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  async activate(input: MitigationActivationInput): Promise<MitigationExecutorResult> {
    const commands = buildMitigationActivateCommands(input);
    this.calls.push(...commands);
    const policy = this.policy(input.policyName);
    policy.nodes.set(input.bogonNode, {
      action: 'deny',
      ifMatchIpPrefix: [input.bogonPrefixList],
      routeTargets: [],
    });
    policy.nodes.set(input.mitigationNode, {
      action: 'permit',
      ifMatchIpPrefix: [],
      routeTargets: [input.rt],
    });
    return { output: 'MOCK: par de nodes aplicado em memoria' };
  }

  async remove(input: MitigationRemovalInput): Promise<MitigationExecutorResult> {
    // Paridade com o executor real: o mock usa o MESMO builder canônico. Assim
    // um par fora de 1/2 (ex.: nodes 10/1000) e recusado aqui também, em vez de
    // "passar" num teste que o equipamento recusaria.
    const commands = buildMitigationRemovalCommands({
      policyName: input.policyName,
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
    });
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
  _preserved?: PreservedClauses,
): MitigationPairVerification {
  labels = bgpPlanLabels(policyName, labels);
  // Read-back real vem do `display route-policy` (formato display); o parser
  // lenient entende esse formato E o de configuracao.
  const nodes = parseHuaweiRoutePolicyNodesLenient(readBack).get(policyName) ?? [];
  const bogon = nodes.find((entry) => entry.node === pair.bogonNode);
  const mitigation = nodes.find((entry) => entry.node === pair.mitigationNode);

  const exact = exactMitigationNodes(readBack, policyName);
  const contractOk = pair.bogonNode === 1 && pair.mitigationNode === 2 && rt === '268568:660' && labels.bogonPrefixList === 'BOGONS';
  const bogonOk = contractOk && exact.bogonOk;
  const mitigationOk = contractOk && exact.mitigationOk;
  // Node 0 (ou qualquer node anterior a 1) tem precedencia sobre o par: os
  // nodes 1/2 podem estar exatamente corretos e a mitigacao continuar inerte.
  // Nunca declarar verificado nesse caso.
  const precedence = precedenceConflictNodes(nodes);
  const precedenceOk = precedence.length === 0;
  const detalhes: string[] = [];
  if (!precedenceOk)
    detalhes.push(
      `node ${precedence.join(', ')} precede o par reservado: mitigacao pode nao ser aplicada`,
    );
  if (!bogon || !bogonOk) detalhes.push('node 1 divergente: exige deny + somente if-match ip-prefix BOGONS');
  if (!mitigation || !mitigationOk) detalhes.push('node 2 divergente: exige permit + somente apply extcommunity rt 268568:660, sem additive');

  // Baseline AGLINK (compatibilidade): a policy de referencia continua exigindo
  // node 10 intacto. Nao e um caminho separado de escrita — e a mesma checagem
  // de "outros nodes nao foram alterados".
  const semanticOk = policyName !== AGLINK_BGP_PLAN.policy || aglinkBaselineIntact(readBack);
  if (!semanticOk) detalhes.push('AGLINK: baseline (node 10/1000) divergente');
  const verified = bogonOk && mitigationOk && semanticOk && precedenceOk;
  return {
    verified,
    bogonOk,
    mitigationOk,
    partial: (bogonOk || mitigationOk) && !verified,
    summary: verified
      ? `par ativo: deny node ${pair.bogonNode} (${labels.bogonPrefixList}) + permit node ${pair.mitigationNode} (permit irrestrito + RT exclusiva ${rt})`
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
  const baselineOk = policyName !== AGLINK_BGP_PLAN.policy || aglinkBaselineIntact(readBack);
  const verified = bogonSumiu && mitigationSumiu && baselineOk;
  const restantes: string[] = [];
  if (!baselineOk) restantes.push('baseline AGLINK divergente');
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
