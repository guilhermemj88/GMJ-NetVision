import type { BgpAddressFamily } from '@gmj/shared';
import { ipAddressFamily, normalizeIpAddress, normalizeIpv6 } from '@gmj/shared';
import type { BgpPeerState } from './bgp4-peer-parser';

export interface ParsedHuaweiBgpPeer {
  /** Canonical address (IPv6 compressed/lower-case, IPv4 dotted quad). */
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  remoteAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  cliReceivedPrefixes: bigint | null;
  bgpPeerDescription: string | null;
  /**
   * Raw state token as printed by the device (e.g. `Idle(Admin)`). Only used to
   * confirm that a peer is administratively ignored during read-back.
   */
  cliStateToken: string | null;
}

export interface ParsedHuaweiRouteLookup {
  routeFound: boolean;
  interfaceNames: string[];
  unresolvedRoute: boolean;
}

export interface ParsedHuaweiBgpLocalAs {
  localAs: bigint | null;
  /** True when the context exposes more than one BGP process. */
  ambiguous: boolean;
}

const IPV4_PATTERN = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}';
const IPV4_GLOBAL = new RegExp(`\\b${IPV4_PATTERN}\\b`, 'g');
const DESTINATION_PATTERN = new RegExp(`\\b${IPV4_PATTERN}\\/(?:[0-9]|[12]\\d|3[0-2])\\b`);
/** Permissive token scan; validation/canonicalisation always uses the shared IP helpers. */
const IPV6_TOKEN = /[0-9a-fA-F:]{2,}/g;
const UINT32_MAX = 0xffff_ffffn;

const CLI_STATES: Readonly<Record<string, { stateCode: number; state: BgpPeerState }>> = {
  IDLE: { stateCode: 1, state: 'IDLE' },
  CONNECT: { stateCode: 2, state: 'CONNECT' },
  ACTIVE: { stateCode: 3, state: 'ACTIVE' },
  OPENSENT: { stateCode: 4, state: 'OPENSENT' },
  OPENCONFIRM: { stateCode: 5, state: 'OPENCONFIRM' },
  ESTABLISHED: { stateCode: 6, state: 'ESTABLISHED' },
};

function normalizedState(
  value: string | undefined,
): { stateCode: number; state: BgpPeerState } | null {
  if (!value) return null;
  const key = value.replace(/[^a-z]/gi, '').toUpperCase();
  if (key.startsWith('IDLE')) return CLI_STATES.IDLE!;
  return CLI_STATES[key] ?? null;
}

function unsignedBigInt(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= UINT32_MAX ? parsed : null;
}

export function parseHuaweiAsNumber(value: string | undefined): bigint | null {
  if (!value) return null;
  const normalized = value.replace(/^AS/i, '');
  const asPlain = unsignedBigInt(normalized);
  if (asPlain !== null) return asPlain;
  const asDot = normalized.match(/^(\d+)\.(\d+)$/);
  if (!asDot?.[1] || !asDot[2]) return null;
  const high = BigInt(asDot[1]);
  const low = BigInt(asDot[2]);
  if (high > 0xffffn || low > 0xffffn) return null;
  return high * 65536n + low;
}

export function parseHuaweiBgpUptime(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const clock = normalized.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (clock?.[1] && clock[2] && clock[3]) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    if (minutes >= 60 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  const unitSeconds: Readonly<Record<string, number>> = {
    w: 7 * 24 * 3600,
    d: 24 * 3600,
    h: 3600,
    m: 60,
    s: 1,
  };
  const matches = [...normalized.matchAll(/(\d+)([wdhms])/g)];
  if (!matches.length || matches.map((match) => match[0]).join('') !== normalized) return null;
  const seen = new Set<string>();
  let total = 0;
  for (const match of matches) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isSafeInteger(amount) || !unit || seen.has(unit)) return null;
    seen.add(unit);
    total += amount * unitSeconds[unit]!;
  }
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * `display bgp peer` / `display bgp ipv6 peer` share the same fixed columns:
 * Peer | V | AS | MsgRcvd | MsgSent | OutQ | Up/Down | State | PrefRcv.
 */
function summaryPeerFromLine(
  line: string,
  addressFamily: BgpAddressFamily,
): ParsedHuaweiBgpPeer | null {
  const tokens = line.trim().split(/\s+/);
  const peerAddress = normalizeIpAddress(tokens[0]);
  if (peerAddress === null || ipAddressFamily(peerAddress) !== addressFamily) return null;
  if (tokens[1] !== '4') return null;
  const remoteAs = parseHuaweiAsNumber(tokens[2]);
  const stateIndex = tokens.findIndex((token, index) => index >= 3 && normalizedState(token));
  const parsedState = stateIndex >= 0 ? normalizedState(tokens[stateIndex]) : null;
  const uptime = stateIndex > 0 ? parseHuaweiBgpUptime(tokens[stateIndex - 1]) : null;
  const cliReceivedPrefixes = stateIndex >= 0 ? unsignedBigInt(tokens[stateIndex + 1]) : null;
  return {
    peerAddress,
    addressFamily,
    remoteAs,
    stateCode: parsedState?.stateCode ?? null,
    state: parsedState?.state ?? null,
    sessionUptimeSeconds: parsedState?.state === 'ESTABLISHED' ? uptime : null,
    cliReceivedPrefixes,
    bgpPeerDescription: null,
    cliStateToken: stateIndex >= 0 ? (tokens[stateIndex] ?? null) : null,
  };
}

export function parseHuaweiBgpPeerSummary(
  output: string,
  addressFamily: BgpAddressFamily = 'IPV4',
): ParsedHuaweiBgpPeer[] {
  const peers = new Map<string, ParsedHuaweiBgpPeer>();
  for (const line of output.split(/\r?\n/)) {
    const peer = summaryPeerFromLine(line, addressFamily);
    if (peer) peers.set(peer.peerAddress, peer);
  }
  return [...peers.values()];
}

/** True when the device reports the peer as administratively ignored. */
export function isAdminIgnoredCliState(cliStateToken: string | null): boolean {
  return Boolean(cliStateToken && /idle\s*\(\s*admin\s*\)/i.test(cliStateToken));
}

function cleanPeerDescription(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '-') return null;
  return trimmed;
}

export function parseHuaweiBgpPeerVerbose(
  output: string,
  addressFamily: BgpAddressFamily = 'IPV4',
): ParsedHuaweiBgpPeer[] {
  const starts = [...output.matchAll(/BGP\s+Peer\s+is\s+([^\s,]+)/gi)];
  return starts.flatMap((start, index) => {
    const peerAddress = normalizeIpAddress(start[1]);
    if (peerAddress === null || start.index === undefined) return [];
    if (ipAddressFamily(peerAddress) !== addressFamily) return [];
    const end = starts[index + 1]?.index ?? output.length;
    const block = output.slice(start.index, end);
    const remoteAs = parseHuaweiAsNumber(
      block.match(/remote\s+AS(?:\s+number)?\s*[:=]?\s*((?:AS)?\d+(?:\.\d+)?)/i)?.[1],
    );
    const stateMatch = block.match(/BGP\s+current\s+state\s*:\s*([A-Za-z()_-]+)/i);
    const parsedState = normalizedState(stateMatch?.[1]);
    const uptime = parseHuaweiBgpUptime(block.match(/\bUp\s+for\s+([0-9:wdhms]+)/i)?.[1]);
    const prefixValue = block.match(
      /(?:Prefixes\s+current|Received\s+prefixes|PrefRcv)\s*[:=]\s*(\d+)/i,
    )?.[1];
    const description = cleanPeerDescription(
      block.match(/Peer\s+Description\s*[:=]\s*(.+?)\s*$/im)?.[1]
        ?? block.match(/Description\s*[:=]\s*(.+?)\s*$/im)?.[1],
    );
    return [
      {
        peerAddress,
        addressFamily,
        remoteAs,
        stateCode: parsedState?.stateCode ?? null,
        state: parsedState?.state ?? null,
        sessionUptimeSeconds: parsedState?.state === 'ESTABLISHED' ? uptime : null,
        cliReceivedPrefixes: unsignedBigInt(prefixValue),
        bgpPeerDescription: description,
        cliStateToken: stateMatch?.[1] ?? null,
      },
    ];
  });
}

export function mergeHuaweiBgpPeerDetails(
  summary: ParsedHuaweiBgpPeer[],
  verbose: ParsedHuaweiBgpPeer[],
): ParsedHuaweiBgpPeer[] {
  const verboseByAddress = new Map(verbose.map((peer) => [peer.peerAddress, peer]));
  return summary.map((peer) => {
    const detail = verboseByAddress.get(peer.peerAddress);
    if (!detail) return peer;
    return {
      peerAddress: peer.peerAddress,
      addressFamily: peer.addressFamily,
      remoteAs: peer.remoteAs ?? detail.remoteAs,
      stateCode: peer.stateCode ?? detail.stateCode,
      state: peer.state ?? detail.state,
      sessionUptimeSeconds: peer.sessionUptimeSeconds ?? detail.sessionUptimeSeconds,
      cliReceivedPrefixes: peer.cliReceivedPrefixes ?? detail.cliReceivedPrefixes,
      bgpPeerDescription: detail.bgpPeerDescription ?? peer.bgpPeerDescription,
      cliStateToken: peer.cliStateToken ?? detail.cliStateToken,
    };
  });
}

/**
 * Extracts the local AS of the BGP process from a configuration dump
 * (`display current-configuration configuration bgp`).
 *
 * A context that exposes more than one `bgp <as>` process is ambiguous: nothing
 * is persisted and no administrative action is allowed for such a device.
 */
export function parseHuaweiBgpLocalAs(configuration: string): ParsedHuaweiBgpLocalAs {
  const values = new Set<string>();
  for (const line of configuration.split(/\r?\n/)) {
    const match = line.match(/^\s*bgp\s+(?:AS)?(\d+(?:\.\d+)?)\s*$/i);
    if (!match?.[1]) continue;
    const parsed = parseHuaweiAsNumber(match[1]);
    if (parsed !== null) values.add(parsed.toString());
  }
  if (values.size !== 1) return { localAs: null, ambiguous: values.size > 1 };
  return { localAs: BigInt([...values][0]!), ambiguous: false };
}

/**
 * Configuration-based admin-state read-back: a `peer <addr> ignore` line in the
 * BGP configuration section confirms the session is administratively ignored.
 * Returns null when the peer does not appear in the inspected configuration.
 */
export function parseHuaweiPeerAdminConfig(
  output: string,
  peerAddress: string,
): 'IGNORED' | 'ENABLED' | null {
  const normalized = normalizeIpAddress(peerAddress);
  if (normalized === null) return null;
  let found = false;
  let ignored = false;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*peer\s+(\S+)\s+(.+?)\s*$/i);
    if (!match?.[1] || !match[2]) continue;
    // Devices may print a different (uncompressed or upper-case) IPv6 form.
    if (normalizeIpAddress(match[1]) !== normalized) continue;
    found = true;
    if (/^ignore(?:\s|$)/i.test(match[2])) ignored = true;
  }
  return found ? (ignored ? 'IGNORED' : 'ENABLED') : null;
}

function cleanInterfaceName(value: string): string | null {
  const withoutComment = value.replace(/\/\/.*$/, '').trim();
  if (
    !withoutComment ||
    withoutComment === '-' ||
    /^(?:n\/?a|none|unresolved)$/i.test(withoutComment)
  ) {
    return null;
  }
  return withoutComment;
}

function parseHuaweiIpv4RouteLookup(
  output: string,
  summaryCount: number,
): { interfaceNames: string[]; unresolvedRoute: boolean; parsedRouteRows: number } {
  const interfaceNames: string[] = [];
  let parsedRouteRows = 0;
  let unresolvedRoute = false;

  for (const line of output.split(/\r?\n/)) {
    const addresses = [...line.matchAll(IPV4_GLOBAL)];
    const lastAddress = addresses.at(-1);
    if (!lastAddress || lastAddress.index === undefined) continue;
    const beforeNextHop = line.slice(0, lastAddress.index);
    const fullRoute = DESTINATION_PATTERN.test(beforeNextHop);
    const continuation =
      !fullRoute && addresses.length === 1 && /^\s*[A-Z-]{0,5}\s*$/i.test(beforeNextHop);
    if (!fullRoute && !continuation) continue;

    parsedRouteRows += 1;
    const afterNextHop = line.slice(lastAddress.index + lastAddress[0].length);
    const interfaceName = cleanInterfaceName(afterNextHop);
    if (interfaceName) interfaceNames.push(interfaceName);
    else unresolvedRoute = true;
  }

  const incompleteSummary = Number.isFinite(summaryCount) && summaryCount > parsedRouteRows;
  return {
    interfaceNames: [...new Set(interfaceNames)],
    unresolvedRoute: unresolvedRoute || incompleteSummary,
    parsedRouteRows,
  };
}

/**
 * IPv6 route lookup (`display ipv6 routing-table <peer>`). VRP prints IPv6
 * routes either as a block (`Destination :` / `NextHop :` / `Interface :`) or as
 * a single line that ends with the egress interface, so both layouts are
 * accepted. Any route row without an unambiguous interface invalidates the
 * correlation, exactly like the IPv4 path.
 */
/** Destination column with prefix length, e.g. `2001:DB8::/64`. */
function hasIpv6DestinationWithPrefix(value: string): boolean {
  const match = /(?:\s|^)([0-9a-fA-F:]{2,})\/\d{1,3}(?=\s|$)/.exec(value);
  return Boolean(match?.[1] && normalizeIpv6(match[1]) !== null);
}

function parseHuaweiIpv6RouteLookup(
  output: string,
  summaryCount: number,
): { interfaceNames: string[]; unresolvedRoute: boolean; parsedRouteRows: number } {
  const interfaceNames: string[] = [];
  let destinationRows = 0;
  let parsedRouteRows = 0;
  let unresolvedRoute = false;

  for (const line of output.split(/\r?\n/)) {
    // Block layout: `Interface    : 100GE1/0/3            Flags : RD`
    const interfaceMatch = line.match(/^\s*Interface\s*:\s*(.+?)(?:\s{2,}.*)?\s*$/i);
    if (interfaceMatch?.[1]) {
      const interfaceName = cleanInterfaceName(interfaceMatch[1]);
      if (interfaceName) interfaceNames.push(interfaceName);
      else unresolvedRoute = true;
      continue;
    }
    if (/^\s*Destination\s*:/i.test(line)) {
      destinationRows += 1;
      continue;
    }

    const addresses = [...line.matchAll(IPV6_TOKEN)]
      .filter((token) => normalizeIpv6(token[0]) !== null);
    const lastAddress = addresses.at(-1);
    if (!lastAddress || lastAddress.index === undefined) continue;
    const beforeNextHop = line.slice(0, lastAddress.index);
    const fullRoute = hasIpv6DestinationWithPrefix(beforeNextHop);
    const continuation =
      !fullRoute && addresses.length === 1 && /^\s*[A-Z-]{0,8}\s*$/.test(beforeNextHop);
    if (!fullRoute && !continuation) continue;

    parsedRouteRows += 1;
    const interfaceName = cleanInterfaceName(
      line.slice(lastAddress.index + lastAddress[0].length),
    );
    if (interfaceName) interfaceNames.push(interfaceName);
    else unresolvedRoute = true;
  }

  const routeRows = destinationRows + parsedRouteRows;
  const incompleteSummary = Number.isFinite(summaryCount) && summaryCount > routeRows;
  return {
    interfaceNames: [...new Set(interfaceNames)],
    unresolvedRoute: unresolvedRoute || incompleteSummary,
    parsedRouteRows: routeRows,
  };
}

export function parseHuaweiRouteLookup(
  output: string,
  addressFamily: BgpAddressFamily = 'IPV4',
): ParsedHuaweiRouteLookup {
  const summaryCount = Number(output.match(/Summary\s+Count\s*:\s*(\d+)/i)?.[1] ?? Number.NaN);
  const parsed =
    addressFamily === 'IPV6'
      ? parseHuaweiIpv6RouteLookup(output, summaryCount)
      : parseHuaweiIpv4RouteLookup(output, summaryCount);

  const routeFound =
    (Number.isFinite(summaryCount) && summaryCount > 0) || parsed.parsedRouteRows > 0;
  return {
    routeFound,
    interfaceNames: parsed.interfaceNames,
    unresolvedRoute: routeFound && (parsed.unresolvedRoute || parsed.interfaceNames.length === 0),
  };
}
