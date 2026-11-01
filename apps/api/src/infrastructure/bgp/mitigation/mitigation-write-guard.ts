import { bgpPlanLabels } from './aglink-bgp-plan';
import { buildRouteTargetLine, type PreservedClauses } from './mitigation-policy-clauses';

/**
 * Guarda estrutural da ESCrita de mitigacao.
 *
 * O caminho READ-ONLY continua protegido pela allowlist positiva do worker. A
 * escrita, por definicao, envia comandos proibidos para aquela allowlist; ela
 * ganha uma guarda propria, AINDA MAIS ESTREITA: os comandos nao vem de texto
 * livre — sao MONTADOS a partir do par/nome ja validados e depois comparados
 * contra a lista canonica. Se qualquer linha divergir, nada e enviado.
 *
 * Isto e defesa em profundidade: mesmo que um bug de chamador passe um nome
 * esquisito, o comando resultante nao casa com a lista canonica e o SSH nem e
 * tocado.
 */

/** Nome de policy/prefix-list: sem espaco, sem metacaractere de CLI. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** Route-target no formato `ASN:valor`. */
const SAFE_RT = /^[0-9]{1,10}:[0-9]{1,10}$/;

export interface MitigationWritePlan {
  policyName: string;
  bogonNode: number;
  mitigationNode: number;
  rt: string;
  bogonPrefixList: string;
  targetPrefixList: string;
}

export function assertSafePolicyName(name: string, label = 'policy'): string {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    throw new Error(`MITIGATION_WRITE_REJECTED: ${label} invalido`);
  }
  return name;
}

export function assertSafePrefixListName(name: string, label = 'prefix-list'): string {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    throw new Error(`MITIGATION_WRITE_REJECTED: ${label} invalido`);
  }
  return name;
}

export function assertSafeRouteTarget(rt: string): string {
  if (typeof rt !== 'string' || !SAFE_RT.test(rt)) {
    throw new Error('MITIGATION_WRITE_REJECTED: route-target invalida');
  }
  return rt;
}

/** Node temporario: inteiro 1..9 (mesma faixa do planejador). */
export function assertSafeNode(node: number, label = 'node'): number {
  if (!Number.isInteger(node) || node < 1 || node > 9) {
    throw new Error(`MITIGATION_WRITE_REJECTED: ${label} fora da faixa 1..9`);
  }
  return node;
}

function normalizePlan(plan: MitigationWritePlan): MitigationWritePlan {
  return {
    policyName: assertSafePolicyName(plan.policyName, 'policy'),
    bogonNode: assertSafeNode(plan.bogonNode, 'bogonNode'),
    mitigationNode: assertSafeNode(plan.mitigationNode, 'mitigationNode'),
    rt: assertSafeRouteTarget(plan.rt),
    bogonPrefixList: assertSafePrefixListName(plan.bogonPrefixList, 'bogonPrefixList'),
    targetPrefixList: assertSafePrefixListName(plan.targetPrefixList, 'targetPrefixList'),
  };
}

/**
 * Comandos canonicos do ACTIVATE (na mesma ordem do preview).
 *
 * MECANISMO UNICO para qualquer policy IN:
 *   node 1 -> deny   + if-match <bogonPrefixList>
 *   node 2 -> permit + if-match <targetPrefixList>
 *             + atributos NORMAIS do cliente (derivados do baseline fisico)
 *             + `apply extcommunity rt <RTs normais> rt <RT mitigacao> additive`
 *
 * `preserved` vem do proprio equipamento (`derivePreservedClauses`). Sem ele o
 * builder NAO gera comandos: um node de mitigacao apenas com a RT poderia
 * aceitar prefixos que o node normal do cliente restringia.
 */
export function buildMitigationActivateCommands(
  plan: MitigationWritePlan,
  preserved?: PreservedClauses,
): string[] {
  const safe = normalizePlan(bgpPlanLabels(plan.policyName, plan));
  assertDerivedBaseline(preserved);
  return [
    'system-view',
    `route-policy ${safe.policyName} deny node ${safe.bogonNode}`,
    ` if-match ip-prefix ${safe.bogonPrefixList}`,
    `route-policy ${safe.policyName} permit node ${safe.mitigationNode}`,
    ` if-match ip-prefix ${safe.targetPrefixList}`,
    ...preserved.otherApplies.map((clause) => ` ${clause}`),
    ...(preserved.localPreference ? [` ${preserved.localPreference}`] : []),
    ` ${buildRouteTargetLine(preserved.routeTargets, safe.rt)}`,
    'commit',
  ];
}

/**
 * Defesa em profundidade (auditoria B-final): o builder e o ULTIMO ponto antes
 * de qualquer escrita — inclusive no executor MOCK — e recusa gerar a lista
 * quando o baseline nao foi derivado ou quando a derivacao e insegura.
 */
function assertDerivedBaseline(
  preserved?: PreservedClauses,
): asserts preserved is PreservedClauses {
  if (!preserved || preserved.baselineNode === null) {
    throw new Error('MITIGATION_BASELINE_NOT_DERIVABLE');
  }
  if (!preserved.safe) {
    throw new Error(`MITIGATION_BASELINE_UNSAFE: ${preserved.unsafeReasons.join('; ')}`);
  }
}

/** Comandos canonicos do REMOVE (retirada dos DOIS nodes + commit). */
export function buildMitigationRemovalCommands(
  plan: Pick<MitigationWritePlan, 'policyName' | 'bogonNode' | 'mitigationNode'>,
): string[] {
  const policyName = assertSafePolicyName(plan.policyName, 'policy');
  const bogonNode = assertSafeNode(plan.bogonNode, 'bogonNode');
  const mitigationNode = assertSafeNode(plan.mitigationNode, 'mitigationNode');
  return [
    'system-view',
    // VRP V8 (confirmado em equipamento real): a remocao de node NAO leva
    // deny/permit — a acao e o conteudo do node, nao parte do comando.
    `undo route-policy ${policyName} node ${bogonNode}`,
    `undo route-policy ${policyName} node ${mitigationNode}`,
    'commit',
  ];
}

/**
 * Confere que a lista pronta e EXATAMENTE a canonica (mesmo tamanho, mesma
 * ordem, mesmo conteudo). Usado imediatamente antes de tocar o SSH.
 */
export function assertCanonicalMitigationCommands(
  commands: readonly string[],
  expected: readonly string[],
): void {
  if (commands.length !== expected.length) {
    throw new Error('MITIGATION_WRITE_REJECTED: quantidade de comandos inesperada');
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (commands[index] !== expected[index]) {
      throw new Error(`MITIGATION_WRITE_REJECTED: comando ${index + 1} fora do padrao canonico`);
    }
  }
}

/**
 * Sanidade final da lista que vai para o SSH: forma conhecida (system-view ...
 * commit), sem quebra de linha e sem metacaractere de shell/CLI. Nao substitui a
 * allowlist do caminho read-only: e o portao do caminho de escrita.
 */
export function assertMitigationCommandShape(commands: readonly string[]): void {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('MITIGATION_WRITE_REJECTED: lista de comandos vazia');
  }
  for (const command of commands) {
    if (typeof command !== 'string' || /[\r\n]/.test(command) || /[;&`$<>|]/.test(command)) {
      throw new Error('MITIGATION_WRITE_REJECTED: comando com caractere proibido');
    }
    if (!/^[ -~]+$/.test(command)) {
      throw new Error('MITIGATION_WRITE_REJECTED: comando fora do ASCII imprimivel');
    }
  }
  const first = commands[0]?.trim().toLowerCase();
  const last = commands[commands.length - 1]?.trim().toLowerCase();
  if (first !== 'system-view' || last !== 'commit') {
    throw new Error('MITIGATION_WRITE_REJECTED: sequencia system-view..commit ausente');
  }
}
