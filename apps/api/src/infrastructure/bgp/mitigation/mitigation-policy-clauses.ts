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
  /** `apply local-preference N` (último vence, como no VRP). */
  localPreference: string | null;
  /** RTs normais do cliente, na ordem em que aparecem. */
  routeTargets: string[];
  /** Demais `apply` (community, as-path, cost...) copiados verbatim. */
  otherApplies: string[];
  /** Cláusulas exatas esperadas no node de mitigacao (para o readback). */
  expectedClauses: string[];
}

const POLICY_NODE_CONFIG = /^route-policy[ \t]+(\S+)[ \t]+(permit|deny)[ \t]+node[ \t]+(\d+)[ \t]*$/i;
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

export function equalClauses(actual: readonly string[] | null, expected: readonly string[]): boolean {
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
  const baseline = findBaselinePermitNode(text, policyName, targetPrefixList);
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
  return {
    baselineNode: baseline?.node ?? null,
    localPreference,
    routeTargets,
    otherApplies,
    expectedClauses,
  };
}

/** Todos os nodes de uma policy em UMA passada (config ou display). */
export function policyNodes(text: string, policyName: string): Array<{
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

function findBaselinePermitNode(
  text: string,
  policyName: string,
  targetPrefixList: string,
): { node: number; clauses: string[] } | null {
  const wanted = `if-match ip-prefix ${targetPrefixList}`.toLowerCase();
  let best: { node: number; clauses: string[] } | null = null;
  for (const entry of policyNodes(text, policyName)) {
    if (entry.action !== 'permit') continue;
    if (!entry.clauses.some((clause) => clause.toLowerCase() === wanted)) continue;
    if (best === null || entry.node < best.node) best = { node: entry.node, clauses: entry.clauses };
  }
  return best;
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
