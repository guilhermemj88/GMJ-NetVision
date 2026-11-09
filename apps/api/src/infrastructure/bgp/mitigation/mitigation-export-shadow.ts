import {
  discoverMitigationPeer,
  parseExtcommunityFilters,
  type ExtcommunityFilterEntry,
} from './mitigation-physical-verification';
import {
  listsOverlap,
  MITIGATION_RT,
  parseIpPrefixEntries,
  type MitigationNode2Contract,
} from './mitigation-node2-contract';
import { policyNodes } from './mitigation-policy-clauses';

/**
 * ELEGIBILIDADE DO LADO DO EXPORT.
 *
 * O contrato do node 2 so prova o IMPORT. A mitigacao so tem efeito se a export policy do
 * peer de mitigacao (ex.: PL-COMPUTIZE-IPv4-OUT) deixar a rota com RT 660 do cliente chegar
 * ao `permit` MITIGACAO. Esta checagem avalia essa policy NA ORDEM DOS NODES: se algum node
 * ANTERIOR ao permit MITIGACAO generico (so a condicao extcommunity-filter MITIGACAO) PUDER
 * casar a rota do cliente e for `deny`, o perfil e inelegivel (`MITIGATION_EXPORT_SHADOWED`).
 * Se nao for possivel PROVAR que nao casa (lista nao definida, filtro desconhecido, peer
 * de mitigacao nao descoberto, nenhum permit generico), tambem e inelegivel.
 *
 * A rota exportada tem SOMENTE a RT 660 (REPLACE), entao nodes que dependem de outra RT
 * (ex.: `deny node 90 if-match extcommunity-filter 140`) nao a casam. Condicoes de outros
 * tipos (community, as-path...) sao tratadas como "pode casar" (conservador). Sobreposicao
 * de prefix-list usa a mesma prova conservadora (blocos-base) do deny anterior no import.
 */

export const MITIGATION_EXPORT_SHADOWED = 'MITIGATION_EXPORT_SHADOWED';

export interface ExportShadowResult {
  ok: boolean;
  code: typeof MITIGATION_EXPORT_SHADOWED | null;
  mitigationPeer: string | null;
  exportPolicy: string | null;
  reasons: string[];
}

/** `true` = o filtro casa a rota (RTs dela); `false` = nao casa; `null` = nao provavel. */
function filterMatchesRoute(
  entries: readonly ExtcommunityFilterEntry[] | undefined,
  rts: readonly string[],
): boolean | null {
  if (!entries) return null;
  let unknown = false;
  for (const entry of entries) {
    if (entry.rt === null) {
      unknown = true;
      continue;
    }
    if (rts.includes(entry.rt)) return unknown ? null : entry.action === 'permit';
  }
  return unknown ? null : false;
}

export function checkMitigationExport(input: {
  contract: MitigationNode2Contract;
  routePolicyConfiguration: string | null;
  prefixListConfiguration: string | null;
  bgpConfiguration: string | null;
  extcommunityFilterOutput: string | null;
  /**
   * RTs da rota exportada. Default: SOMENTE a 660 (REPLACE). Passar `[140, 660]` documenta por que
   * o REPLACE e obrigatorio: com `additive` a rota casaria o `deny node 90` (filtro 140) da COMPUTIZE.
   */
  routeRts?: readonly string[];
}): ExportShadowResult {
  const routeRts = input.routeRts ?? [MITIGATION_RT];
  const fail = (
    reasons: string[],
    peer: string | null = null,
    policy: string | null = null,
  ): ExportShadowResult => ({
    ok: false,
    code: MITIGATION_EXPORT_SHADOWED,
    mitigationPeer: peer,
    exportPolicy: policy,
    reasons,
  });
  const discovery = discoverMitigationPeer({
    bgpConfiguration: input.bgpConfiguration,
    routePolicyConfiguration: input.routePolicyConfiguration,
    extcommunityFilterOutput: input.extcommunityFilterOutput,
  });
  if (!discovery.peer || !discovery.exportPolicy) {
    return fail([`export do peer de mitigacao nao comprovavel: ${discovery.detail}`]);
  }
  const peer = discovery.peer;
  const policy = discovery.exportPolicy;
  const client = parseIpPrefixEntries(
    input.contract.prefixListEntries.join('\n'),
    input.contract.prefixList,
  );
  if (!client || client.length === 0) {
    return fail(
      ['lista do cliente sem entradas: sobreposicao no export nao comprovavel'],
      peer,
      policy,
    );
  }
  const filters = parseExtcommunityFilters(input.extcommunityFilterOutput);
  const nodes = policyNodes(input.routePolicyConfiguration ?? '', policy).sort(
    (a, b) => a.node - b.node,
  );
  if (nodes.length === 0) return fail([`export policy ${policy} sem nodes legiveis`], peer, policy);

  const reasons: string[] = [];
  let reached = false;
  for (const node of nodes) {
    const conditions = node.clauses.filter((clause) => /^if-match\b/i.test(clause));
    // Node permit generico de mitigacao: so a condicao extcommunity-filter MITIGACAO.
    if (node.action === 'permit' && conditions.length === 1) {
      const only = /^if-match extcommunity-filter (\S+)$/i.exec(conditions[0]!);
      if (only && filterMatchesRoute(filters.get(only[1]!), [MITIGATION_RT]) === true) {
        reached = true;
        break;
      }
    }
    if (node.action !== 'deny') continue; // permit anterior: a rota ja sai exportada
    const why: string[] = [];
    let possible = true;
    for (const condition of conditions) {
      const prefix = /^if-match ip-prefix (\S+)$/i.exec(condition);
      const filter = /^if-match extcommunity-filter (\S+)$/i.exec(condition);
      if (prefix) {
        const entries = input.prefixListConfiguration
          ? parseIpPrefixEntries(input.prefixListConfiguration, prefix[1]!)
          : null;
        if (!entries || entries.length === 0) {
          why.push(`lista ${prefix[1]} nao definida/ilegivel: sobreposicao nao descartavel`);
        } else if (listsOverlap(client, entries)) {
          why.push(`lista ${prefix[1]} sobrepoe ${input.contract.prefixList}`);
        } else {
          possible = false;
          break;
        }
      } else if (filter) {
        const matches = filterMatchesRoute(filters.get(filter[1]!), routeRts);
        if (matches === false) {
          possible = false;
          break;
        }
        why.push(
          matches === null
            ? `extcommunity-filter ${filter[1]} desconhecido`
            : `extcommunity-filter ${filter[1]} casa as RTs da rota (${routeRts.join(', ')})`,
        );
      } else {
        why.push(`condicao nao avaliavel (${condition})`);
      }
    }
    if (possible) {
      reasons.push(
        `${policy} node ${node.node} (deny) antecede o permit MITIGACAO e pode casar a rota do cliente` +
          (why.length > 0 ? ` [${why.join('; ')}]` : ' [sem condicao]'),
      );
    }
  }
  if (!reached && reasons.length === 0) {
    reasons.push(
      `${policy} nao tem permit MITIGACAO generico (so a condicao do filtro da RT ${MITIGATION_RT})`,
    );
  }
  return reasons.length === 0
    ? { ok: true, code: null, mitigationPeer: peer, exportPolicy: policy, reasons: [] }
    : fail(reasons, peer, policy);
}
