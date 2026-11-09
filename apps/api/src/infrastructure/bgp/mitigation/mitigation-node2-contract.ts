import { appliedRouteTargets, parseConfiguredIpPrefixNames } from './huawei-bgp-policy-parser';
import { policyNodes } from './mitigation-policy-clauses';

/**
 * CONTRATO DO NODE 2 DE MITIGACAO (derivado do baseline e validado por policy).
 *
 * Defeito corrigido: o node 2 anterior era `permit` SEM `if-match` e SEM
 * `local-preference`. No equipamento real isso derrubava a LP do cliente para o
 * padrao (100), o caminho de backup (LP 800) virava o melhor, a rota com RT 660
 * nao era anunciada e os nodes permanentes deixavam de ser avaliados
 * ("aceita tudo menos BOGONS").
 *
 * O node 2 passa a ser um clone ESTREITO do node permanente do cliente:
 *
 *   route-policy <P> permit node 2
 *    if-match ip-prefix <LISTA do node permanente>
 *    apply local-preference <N do node permanente>
 *    apply extcommunity rt 268568:660
 *
 * DECISAO DE RT: `rtMode: 'REPLACE'` (sem `additive`). A pratica operacional
 * comprovada (MITIGACAO-73S/CLICKING/GNA-V4-IN) substitui a RT 140 pela 660.
 * Efeito: durante a mitigacao a RT 140 SAI da rota; os exports que casam com a
 * 140 (CIRION node 90, SWITCH node 100 etc.) deixam de anunciar; a COMPUTIZE
 * anuncia pelo filtro MITIGACAO (RT 660, nodes 200/300); SEABORN e SEMPRE negam
 * por `deny node 5` (extcommunity-filter MITIGACAO).
 *
 * Fail-closed: qualquer forma que nao se prove segura e RECUSADA com
 * `MITIGATION_CONTRACT_UNSUPPORTED` e motivos explicitos. Nada aqui presume que
 * toda policy e igual a AGLINK.
 */

export const MITIGATION_CONTRACT_UNSUPPORTED = 'MITIGATION_CONTRACT_UNSUPPORTED';
export const MITIGATION_RT = '268568:660';
/** Unica RT permitida no node permanente (a que a mitigacao substitui). */
export const PERMANENT_CLIENT_RT = '268568:140';

/**
 * ALLOWLIST EXPLICITA das clausulas aceitas no node permanente do cliente.
 * Qualquer outra clausula (community, as-path, med, goto, outro if-match...) e
 * recusada: o node 2 nao as reproduziria e nao ha como provar equivalencia.
 */
export const MITIGATION_CONTRACT_CLAUSE_ALLOWLIST: readonly string[] = Object.freeze([
  'if-match ip-prefix <LISTA IPv4> (exatamente uma)',
  'apply local-preference <N> (exatamente uma, valor absoluto)',
  `apply extcommunity rt ${PERMANENT_CLIENT_RT} [additive] (exatamente uma, somente a RT ${PERMANENT_CLIENT_RT})`,
]);

export interface MitigationNode2Contract {
  version: 1;
  policyName: string;
  /** Node permanente de onde o contrato foi derivado (evidencia, nunca alterado). */
  baselineNode: number;
  prefixList: string;
  localPreference: number;
  rt: typeof MITIGATION_RT;
  /** Decisao explicita: a RT de mitigacao SUBSTITUI a RT do cliente. */
  rtMode: 'REPLACE';
  baselineRt: typeof PERMANENT_CLIENT_RT;
  /** O node permanente aplica a RT 140 com `additive`? (evidencia). */
  baselineRtAdditive: boolean;
  /**
   * Entradas `ip ip-prefix` normalizadas da lista, quando a configuracao de
   * prefix-lists estava disponivel. Alimentam a verificacao fisica e travam a
   * lista entre o preflight e a escrita.
   */
  prefixListEntries: string[];
}

export type MitigationContractDerivation =
  | { eligible: true; contract: MitigationNode2Contract; notes: string[] }
  | {
      eligible: false;
      code: typeof MITIGATION_CONTRACT_UNSUPPORTED;
      reasons: string[];
    };

/** Clausulas EXATAS do node 2 para o contrato. */
export function mitigationNode2Clauses(contract: MitigationNode2Contract): string[] {
  return [
    `if-match ip-prefix ${contract.prefixList}`,
    `apply local-preference ${contract.localPreference}`,
    `apply extcommunity rt ${contract.rt}`,
  ];
}

/** Valida a FORMA do contrato (defesa em profundidade antes de gerar comandos). */
export function isMitigationNode2Contract(value: unknown): value is MitigationNode2Contract {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<MitigationNode2Contract>;
  return (
    c.version === 1 &&
    typeof c.policyName === 'string' &&
    c.policyName.length > 0 &&
    Number.isInteger(c.baselineNode) &&
    typeof c.prefixList === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(c.prefixList) &&
    Number.isInteger(c.localPreference) &&
    (c.localPreference as number) >= 0 &&
    (c.localPreference as number) <= 4294967295 &&
    c.rt === MITIGATION_RT &&
    c.rtMode === 'REPLACE' &&
    c.baselineRt === PERMANENT_CLIENT_RT &&
    typeof c.baselineRtAdditive === 'boolean' &&
    Array.isArray(c.prefixListEntries)
  );
}

/** Igualdade estrita entre dois contratos (preflight x segunda leitura fisica). */
export function sameMitigationNode2Contract(
  left: MitigationNode2Contract,
  right: MitigationNode2Contract,
): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(contract: MitigationNode2Contract) {
  return { ...contract, prefixListEntries: [...contract.prefixListEntries].sort() };
}

// ---------------------------------------------------------------------------
// ip ip-prefix
// ---------------------------------------------------------------------------

export interface IpPrefixEntry {
  name: string;
  index: number;
  action: 'permit' | 'deny';
  network: number;
  length: number;
  greaterEqual: number | null;
  lessEqual: number | null;
  text: string;
}

const IP_PREFIX_LINE =
  /^ip ip-prefix (\S+) index (\d+) (permit|deny) (\d{1,3}(?:\.\d{1,3}){3}) (\d{1,2})(?: greater-equal (\d{1,2}))?(?: less-equal (\d{1,2}))?$/i;

export function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!/^\d{1,3}$/.test(part) || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Entradas de UMA lista; `null` quando alguma linha da lista e ilegivel. */
export function parseIpPrefixEntries(
  configuration: string | null,
  name: string,
): IpPrefixEntry[] | null {
  if (configuration === null) return null;
  const entries: IpPrefixEntry[] = [];
  for (const raw of configuration.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (!/^ip ip-prefix\b/i.test(line)) continue;
    if (line.split(' ')[2] !== name) continue;
    const match = IP_PREFIX_LINE.exec(line);
    const network = match ? ipv4ToInt(match[4]!) : null;
    if (!match || network === null) return null;
    const length = Number(match[5]);
    const ge = match[6] === undefined ? null : Number(match[6]);
    const le = match[7] === undefined ? null : Number(match[7]);
    if (length > 32 || (ge !== null && ge > 32) || (le !== null && le > 32)) return null;
    entries.push({
      name,
      index: Number(match[2]),
      action: match[3]!.toLowerCase() as 'permit' | 'deny',
      network,
      length,
      greaterEqual: ge,
      lessEqual: le,
      text: line,
    });
  }
  return entries.sort((a, b) => a.index - b.index);
}

function blockOf(network: number, length: number): { start: number; end: number } {
  const size = 2 ** (32 - length);
  const start = Math.floor(network / size) * size;
  return { start, end: start + size - 1 };
}

/**
 * A lista (primeira entrada que casa, como no VRP) aceita o prefixo?
 * Semantica Huawei: sem ge/le = comprimento exato; so `ge` => le=32; so `le` =>
 * ge=comprimento base.
 */
export function ipPrefixListPermits(
  entries: readonly IpPrefixEntry[],
  prefix: { network: number; length: number },
): boolean {
  for (const entry of entries) {
    const block = blockOf(entry.network, entry.length);
    const inside =
      prefix.network >= block.start && prefix.network <= block.end && prefix.length >= entry.length;
    if (!inside) continue;
    const min = entry.greaterEqual ?? entry.length;
    const max = entry.lessEqual ?? (entry.greaterEqual !== null ? 32 : entry.length);
    if (prefix.length >= min && prefix.length <= max) return entry.action === 'permit';
  }
  return false;
}

/** Conservador: as listas se sobrepoem se QUALQUER bloco base se tocar. */
function listsOverlap(left: readonly IpPrefixEntry[], right: readonly IpPrefixEntry[]): boolean {
  return left.some((a) => {
    const blockA = blockOf(a.network, a.length);
    return right.some((b) => {
      const blockB = blockOf(b.network, b.length);
      return blockA.start <= blockB.end && blockB.start <= blockA.end;
    });
  });
}

// ---------------------------------------------------------------------------
// Derivacao
// ---------------------------------------------------------------------------

const PREFIX_CLAUSE = /^if-match ip-prefix (\S+)$/i;
const LOCAL_PREFERENCE_CLAUSE = /^apply local-preference (\d+)$/i;
const CLIENT_RT_CLAUSE = new RegExp(
  `^apply extcommunity rt ${PERMANENT_CLIENT_RT}( additive)?$`,
  'i',
);

export interface DeriveContractOptions {
  /**
   * Saida de `display current-configuration | include ip-prefix`. Quando
   * ausente (read-back por `display route-policy`) a derivacao e ESTRUTURAL:
   * nao prova a existencia da lista nem a ausencia de sobreposicao.
   */
  prefixListConfiguration?: string | null;
  /** Exige a prova por prefix-list (preflight). Sem a configuracao => recusa. */
  requirePrefixListProof?: boolean;
  /** Prefix-list do node 1 (deny); sempre precede o node 2. */
  bogonPrefixList?: string;
}

/**
 * Deriva e VALIDA o contrato a partir das clausulas dos nodes PERMANENTES
 * (tudo menos os nodes 1 e 2 reservados).
 */
export function deriveMitigationNode2Contract(
  text: string,
  policyName: string,
  options: DeriveContractOptions = {},
): MitigationContractDerivation {
  const reasons: string[] = [];
  const bogonList = options.bogonPrefixList ?? 'BOGONS';
  const nodes = policyNodes(text, policyName).filter(
    (entry) => entry.node !== 1 && entry.node !== 2,
  );
  if (nodes.length === 0) {
    return refuse([`policy ${policyName} sem nodes permanentes legiveis`]);
  }

  const permits = nodes.filter((entry) => entry.action === 'permit');
  if (permits.length === 0) {
    reasons.push('nenhum node permit de cliente na policy');
  } else if (permits.length > 1) {
    reasons.push(
      `mais de um node permit permanente [${permits.map((entry) => entry.node).join(', ')}]: ` +
        'nao ha node unico de cliente para clonar',
    );
  }
  const customer = permits.length === 1 ? permits[0]! : null;

  let prefixList: string | null = null;
  let localPreference: number | null = null;
  let baselineRtAdditive = false;
  if (customer) {
    const prefixClauses = customer.clauses.filter((c) => /^if-match\b/i.test(c));
    const lpClauses = customer.clauses.filter((c) => /^apply local-preference\b/i.test(c));
    const rtClauses = customer.clauses.filter((c) => /^apply extcommunity\b/i.test(c));
    if (prefixClauses.length === 0) {
      reasons.push(`node permit ${customer.node} sem if-match ip-prefix (permit amplo)`);
    }
    for (const clause of prefixClauses) {
      if (!PREFIX_CLAUSE.test(clause)) {
        reasons.push(`node ${customer.node}: if-match fora da allowlist: ${clause}`);
      }
    }
    if (prefixClauses.length > 1) {
      reasons.push(`node ${customer.node}: mais de um if-match [${prefixClauses.join(' | ')}]`);
    }
    if (prefixClauses.length === 1 && PREFIX_CLAUSE.test(prefixClauses[0]!)) {
      prefixList = PREFIX_CLAUSE.exec(prefixClauses[0]!)![1]!;
    }
    if (lpClauses.length !== 1) {
      reasons.push(
        `node ${customer.node}: exige exatamente um apply local-preference (encontrado ${lpClauses.length})`,
      );
    } else {
      const lp = LOCAL_PREFERENCE_CLAUSE.exec(lpClauses[0]!);
      if (lp) localPreference = Number(lp[1]);
      else reasons.push(`node ${customer.node}: local-preference nao absoluto: ${lpClauses[0]}`);
    }
    if (rtClauses.length !== 1) {
      reasons.push(
        `node ${customer.node}: exige exatamente um apply extcommunity rt ${PERMANENT_CLIENT_RT} ` +
          `(encontrado ${rtClauses.length}); nao e possivel provar que so existe a RT ${PERMANENT_CLIENT_RT}`,
      );
    } else {
      const rts = appliedRouteTargets(rtClauses[0]!);
      if (rts.includes(MITIGATION_RT)) {
        reasons.push(
          `node ${customer.node}: o node permanente ja aplica a RT de mitigacao ${MITIGATION_RT}`,
        );
      } else if (!CLIENT_RT_CLAUSE.test(rtClauses[0]!)) {
        reasons.push(
          `node ${customer.node}: RT/community fora da allowlist (somente ${PERMANENT_CLIENT_RT}): ${rtClauses[0]}`,
        );
      } else {
        baselineRtAdditive = /additive$/i.test(rtClauses[0]!);
      }
    }
    for (const clause of customer.clauses) {
      if (/^(if-match|apply local-preference|apply extcommunity)\b/i.test(clause)) continue;
      reasons.push(`node ${customer.node}: clausula fora da allowlist: ${clause}`);
    }
  }

  // Demais nodes: somente deny (vazio ou com if-match). Permit extra ja foi tratado.
  const lists = options.prefixListConfiguration ?? null;
  const targetEntries =
    prefixList !== null && lists !== null ? parseIpPrefixEntries(lists, prefixList) : null;
  for (const node of nodes) {
    if (node === customer || node.action === 'permit') continue;
    const odd = node.clauses.filter((c) => !/^if-match\b/i.test(c));
    if (odd.length > 0) {
      reasons.push(`node deny ${node.node}: clausula fora da allowlist: ${odd.join(' | ')}`);
      continue;
    }
    // O node 2 PRECEDE todos os permanentes: um deny anterior ao node do cliente
    // que alcance a lista passaria a ser contornado. Exige prova de nao-sobreposicao.
    if (!customer || node.node > customer.node) continue;
    if (node.clauses.length === 0) {
      reasons.push(
        `node deny ${node.node} sem if-match antecede o node ${customer.node} (negaria tudo)`,
      );
      continue;
    }
    for (const clause of node.clauses) {
      const match = PREFIX_CLAUSE.exec(clause);
      if (!match) {
        reasons.push(
          `node deny ${node.node} (anterior ao ${customer.node}) usa if-match nao ip-prefix: ${clause}`,
        );
        continue;
      }
      const name = match[1]!;
      if (name === bogonList) continue; // o node 1 (deny BOGONS) ja precede o node 2
      // Derivacao ESTRUTURAL (read-back, sem ip-prefix): o preflight ja provou isto.
      if (lists === null && !options.requirePrefixListProof) continue;
      const other = lists !== null ? parseIpPrefixEntries(lists, name) : null;
      if (
        prefixList === null ||
        !targetEntries ||
        targetEntries.length === 0 ||
        !other ||
        other.length === 0
      ) {
        reasons.push(
          `node deny ${node.node} (lista ${name}) antecede o ${customer.node}: ` +
            'ausencia de conflito com a lista do cliente NAO pode ser comprovada',
        );
      } else if (listsOverlap(targetEntries, other)) {
        reasons.push(
          `node deny ${node.node} (lista ${name}) antecede o ${customer.node} e alcanca prefixos de ${prefixList}`,
        );
      }
    }
  }

  // Prova por prefix-list (preflight).
  let entries: string[] = [];
  if (prefixList !== null) {
    if (lists !== null) {
      const names = parseConfiguredIpPrefixNames(lists);
      if (!names.includes(prefixList)) {
        reasons.push(`prefix-list ${prefixList} inexistente no equipamento`);
      } else if (!targetEntries || targetEntries.length === 0) {
        reasons.push(`prefix-list ${prefixList} ilegivel/vazia`);
      } else {
        entries = targetEntries.map((entry) => entry.text);
      }
    } else if (options.requirePrefixListProof) {
      reasons.push(
        'configuracao de ip-prefix indisponivel: existencia da prefix-list nao comprovada',
      );
    }
  }

  if (reasons.length > 0 || customer === null || prefixList === null || localPreference === null) {
    return refuse(reasons.length > 0 ? reasons : ['contrato nao derivavel']);
  }
  const contract: MitigationNode2Contract = {
    version: 1,
    policyName,
    baselineNode: customer.node,
    prefixList,
    localPreference,
    rt: MITIGATION_RT,
    rtMode: 'REPLACE',
    baselineRt: PERMANENT_CLIENT_RT,
    baselineRtAdditive,
    prefixListEntries: entries,
  };
  return {
    eligible: true,
    contract,
    notes: [
      `node ${customer.node} -> node 2: if-match ${prefixList}, local-preference ${localPreference}, ` +
        `RT ${PERMANENT_CLIENT_RT} substituida por ${MITIGATION_RT} (rtMode REPLACE)`,
    ],
  };
}

function refuse(reasons: string[]): MitigationContractDerivation {
  return { eligible: false, code: MITIGATION_CONTRACT_UNSUPPORTED, reasons };
}

/** Texto unico dos motivos de recusa (mensagem de erro auditavel). */
export function contractRefusalMessage(derivation: MitigationContractDerivation): string {
  return derivation.eligible ? '' : `${derivation.code}: ${derivation.reasons.join('; ')}`;
}
