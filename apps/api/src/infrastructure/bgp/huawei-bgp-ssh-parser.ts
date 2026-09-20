import type { BgpPeerState } from './bgp4-peer-parser';

export interface ParsedHuaweiBgpPeer {
  peerAddress: string;
  remoteAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  cliReceivedPrefixes: bigint | null;
}

export interface ParsedHuaweiRouteLookup {
  routeFound: boolean;
  interfaceNames: string[];
  unresolvedRoute: boolean;
}

const IPV4_PATTERN = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}';
const IPV4_EXACT = new RegExp(`^${IPV4_PATTERN}$`);
const IPV4_GLOBAL = new RegExp(`\\b${IPV4_PATTERN}\\b`, 'g');
const DESTINATION_PATTERN = new RegExp(`\\b${IPV4_PATTERN}\\/(?:[0-9]|[12]\\d|3[0-2])\\b`);
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

function summaryPeerFromLine(line: string): ParsedHuaweiBgpPeer | null {
  const tokens = line.trim().split(/\s+/);
  const peerAddress = tokens[0];
  if (!peerAddress || !IPV4_EXACT.test(peerAddress) || tokens[1] !== '4') return null;
  const remoteAs = parseHuaweiAsNumber(tokens[2]);
  const stateIndex = tokens.findIndex((token, index) => index >= 3 && normalizedState(token));
  const parsedState = stateIndex >= 0 ? normalizedState(tokens[stateIndex]) : null;
  const uptime = stateIndex > 0 ? parseHuaweiBgpUptime(tokens[stateIndex - 1]) : null;
  const cliReceivedPrefixes = stateIndex >= 0 ? unsignedBigInt(tokens[stateIndex + 1]) : null;
  return {
    peerAddress,
    remoteAs,
    stateCode: parsedState?.stateCode ?? null,
    state: parsedState?.state ?? null,
    sessionUptimeSeconds: parsedState?.state === 'ESTABLISHED' ? uptime : null,
    cliReceivedPrefixes,
  };
}

export function parseHuaweiBgpPeerSummary(output: string): ParsedHuaweiBgpPeer[] {
  const peers = new Map<string, ParsedHuaweiBgpPeer>();
  for (const line of output.split(/\r?\n/)) {
    const peer = summaryPeerFromLine(line);
    if (peer) peers.set(peer.peerAddress, peer);
  }
  return [...peers.values()];
}

export function parseHuaweiBgpPeerVerbose(output: string): ParsedHuaweiBgpPeer[] {
  const starts = [...output.matchAll(/BGP\s+Peer\s+is\s+((?:\d{1,3}\.){3}\d{1,3})/gi)];
  return starts.flatMap((start, index) => {
    const peerAddress = start[1];
    if (!peerAddress || !IPV4_EXACT.test(peerAddress) || start.index === undefined) return [];
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
    return [
      {
        peerAddress,
        remoteAs,
        stateCode: parsedState?.stateCode ?? null,
        state: parsedState?.state ?? null,
        sessionUptimeSeconds: parsedState?.state === 'ESTABLISHED' ? uptime : null,
        cliReceivedPrefixes: unsignedBigInt(prefixValue),
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
      remoteAs: peer.remoteAs ?? detail.remoteAs,
      stateCode: peer.stateCode ?? detail.stateCode,
      state: peer.state ?? detail.state,
      sessionUptimeSeconds: peer.sessionUptimeSeconds ?? detail.sessionUptimeSeconds,
      cliReceivedPrefixes: peer.cliReceivedPrefixes ?? detail.cliReceivedPrefixes,
    };
  });
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

export function parseHuaweiRouteLookup(output: string): ParsedHuaweiRouteLookup {
  const summaryCount = Number(output.match(/Summary\s+Count\s*:\s*(\d+)/i)?.[1] ?? Number.NaN);
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

  const uniqueInterfaces = [...new Set(interfaceNames)];
  const routeFound = (Number.isFinite(summaryCount) && summaryCount > 0) || parsedRouteRows > 0;
  const incompleteSummary = Number.isFinite(summaryCount) && summaryCount > parsedRouteRows;
  return {
    routeFound,
    interfaceNames: uniqueInterfaces,
    unresolvedRoute:
      routeFound && (unresolvedRoute || incompleteSummary || uniqueInterfaces.length === 0),
  };
}
