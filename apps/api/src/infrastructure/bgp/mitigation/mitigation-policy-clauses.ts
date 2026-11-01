import { appliedRouteTargets } from './huawei-bgp-policy-parser';

/**
 * Clausulas de um node de route-policy + derivacao dos atributos NORMAIS que o
 * node de mitigacao precisa repor.
 *
 * Por que repor: o VRP encerra a avaliacao no primeiro node que casa. Quando o
 * node de mitigacao casa, o node normal do cliente NAO roda — logo tudo o que
 * ele aplicava (local-preference, route-targets, communities...) precisa ser
 * reaplicado, e a RT de mitigacao entra apenas ACRESCENTANDO (`additive`).
 *
 * Mecanismo UNICO: vale para qualquer policy IN. Nada aqui depende de
 * fornecedor, de nome de cliente ou de uma policy especifica.
 */

export interface PolicyNodeClauses {
  action: 'permit' | 'deny';
  /** Cláusulas `if-match` / `apply` / `goto` normalizadas, na ordem do texto. */
  clauses: string[];
}

export interface PreservedClauses {
  /** Node normal de onde os atributos foram derivados (referência/auditoria). */
  baselineNode: number | null;
  /**
   * Como o baseline foi identificado:
   *  - `PREFIX_LIST`: node permit com `if-match ip-prefix <lista autorizada>`;
   *  - `CATCH_ALL`: node permit sem nenhum `if-match` (cobre os prefixos).
   */
  baselineMatch: 'PREFIX_LIST' | 'CATCH_ALL' | null;
  /** `apply local-preference N` (último vence, como no VRP). */
  localPreference: string | null;
  /** RTs normais do cliente, na ordem em que aparecem. */
  routeTargets: string[];
  /** Demais `apply` (community, as-path, cost...) copiados verbatim. */
  otherApplies: string[];
  /** Cláusulas exatas esperadas no node de mitigacao (para o readback). */
  expectedClauses: string[];
  /**
   * `false` = o node de mitigacao NAO reproduz fielmente o comportamento do
   * node original. Nesse caso o ACTIVATE e bloqueado (fail-closed) — nunca se
   * cria um node 2 mais permissivo que o original.
   */
  safe: boolean;
  /** Motivos objetivos da recusa (vazio quando `safe`). */
  unsafeReasons: string[];
}

/** `apply` cuja semantica conseguimos reproduzir literalmente. */
const REPRODUCIBLE_APPLY =
  /^apply (local-preference \d+|extcommunity rt\b|community\b|as-path\b|cost\b|med \d+|origin \S+|preferred-value \d+)/i;

const POLICY_NODE_CONFIG =
  /^route-policy[ \t]+(\S+)[ \t]+(permit|deny)[ \t]+node[ \t]+(\d+)[ \t]*$/i;
const POLICY_NODE_DISPLAY = /^Route-policy:[ \t]*(\S+)[ \t]*$/i;
const NODE_HEADER_DISPLAY = /^(permit|deny)[ \t]*:[ \t]*(\d+)\b/i;
const CLAUSE = /^(if-match|apply|goto)[ \t]+(?!clauses\b)\S/i;

export function normalizeClause(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Clausulas de UM node. Entende os dois formatos reais:
 *  - configuracao: `route-policy PL permit node 10` + linhas indentadas;
 *  - display:      `Route-policy: PL` + `permit : 10` + clausulas indentadas.
 */
export function policyNodeClauses(
  text: string,
  policyName: string,
  node: number,
): PolicyNodeClauses | null {
  let currentPolicy: string | null = null;
  let current: PolicyNodeClauses | null = null;
  let found: PolicyNodeClauses | null = null;
  const close = (): void => {
    if (current && found === null) found = current;
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const config = POLICY_NODE_CONFIG.exec(raw.trim());
    const display = POLICY_NODE_DISPLAY.exec(raw.trim());
    if (config) {
      close();
      currentPolicy = config[1]!;
      current =
        currentPolicy === policyName && Number(config[3]) === node
          ? { action: config[2]!.toLowerCase() as 'permit' | 'deny', clauses: [] }
          : null;
      continue;
    }
    if (display) {
      close();
      currentPolicy = display[1]!;
      continue;
    }
    const header = NODE_HEADER_DISPLAY.exec(raw.trim());
    if (header) {
      close();
      current =
        currentPolicy === policyName && Number(header[2]) === node
          ? { action: header[1]!.toLowerCase() as 'permit' | 'deny', clauses: [] }
          : null;
      continue;
    }
    // Linha nao indentada (fora de bloco) encerra o node e o contexto.
    if (raw.trim().length > 0 && !/^[ \t]/.test(raw)) {
      close();
      if (raw.trim() === '#' || raw.trim().startsWith('<')) currentPolicy = null;
      continue;
    }
    if (current && CLAUSE.test(raw.trim())) current.clauses.push(normalizeClause(raw));
  }
  close();
  return found;
}

export function equalClauses(
  actual: readonly string[] | null,
  expected: readonly string[],
): boolean {
  if (actual === null) return false;
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

/** `apply extcommunity rt 268568:110 additive` -> ['268568:110'] */
function rtValuesOf(clause: string): string[] {
  return appliedRouteTargets(clause);
}

/**
 * Deriva, do estado FISICO atual, o que o node de mitigacao deve repor.
 *
 * Regra: primeiro node `permit` cuja prefix-list seja a lista autorizada do
 * cliente (a mesma que a mitigacao usa). Sem esse node nao ha atributos a
 * preservar e a mitigacao segue apenas com a RT (`additive`).
 */
export function derivePreservedClauses(
  text: string,
  policyName: string,
  targetPrefixList: string,
  mitigationRt: string,
): PreservedClauses {
  const nodes = policyNodes(text, policyName);
  const baseline = findBaselinePermitNode(nodes, targetPrefixList);
  const clauses = baseline?.clauses ?? [];
  let localPreference: string | null = null;
  const routeTargets: string[] = [];
  const otherApplies: string[] = [];
  for (const clause of clauses) {
    if (!/^apply\b/i.test(clause)) continue;
    if (/^apply local-preference \d+$/i.test(clause)) {
      localPreference = clause;
      continue;
    }
    if (/^apply extcommunity rt\b/i.test(clause)) {
      for (const rt of rtValuesOf(clause)) {
        if (!routeTargets.includes(rt)) routeTargets.push(rt);
      }
      continue;
    }
    otherApplies.push(clause);
  }
  const rtLine = buildRouteTargetLine(routeTargets, mitigationRt);
  const expectedClauses = [
    `if-match ip-prefix ${targetPrefixList}`,
    ...otherApplies,
    ...(localPreference ? [localPreference] : []),
    rtLine,
  ];
  const unsafeReasons = baseline
    ? baselineUnsafeReasons(nodes, baseline, targetPrefixList, clauses)
    : [];
  return {
    baselineNode: baseline?.node ?? null,
    baselineMatch: baseline?.match ?? null,
    localPreference,
    routeTargets,
    otherApplies,
    expectedClauses,
    safe: baseline !== null && unsafeReasons.length === 0,
    unsafeReasons,
  };
}

/**
 * Valida que o node de mitigacao reproduz FIELMENTE o node original.
 *
 * Fail-closed e deliberadamente simples: qualquer construcao que nao sabemos
 * reproduzir (if-match adicional, goto, `apply` desconhecido) ou qualquer node
 * anterior que possa capturar as rotas antes do baseline BLOQUEIA o ACTIVATE.
 * Nao e um interpretador de route-policy — e um portao.
 */
function baselineUnsafeReasons(
  nodes: ReadonlyArray<{ node: number; action: 'permit' | 'deny'; clauses: string[] }>,
  baseline: { node: number; clauses: string[]; match: 'PREFIX_LIST' | 'CATCH_ALL' },
  targetPrefixList: string,
  clauses: readonly string[],
): string[] {
  const reasons: string[] = [];
  const wanted = `if-match ip-prefix ${targetPrefixList}`.toLowerCase();
  const ifMatches = clauses.filter((clause) => /^if-match\b/i.test(clause));
  if (ifMatches.length > 1) {
    reasons.push(`if-match adicional nao reproduzido: [${ifMatches.join(' | ')}]`);
  }
  if (clauses.some((clause) => /^goto\b/i.test(clause))) {
    reasons.push('node original usa goto');
  }
  for (const clause of clauses) {
    if (!/^apply\b/i.test(clause)) continue;
    if (!REPRODUCIBLE_APPLY.test(clause)) {
      reasons.push(`apply sem semantica reproduzivel: ${clause}`);
    }
  }
  for (const entry of nodes) {
    if (entry.node >= baseline.node) continue;
    const matchesTarget = entry.clauses.some((clause) => clause.toLowerCase() === wanted);
    const catchAll = !entry.clauses.some((clause) => /^if-match\b/i.test(clause));
    if (matchesTarget || catchAll) {
      reasons.push(
        `node anterior ${entry.node} (${entry.action}) pode capturar as rotas antes do node ${baseline.node}`,
      );
    }
  }
  return reasons;
}

function findBaselinePermitNode(
  nodes: ReadonlyArray<{ node: number; action: 'permit' | 'deny'; clauses: string[] }>,
  targetPrefixList: string,
): { node: number; clauses: string[]; match: 'PREFIX_LIST' | 'CATCH_ALL' } | null {
  const wanted = `if-match ip-prefix ${targetPrefixList}`.toLowerCase();
  let byPrefix: { node: number; clauses: string[]; match: 'PREFIX_LIST' } | null = null;
  let catchAll: { node: number; clauses: string[]; match: 'CATCH_ALL' } | null = null;
  for (const entry of nodes) {
    if (entry.action !== 'permit') continue;
    const ifMatches = entry.clauses.filter((clause) => /^if-match\b/i.test(clause));
    const matchesPrefix = entry.clauses.some((clause) => clause.toLowerCase() === wanted);
    if (matchesPrefix) {
      if (byPrefix === null || entry.node < byPrefix.node) {
        byPrefix = { node: entry.node, clauses: entry.clauses, match: 'PREFIX_LIST' };
      }
      continue;
    }
    // Node PERMIT sem nenhum if-match cobre os prefixos (catch-all). Só vale
    // como baseline quando NAO existe um node com a prefix-list autorizada —
    // e o node de mitigacao sempre fica mais restritivo que ele.
    if (ifMatches.length === 0 && (catchAll === null || entry.node < catchAll.node)) {
      catchAll = { node: entry.node, clauses: entry.clauses, match: 'CATCH_ALL' };
    }
  }
  return byPrefix ?? catchAll;
}

/**
 * Nodes NORMAIS do cliente vistos no REMOVE: `permit` que referencia a lista
 * autorizada e NAO carrega nenhuma RT de mitigacao. Eles nunca foram criados
 * pela mitigacao, logo nao podem ser confundidos com propriedade temporaria.
 *
 * O par esperado (`bogonNode` / `mitigationNode`) fica de fora do conjunto: se
 * ele nao casar exatamente, `resolveActivePair` continua bloqueando a retirada
 * — a ambiguidade permanece fail-closed.
 */
export function baselineNodesForRemoval(
  text: string,
  policyName: string,
  targetPrefixList: string,
  mitigationRts: readonly string[],
  pair: { bogonNode: number; mitigationNode: number },
): number[] {
  const rts = new Set(mitigationRts.filter((rt) => rt.length > 0));
  const wanted = `if-match ip-prefix ${targetPrefixList}`.toLowerCase();
  return policyNodes(text, policyName)
    .filter((entry) => entry.node !== pair.bogonNode && entry.node !== pair.mitigationNode)
    .filter((entry) => entry.action === 'permit')
    .filter((entry) => entry.clauses.some((clause) => clause.toLowerCase() === wanted))
    .filter((entry) =>
      entry.clauses
        .filter((clause) => /^apply extcommunity rt\b/i.test(clause))
        .flatMap((clause) => rtValuesOf(clause))
        .every((rt) => !rts.has(rt)),
    )
    .map((entry) => entry.node);
}

/** Todos os nodes de uma policy em UMA passada (config ou display). */
export function policyNodes(
  text: string,
  policyName: string,
): Array<{
  node: number;
  action: 'permit' | 'deny';
  clauses: string[];
}> {
  const nodes: Array<{ node: number; action: 'permit' | 'deny'; clauses: string[] }> = [];
  let currentPolicy: string | null = null;
  let current: { node: number; action: 'permit' | 'deny'; clauses: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const config = POLICY_NODE_CONFIG.exec(raw.trim());
    const display = POLICY_NODE_DISPLAY.exec(raw.trim());
    if (config) {
      currentPolicy = config[1]!;
      current =
        currentPolicy === policyName
          ? {
              node: Number(config[3]),
              action: config[2]!.toLowerCase() as 'permit' | 'deny',
              clauses: [],
            }
          : null;
      if (current) nodes.push(current);
      continue;
    }
    if (display) {
      currentPolicy = display[1]!;
      current = null;
      continue;
    }
    const header = NODE_HEADER_DISPLAY.exec(raw.trim());
    if (header) {
      current =
        currentPolicy === policyName
          ? {
              node: Number(header[2]),
              action: header[1]!.toLowerCase() as 'permit' | 'deny',
              clauses: [],
            }
          : null;
      if (current) nodes.push(current);
      continue;
    }
    if (raw.trim().length > 0 && !/^[ \t]/.test(raw)) {
      current = null;
      if (raw.trim() === '#' || raw.trim().startsWith('<')) currentPolicy = null;
      continue;
    }
    if (current && CLAUSE.test(raw.trim())) current.clauses.push(normalizeClause(raw));
  }
  return nodes;
}

/**
 * Uma UNICA instrucao `apply extcommunity` com as RTs normais + a RT de
 * mitigacao, sempre `additive`.
 *
 * Forma fisica confirmada no equipamento (VRP 8.220): nao existem nodes com
 * duas linhas `apply extcommunity`; a forma real e multi-RT em uma instrucao.
 * `additive` preserva as extended communities ja recebidas do peer.
 */
export function buildRouteTargetLine(
  preservedRouteTargets: readonly string[],
  mitigationRt: string,
): string {
  const ordered: string[] = [];
  for (const rt of [...preservedRouteTargets, mitigationRt]) {
    if (!ordered.includes(rt)) ordered.push(rt);
  }
  return `apply extcommunity rt ${ordered.join(' rt ')} additive`;
}
