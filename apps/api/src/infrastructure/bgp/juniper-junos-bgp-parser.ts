import type { BgpAddressFamily, BgpAdvertisedRouteDto, BgpRouteOrigin } from '@gmj/shared';
import { computeLocalPrepend } from '@gmj/shared';
import { isIP } from 'node:net';
import type { BgpPeerState } from './bgp4-peer-parser';
import type { BgpRouteLookupData } from './bgp-interface-correlation';

/**
 * Parser do Junos (MX/Junos 19.x) — SOMENTE LEITURA.
 *
 * Comandos cobertos (validados em equipamento real):
 *  - `show bgp summary | no-more`                        → peers IPv4 + IPv6 no MESMO output
 *  - `show configuration protocols bgp | display set`    → descrição e local-as por grupo/peer
 *  - `show route <PEER> | no-more`                       → interface de saída do peer
 *  - `show route advertising-protocol bgp <PEER>`        → rotas anunciadas (leitura)
 *
 * Regras que o formato impõe:
 *  - a coluna `AS` do summary é o REMOTE AS; nunca é usada como local AS;
 *  - na linha da família, os valores são Active/Received/Accepted/Damped —
 *    `receivedPrefixes` é o SEGUNDO número;
 *  - `jnxBgpM2`/CLI trazem IPv4 e IPv6 no mesmo texto, com a família vindo da
 *    linha `inet.0:` / `inet6.0:`.
 */

export interface JunosBgpPeerReading {
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  remoteAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  /** Segundo valor de Active/Received/Accepted/Damped. */
  receivedPrefixes: bigint | null;
  activePrefixes: number | null;
  description: string | null;
  provenance: Readonly<Record<string, 'SNMP' | 'SSH'>>;
}

export interface JunosBgpSummary {
  peers: JunosBgpPeerReading[];
  declaredPeers: number | null;
  declaredDownPeers: number | null;
  groups: number | null;
  warnings: string[];
}

const JUNOS_STATE_CODES: Readonly<Record<string, number>> = {
  Idle: 1,
  Connect: 2,
  Active: 3,
  OpenSent: 4,
  OpenConfirm: 5,
  Establ: 6,
  Established: 6,
};

function stateFromToken(token: string): { code: number | null; state: BgpPeerState | null } {
  const code = JUNOS_STATE_CODES[token] ?? null;
  if (code === null) return { code: null, state: null };
  const states: Record<number, BgpPeerState> = {
    1: 'IDLE',
    2: 'CONNECT',
    3: 'ACTIVE',
    4: 'OPENSENT',
    5: 'OPENCONFIRM',
    6: 'ESTABLISHED',
  };
  return { code, state: states[code] ?? null };
}

/** "4w4d 10:00:31" | "6d 17:48:07" | "4:20:47" | "1d 5:15:37" → segundos. */
export function parseJunosUptime(value: string): number | null {
  let rest = value.trim();
  if (!rest) return null;
  let weeks = 0;
  let days = 0;
  const weekMatch = /^(\d+)w/.exec(rest);
  if (weekMatch) {
    weeks = Number(weekMatch[1]);
    rest = rest.slice(weekMatch[0].length);
  }
  const dayMatch = /^(\d+)d/.exec(rest);
  if (dayMatch) {
    days = Number(dayMatch[1]);
    rest = rest.slice(dayMatch[0].length);
  }
  rest = rest.trim();
  if (!rest) return days * 86_400 + weeks * 604_800;
  const parts = rest.split(':').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) [hours, minutes, seconds] = parts as [number, number, number];
  else if (parts.length === 2) [minutes, seconds] = parts as [number, number];
  else return null;
  return weeks * 604_800 + days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

const PEER_LINE = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/;
const FAMILY_LINE = /^\s+(inet6?\.\d+)\s*:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/;

/**
 * `show bgp summary | no-more`.
 *
 * Cada peer é uma linha; a família vem da linha seguinte (`inet.0:` IPv4,
 * `inet6.0:` IPv6). Um peer sem linha de família fica sem `receivedPrefixes`
 * (null) — nunca zero inventado.
 */
export function parseJunosBgpSummary(output: string): JunosBgpSummary {
  const peers: JunosBgpPeerReading[] = [];
  const warnings: string[] = [];
  let declaredPeers: number | null = null;
  let declaredDownPeers: number | null = null;
  let groups: number | null = null;
  let pending: JunosBgpPeerReading | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const header = /^Groups:\s*(\d+)\s+Peers:\s*(\d+)\s+Down peers:\s*(\d+)/.exec(line);
    if (header) {
      groups = Number(header[1]);
      declaredPeers = Number(header[2]);
      declaredDownPeers = Number(header[3]);
      continue;
    }
    const family = FAMILY_LINE.exec(line);
    if (family && pending) {
      const table = family[1] ?? '';
      const addressFamily: BgpAddressFamily = table.startsWith('inet6') ? 'IPV6' : 'IPV4';
      // Active / Received / Accepted / Damped
      const active = Number(family[2]);
      const received = Number(family[3]);
      pending.addressFamily = addressFamily;
      pending.activePrefixes = Number.isFinite(active) ? active : null;
      pending.receivedPrefixes =
        pending.stateCode === 6 && Number.isFinite(received) ? BigInt(received) : null;
      peers.push(pending);
      pending = null;
      continue;
    }
    const peer = PEER_LINE.exec(line);
    if (!peer) continue;
    const peerAddress = peer[1]!;
    const remoteAs = BigInt(peer[2]!);
    const tail = peer[7]!.trim().split(/\s+/);
    const stateToken = tail[tail.length - 1] ?? '';
    const uptimeToken = tail.slice(0, -1).join(' ');
    const { code, state } = stateFromToken(stateToken);
    if (code === null) {
      warnings.push(`Peer ${peerAddress}: estado "${stateToken}" não reconhecido`);
    }
    // Um peer anterior sem linha de família não pode ser perdido silenciosamente.
    if (pending) {
      peers.push(pending);
      warnings.push(`Peer ${pending.peerAddress}: linha de família ausente no summary`);
    }
    pending = {
      peerAddress,
      addressFamily: peerAddress.includes(':') ? 'IPV6' : 'IPV4',
      remoteAs,
      stateCode: code,
      state,
      sessionUptimeSeconds: parseJunosUptime(uptimeToken),
      receivedPrefixes: null,
      activePrefixes: null,
      description: null,
      provenance: {
        peerAddress: 'SSH',
        remoteAs: 'SSH',
        state: 'SSH',
        sessionUptimeSeconds: 'SSH',
        receivedPrefixes: 'SSH',
      },
    };
  }
  if (pending) {
    peers.push(pending);
    warnings.push(`Peer ${pending.peerAddress}: linha de família ausente no summary`);
  }
  return { peers, declaredPeers, declaredDownPeers, groups, warnings };
}

export interface JunosBgpGroupConfig {
  name: string;
  description: string | null;
  localAs: bigint | null;
  peerAs: bigint | null;
}

export interface JunosBgpConfigReading {
  groups: Map<string, JunosBgpGroupConfig>;
  /** Configuração por vizinho (descrição, local-as explícito, peer-as). */
  neighbors: Map<string, { description: string | null; localAs: bigint | null; peerAs: bigint | null; group: string | null }>;
  /** `set routing-options autonomous-system N` — usado só como último fallback. */
  autonomousSystem: bigint | null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * `show configuration protocols bgp | display set` e
 * `show configuration routing-options | display set`.
 *
 * O `local-as` do grupo/peer é a única fonte confiável de AS local quando a
 * BGP4-V2-MIB não responde: o mesmo MX usa local-as diferentes por grupo.
 */
export function parseJunosBgpConfig(...outputs: string[]): JunosBgpConfigReading {
  const groups = new Map<string, JunosBgpGroupConfig>();
  const neighbors = new Map<
    string,
    { description: string | null; localAs: bigint | null; peerAs: bigint | null; group: string | null }
  >();
  let autonomousSystem: bigint | null = null;

  const ensureGroup = (name: string): JunosBgpGroupConfig => {
    const existing = groups.get(name);
    if (existing) return existing;
    const created: JunosBgpGroupConfig = {
      name,
      description: null,
      localAs: null,
      peerAs: null,
    };
    groups.set(name, created);
    return created;
  };
  const ensureNeighbor = (address: string) => {
    const existing = neighbors.get(address);
    if (existing) return existing;
    const created = {
      description: null as string | null,
      localAs: null as bigint | null,
      peerAs: null as bigint | null,
      group: null as string | null,
    };
    neighbors.set(address, created);
    return created;
  };

  for (const output of outputs) {
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('set ')) continue;
      const tokens = line.split(/\s+/);
      if (tokens[1] === 'routing-options' && tokens[2] === 'autonomous-system') {
        const value = tokens.slice(3).find((token) => /^\d+$/.test(token));
        if (value) autonomousSystem = BigInt(value);
        continue;
      }
      if (tokens[1] !== 'protocols' || tokens[2] !== 'bgp') continue;
      if (tokens[3] === 'group' && tokens[4]) {
        const group = ensureGroup(tokens[4]);
        const rest = tokens.slice(5);
        if (rest[0] === 'description') group.description = unquote(rest.slice(1).join(' '));
        else if (rest[0] === 'local-as' && rest[1] && /^\d+$/.test(rest[1])) group.localAs = BigInt(rest[1]);
        else if (rest[0] === 'peer-as' && rest[1] && /^\d+$/.test(rest[1])) group.peerAs = BigInt(rest[1]);
        else if (rest[0] === 'neighbor' && rest[1]) {
          const neighbor = ensureNeighbor(rest[1]);
          neighbor.group = group.name;
          const tail = rest.slice(2);
          if (tail[0] === 'description') neighbor.description = unquote(tail.slice(1).join(' '));
          else if (tail[0] === 'local-as' && tail[1] && /^\d+$/.test(tail[1])) neighbor.localAs = BigInt(tail[1]);
          else if (tail[0] === 'peer-as' && tail[1] && /^\d+$/.test(tail[1])) neighbor.peerAs = BigInt(tail[1]);
        }
      }
    }
  }
  return { groups, neighbors, autonomousSystem };
}

/**
 * `show route <PEER> | no-more`.
 *
 * O output traz uma seção por routing instance. A interface de saída vem da
 * linha `via <interface>`. Preferimos a tabela global (`inet.0`/`inet6.0`),
 * que é a usada pelo BGP, e só caímos para tabelas de VRF quando a global não
 * tem a rota — evitando escolher uma interface de VRF não relacionada.
 */
export function parseJunosRouteLookup(output: string, family: BgpAddressFamily): BgpRouteLookupData {
  const wantedTable = family === 'IPV6' ? 'inet6.0' : 'inet.0';
  const sections: Array<{ table: string | null; interfaces: string[] }> = [];
  let current: { table: string | null; interfaces: string[] } | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const tableLine = /^(\S+):\s+\d+ destinations/.exec(line);
    if (tableLine) {
      current = { table: tableLine[1] ?? null, interfaces: [] };
      sections.push(current);
      continue;
    }
    const via = /\bvia\s+(\S+)/.exec(line);
    if (via && current) current.interfaces.push(via[1]!);
  }

  const withRoutes = sections.filter((section) => section.interfaces.length > 0);
  if (!withRoutes.length) return { routeFound: false, unresolvedRoute: false, interfaceNames: [] };

  const global = withRoutes.find((section) => section.table === wantedTable);
  const chosen = global ?? withRoutes[0]!;
  const interfaces = [...new Set(chosen.interfaces)];
  // `unresolvedRoute` = a rota existe mas não aponta uma interface utilizável.
  return { routeFound: true, unresolvedRoute: interfaces.length === 0, interfaceNames: interfaces };
}

const AS_PATH_TOKEN = /^(?:\d+|[[{(].*[\]})])$/;

function parseAsPathTokens(tokens: string[]): string[] {
  const path: string[] = [];
  let buffer: string[] | null = null;
  for (const token of tokens) {
    if (buffer) {
      buffer.push(token);
      if (/[\]})]$/.test(token)) {
        path.push(buffer.join(' '));
        buffer = null;
      }
      continue;
    }
    if (/^[[{(]/.test(token)) {
      if (/[\]})]$/.test(token)) path.push(token);
      else buffer = [token];
      continue;
    }
    if (/^\d+$/.test(token)) {
      path.push(token);
      continue;
    }
  }
  return path;
}

export interface JunosAdvertisedRoutes {
  routes: BgpAdvertisedRouteDto[];
  reportedTotal: number | null;
  warnings: string[];
}

/**
 * `show route advertising-protocol bgp <PEER> | no-more` (SOMENTE LEITURA).
 *
 * Colunas: Prefix | Nexthop | MED | Lclpref | AS path. MED e Lclpref são
 * opcionais e só aparecem quando o equipamento os imprime; ausentes viram
 * `null`. `Self` é preservado como next hop. AS-SET `[..]`, confederação
 * `(..)` e conjunto `{..}` são mantidos como UM elemento do AS-PATH — o
 * conteúdo entre colchetes não é confundido com um ASN do caminho.
 */
export function parseJunosAdvertisedRoutes(
  output: string,
  options: { localAs: bigint | null },
): JunosAdvertisedRoutes {
  const routes: BgpAdvertisedRouteDto[] = [];
  const warnings: string[] = [];
  let reportedTotal: number | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^Prefix\s+Nexthop/.test(line.trim())) continue;
    const total = /(\d+)\s+destinations?,\s+(\d+)\s+routes?/.exec(line);
    if (total) {
      reportedTotal = Number(total[2]);
      continue;
    }
    if (!/^\S+\s+\S+/.test(line)) continue;
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 3) {
      if (/^\S+\/\d+/.test(line.trim())) warnings.push(`Linha não reconhecida: ${line.trim().slice(0, 120)}`);
      continue;
    }
    const prefix = columns[0]!.trim();
    if (!/^\S+\/\d+$/.test(prefix)) continue;
    const nextHop = columns[1]!.trim();
    const middle = columns.slice(2, -1).map((column) => column.trim()).filter(Boolean);
    const numericMiddle = middle.filter((value) => /^\d+$/.test(value));
    if (middle.length !== numericMiddle.length) warnings.push(`Colunas ignoradas em ${prefix}`);
    const med = numericMiddle.length >= 1 ? Number(numericMiddle[0]) : null;
    const localPreference = numericMiddle.length >= 2 ? Number(numericMiddle[1]) : null;

    const pathTokens = (columns[columns.length - 1] ?? '').trim().split(/\s+/).filter(Boolean);
    const originToken = (pathTokens[pathTokens.length - 1] ?? '').toLowerCase();
    // O Junos imprime a origem em maiúsculas (`I`/`E`); normalizamos para o
    // mesmo vocabulário usado pelo parser Huawei.
    const origin: BgpRouteOrigin | null =
      originToken === 'i' || originToken === 'e' || originToken === '?' ? originToken : null;
    const asPathTokens = origin ? pathTokens.slice(0, -1) : pathTokens;
    const unknown = asPathTokens.find((token) => !AS_PATH_TOKEN.test(token));
    if (unknown) warnings.push(`Token de AS-PATH não reconhecido em ${prefix}: ${unknown}`);
    const asPath = parseAsPathTokens(asPathTokens);
    routes.push({
      prefix,
      nextHop: nextHop || null,
      med: med === null || Number.isNaN(med) ? null : med,
      localPreference:
        localPreference === null || Number.isNaN(localPreference) ? null : localPreference,
      preferredValue: null,
      asPath,
      origin,
      prependLocal: computeLocalPrepend(asPath, options.localAs === null ? null : options.localAs.toString()),
    });
  }
  return { routes, reportedTotal, warnings };
}

export class JuniperBgpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JuniperBgpConfigError';
  }
}

/**
 * Allowlist fechada do Juniper: só leitura. O endereço do peer precisa ser IP
 * canônico (nunca texto livre) e o comando tem de ser reproduzido exatamente
 * por um dos construtores abaixo.
 */
const READ_ONLY_PREFIXES = [
  /^show bgp summary \| no-more$/,
  /^show configuration protocols bgp \| display set \| no-more$/,
  /^show configuration routing-options \| display set \| no-more$/,
  /^show route \S+ \| no-more$/,
  /^show route advertising-protocol bgp \S+ \| no-more$/,
  /^show bgp neighbor \S+ \| no-more$/,
];

export function assertJunosReadOnly(command: string): void {
  if (!READ_ONLY_PREFIXES.some((pattern) => pattern.test(command))) {
    throw new JuniperBgpConfigError(`Comando Junos fora da allowlist read-only: ${command}`);
  }
}

function assertPeerAddress(peerAddress: string): string {
  const trimmed = peerAddress.trim();
  if (isIP(trimmed) === 0) {
    throw new JuniperBgpConfigError('Endereço de peer inválido para consulta Junos');
  }
  return trimmed;
}

/** `show route <PEER> | no-more` — sem `exact` (o peer não é rota /32 ou /128). */
export function buildJunosRouteCommand(peerAddress: string): string {
  return `show route ${assertPeerAddress(peerAddress)} | no-more`;
}

/** `show route advertising-protocol bgp <PEER> | no-more` — somente leitura. */
export function buildJunosAdvertisedRoutesCommand(peerAddress: string): string {
  return `show route advertising-protocol bgp ${assertPeerAddress(peerAddress)} | no-more`;
}
