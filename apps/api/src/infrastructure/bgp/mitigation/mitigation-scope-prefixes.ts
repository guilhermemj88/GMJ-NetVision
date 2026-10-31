/**
 * ESCOPO VERIFICADO — prefixos REAIS do cliente em uma mitigacao.
 *
 * O alerta de mitigacao precisa dizer QUAIS prefixos estao sob mitigacao. Esse
 * dado NUNCA e inferido do nome do perfil, do `profileId` ou da prefix-list
 * configurada: ele vem de uma leitura READ-ONLY das rotas que o peer cliente
 * anuncia (`display bgp routing-table peer <peer> received`), vinculada ao
 * escopo do comando.
 *
 * Contrato fail-closed:
 *  - qualquer duvida (sem leitura, escopo divergente, saida ambigua, contagem
 *    divergente, next-hop de outro peer) => `prefixes: null` + `'prefixes'` em
 *    `fieldsUnavailable`. O transporte exibe "indisponivel" e nada e inventado;
 *  - a lista so existe com a leitura COMPLETA e coerente;
 *  - este modulo e PURO: nao faz I/O, nao altera `verified`, nao altera o
 *    resultado fisico do comando e nao e requisito de sucesso da mitigacao.
 */
import { parseHuaweiAdvertisedRoutes } from '../huawei-bgp-advertised-routes-parser';

/** Evidencia crua, do escopo do comando, coletada por leitura READ-ONLY. */
export interface MitigationScopePrefixEvidence {
  /** Perfil dono do escopo; precisa ser o MESMO da notificacao. */
  profileId: string;
  /** Policy IN do escopo. */
  policy: string;
  /** Peer cliente principal do escopo. */
  peer: string;
  /** Saida CRUA de `display bgp routing-table peer <peer> received`. */
  receivedRoutes: string;
}

/** O que o leitor de escopo recebe: somente identificadores ja validados. */
export interface MitigationScopePrefixQuery {
  profileId: string;
  deviceId: string;
  policyName: string;
  peerAddress: string | null;
  addressFamily: 'IPV4' | 'IPV6' | null;
}

/**
 * Porta do leitor de escopo. Implementada na fiacao com a MESMA sessao SSH de
 * leitura do discovery. Ausente = nenhum prefixo e `fieldsUnavailable`.
 * Lancar/rejeitar tambem significa "sem evidencia": nunca derruba o comando.
 */
export type MitigationScopePrefixReader = (
  query: MitigationScopePrefixQuery,
) => Promise<MitigationScopePrefixEvidence | null>;

export interface MitigationScopePrefixSelection {
  prefixes: string[] | null;
  /** Nomes de campo sem leitura ('prefixes'), para o transporte exibir. */
  fieldsUnavailable: string[];
}

const UNAVAILABLE_FIELDS: readonly string[] = ['prefixes'];

/** Sem evidencia completa: lista nula e o campo marcado como indisponivel. */
function unavailable(): MitigationScopePrefixSelection {
  return { prefixes: null, fieldsUnavailable: [...UNAVAILABLE_FIELDS] };
}

/**
 * Seleciona os prefixos do escopo a partir da evidencia lida.
 *
 * `expected` vem da notificacao (fonte confiavel do comando): a evidencia so e
 * aceita quando perfil, policy e peer coincidem e a familia e IPv4. Assim uma
 * leitura de outro perfil/peer nunca contamina a mensagem.
 */
export function selectMitigationScopePrefixes(input: {
  evidence: MitigationScopePrefixEvidence | null;
  expected: {
    profileId: string | null;
    policy: string | null;
    peer: string | null;
    addressFamily: 'IPV4' | 'IPV6' | null;
  };
  /** ASN local, apenas para o `prependLocal` do parser; nunca autoriza nada. */
  localAs?: string | number | bigint | null;
}): MitigationScopePrefixSelection {
  const { evidence, expected } = input;
  if (evidence === null) return unavailable();
  if (expected.addressFamily !== 'IPV4') return unavailable();
  if (expected.profileId === null || expected.policy === null || expected.peer === null) {
    return unavailable();
  }
  if (evidence.profileId !== expected.profileId) return unavailable();
  if (evidence.policy !== expected.policy) return unavailable();
  if (evidence.peer !== expected.peer) return unavailable();

  const parsed = parseHuaweiAdvertisedRoutes(evidence.receivedRoutes, {
    localAs: input.localAs ?? null,
    addressFamily: 'IPV4',
  });
  // Leitura ambigua/parcial NUNCA vira lista parcial.
  if (parsed.warnings.length > 0) return unavailable();
  if (parsed.reportedTotal === null || parsed.reportedTotal <= 0) return unavailable();
  if (parsed.routes.length !== parsed.reportedTotal) return unavailable();
  if (parsed.routes.length === 0) return unavailable();
  // Todas as rotas precisam vir do peer do escopo (nunca de outro cliente).
  if (!parsed.routes.every((route) => route.nextHop === expected.peer)) {
    return unavailable();
  }

  const prefixes = [...new Set(parsed.routes.map((route) => route.prefix))].sort();
  if (prefixes.length === 0) return unavailable();
  return { prefixes, fieldsUnavailable: [] };
}
