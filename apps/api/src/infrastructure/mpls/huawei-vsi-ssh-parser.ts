import type {
  MplsAdminStatus,
  MplsLdpPeer,
  MplsLdpSessionState,
  MplsVsiOperationalStatus,
} from '@gmj/shared';

/**
 * Parsers das saidas CLI de VSI/VPLS e LDP do VRP.
 *
 * O objetivo e reconhecer o que o equipamento REALMENTE imprimiu: linha que o
 * parser nao entende e ignorada, campo ausente continua `null`/`UNKNOWN`, e
 * nenhum valor e derivado por conta propria. VSI sinalizada por LDP, BGP ou
 * BGP-AD usa o mesmo caminho — o tipo de sinalizacao e apenas um atributo.
 */

export interface ParsedVsiPeer {
  remoteRouterId: string;
  linkId: number | null;
  localLabel: number | null;
  remoteLabel: number | null;
  state: 'UP' | 'DOWN' | 'UNKNOWN';
  mtu: number | null;
  vcType: string | null;
  tunnelPolicy: string | null;
  acInterfaceName: string | null;
}

export interface ParsedVsi {
  name: string;
  vsiId: number | null;
  rd: string | null;
  operationalStatus: MplsVsiOperationalStatus;
  adminStatus: MplsAdminStatus;
  signalingType: string;
  description: string | null;
  mtu: number | null;
  vcType: string;
  tunnelPolicy: string | null;
  /** `STATIC`/`DYNAMIC` quando o VRP imprime a descoberta de membros. */
  peerDiscovery: string | null;
  peers: ParsedVsiPeer[];
  acInterfaceNames: string[];
}

export interface ParsedL2vc {
  acInterfaceName: string;
  vcId: number | null;
  destination: string | null;
  state: 'UP' | 'DOWN' | 'UNKNOWN';
  /** Estado do AC impresso pelo VRP (`AC status` ou `is up/down` no cabecalho). */
  acState: 'UP' | 'DOWN' | 'UNKNOWN';
  /** Estado da sessao LDP do VC (`session state`), quando impresso. */
  sessionState: 'UP' | 'DOWN' | 'UNKNOWN';
  vcType: string | null;
  mtu: number | null;
  localLabel: number | null;
  remoteLabel: number | null;
  tunnelPolicy: string | null;
}

export interface ParsedLdpRemotePeer {
  name: string;
  ipAddress: string | null;
  /** LDP ID local do equipamento, como o VRP imprime neste comando. */
  localLdpId: string | null;
}

const VSI_HEADER = /^\s*\*{0,3}\s*VSI\s+Name\s*:\s*(.+?)\s*$/i;
const PEER_HEADER = /^\s*\*{0,3}\s*Peer\s+Router\s+ID\s*:\s*(\S+)\s*$/i;
const KEY_VALUE = /^\s*\*{0,3}\s*([A-Za-z][A-Za-z0-9 /()._-]*?)\s*:\s*(.*?)\s*$/;
const VSI_ROW = /^\s*(\S+)\s+(\d+)\s+(up|down|admin\s*down)\s*$/i;
const PEER_ID = /^[0-9A-Fa-f:.]{2,}:\d+$/;
const LDP_STATE_TOKEN = /^(operational|nonexistent|initialized|opensent|openrecv|openrcv|closing|down)$/i;
const CLOCK = /^(\d{1,4}):(\d{2}):(\d{2})$/;

function labelOf(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '-' || trimmed === '--') return null;
  return trimmed;
}

/** Remove as aspas que o VRP usa em nomes (`"6730-sw-alfenas"`). */
function unquote(value: string | null): string | null {
  if (!value) return null;
  const unquoted = /^".*"$/.test(value) ? value.slice(1, -1).trim() : value;
  return unquoted || null;
}

/**
 * Uma linha pode trazer DOIS pares chave/valor separados por espacos largos,
 * como no `display mpls l2vc` real:
 *   local VC label : 1024         remote VC label : 1024
 * O corte usa "2+ espacos + rotulo + ':'" como delimitador do proximo par.
 */
function pairsOf(line: string): Array<{ label: string; value: string | null }> {
  const pairs: Array<{ label: string; value: string | null }> = [];
  const pattern =
    /([A-Za-z][A-Za-z0-9 /()._-]*?)\s*:\s*(.*?)(?=\s{2,}[A-Za-z][A-Za-z0-9 /()._-]*?\s*:|$)/g;
  for (const match of line.matchAll(pattern)) {
    const label = labelOf(match[1] ?? '');
    if (!label) continue;
    pairs.push({ label, value: cleanValue(match[2]) });
  }
  return pairs;
}

function integer(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cliState(value: string | null): 'UP' | 'DOWN' | 'ADMIN_DOWN' | 'UNKNOWN' {
  const normalized = value?.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return 'UNKNOWN';
  if (normalized === 'up') return 'UP';
  if (normalized.includes('admin down')) return 'ADMIN_DOWN';
  if (normalized.startsWith('down') || normalized.includes('down(') || normalized.includes('down (')) {
    return 'DOWN';
  }
  if (normalized.includes('plug out') || normalized.includes('plug-out')) return 'DOWN';
  return 'UNKNOWN';
}

function cliSignalingType(value: string | null): string {
  if (!value) return 'UNKNOWN';
  const normalized = labelOf(value);
  switch (normalized) {
    case 'ldp':
      return 'LDP';
    case 'bgp':
      return 'BGP';
    case 'bgp ad':
      return 'BGP_AD';
    case 'bgp mh':
      return 'BGP_MH';
    case 'ldp bgp':
    case 'bgp ldp':
      return 'LDP_BGP_MIXED';
    case 'ldp bgp ad':
    case 'bgp ad ldp':
      return 'LDP_BGP_AD_MIXED';
    default:
      return normalized ? normalized.toUpperCase() : 'UNKNOWN';
  }
}

function cliVcType(value: string | null): string | null {
  if (!value) return null;
  return labelOf(value).toUpperCase();
}

/** Descoberta de membros: so o que o VRP declara explicitamente. */
function cliMemberDiscovery(value: string | null): string | null {
  const normalized = value?.toLowerCase().trim();
  if (!normalized) return null;
  if (/^(enable|enabled|dynamic|auto)$/.test(normalized)) return 'DYNAMIC';
  if (/^(disable|disabled|static|manual)$/.test(normalized)) return 'STATIC';
  return normalized.toUpperCase();
}

function cliAdminStatus(value: string | null): MplsAdminStatus {
  const state = cliState(value);
  if (state === 'UP') return 'UP';
  if (state === 'DOWN' || state === 'ADMIN_DOWN') return 'DOWN';
  return 'UNKNOWN';
}

function defaultVsi(name: string): ParsedVsi {
  return {
    name,
    vsiId: null,
    rd: null,
    operationalStatus: 'UNKNOWN',
    adminStatus: 'UNKNOWN',
    signalingType: 'UNKNOWN',
    description: null,
    mtu: null,
    vcType: 'UNKNOWN',
    tunnelPolicy: null,
    peerDiscovery: null,
    peers: [],
    acInterfaceNames: [],
  };
}

function defaultPeer(remoteRouterId: string): ParsedVsiPeer {
  return {
    remoteRouterId,
    linkId: null,
    localLabel: null,
    remoteLabel: null,
    state: 'UNKNOWN',
    mtu: null,
    vcType: null,
    tunnelPolicy: null,
    acInterfaceName: null,
  };
}

function registerAcInterface(vsi: ParsedVsi, peer: ParsedVsiPeer | null, name: string): void {
  if (peer) peer.acInterfaceName ??= name;
  if (!vsi.acInterfaceNames.includes(name)) vsi.acInterfaceNames.push(name);
}

function applyVsiPair(
  vsi: ParsedVsi,
  peer: ParsedVsiPeer | null,
  label: string,
  value: string | null,
): void {
  switch (label) {
    case 'vsi id':
      vsi.vsiId ??= integer(value);
      return;
    case 'vsi rd':
    case 'rd':
      vsi.rd ??= value;
      return;
    case 'vsi state': {
      const state = cliState(value);
      if (state === 'ADMIN_DOWN') vsi.operationalStatus = 'ADMIN_DOWN';
      else if (state === 'UP' || state === 'DOWN') vsi.operationalStatus = state;
      return;
    }
    case 'admin state':
    case 'vsi admin state':
      vsi.adminStatus = cliAdminStatus(value);
      return;
    case 'vsi description':
    case 'description':
      vsi.description ??= value;
      return;
    case 'vsi signaling type':
    case 'signaling type':
      if (vsi.signalingType === 'UNKNOWN') vsi.signalingType = cliSignalingType(value);
      return;
    case 'vsi tunnel policy':
    case 'tunnel policy':
      if (peer) peer.tunnelPolicy ??= value;
      else vsi.tunnelPolicy ??= value;
      return;
    case 'auto discovery':
    case 'auto-discovery':
    case 'peer discovery':
    case 'member discovery':
    case 'vsi peer discovery':
      vsi.peerDiscovery ??= cliMemberDiscovery(value);
      return;
    case 'mtu':
    case 'negotiated mtu': {
      const parsed = integer(value);
      if (peer) peer.mtu ??= parsed;
      vsi.mtu ??= parsed;
      return;
    }
    case 'vc type': {
      const parsed = cliVcType(value);
      if (peer) peer.vcType ??= parsed;
      if (vsi.vcType === 'UNKNOWN' && parsed) vsi.vcType = parsed;
      return;
    }
    case 'vc state':
      if (peer) {
        const state = cliState(value);
        peer.state = state === 'ADMIN_DOWN' ? 'DOWN' : state;
      }
      return;
    case 'link id':
      if (peer) peer.linkId ??= integer(value);
      return;
    case 'local vc label':
      if (peer) peer.localLabel ??= integer(value);
      return;
    case 'remote vc label':
      if (peer) peer.remoteLabel ??= integer(value);
      return;
    case 'local ac interface':
    case 'ac interface':
    case 'client interface':
      if (value) registerAcInterface(vsi, peer, value);
      return;
    default:
      return;
  }
}

/**
 * `display vsi verbose`: blocos iniciados por `VSI Name` e, dentro deles,
 * blocos de peer iniciados por `Peer Router ID`. Aceita o formato com `*`/`**`
 * que o VRP usa para marcar o peer principal.
 */
export function parseHuaweiVsiVerbose(output: string): ParsedVsi[] {
  const vsis: ParsedVsi[] = [];
  let current: ParsedVsi | null = null;
  let peer: ParsedVsiPeer | null = null;

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(VSI_HEADER);
    if (header?.[1]) {
      const name = cleanValue(header[1]);
      current = name ? defaultVsi(name) : null;
      peer = null;
      if (current) vsis.push(current);
      continue;
    }
    if (!current) continue;

    const peerHeader = line.match(PEER_HEADER);
    if (peerHeader?.[1]) {
      peer = defaultPeer(peerHeader[1]);
      current.peers.push(peer);
      continue;
    }

    const pair = line.match(KEY_VALUE);
    if (!pair?.[1]) continue;
    applyVsiPair(current, peer, labelOf(pair[1]), cleanValue(pair[2]));
  }

  return vsis;
}

/** Nomes listados por `display vsi` (sem verbose), usados como fallback. */
export function parseHuaweiVsiNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*total\b/i.test(line)) continue;
    if (/^\s*vsi\s+name\b/i.test(line)) continue;
    const row = line.match(VSI_ROW);
    if (row?.[1] && !names.includes(row[1])) names.push(row[1]);
  }
  return names;
}

function ldpState(value: string | null): MplsLdpSessionState {
  if (!value) return 'UNKNOWN';
  return /^operational$/i.test(value.trim()) ? 'UP' : 'DOWN';
}

function clockToSeconds(value: string | null): number | null {
  const match = value?.match(CLOCK);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * `display mpls ldp session`: aceita tanto o formato em bloco (`Peer LDP ID:`,
 * `Session State:`) quanto o tabular (`10.0.0.2:0  Operational  DU  Passive`).
 */
export function parseHuaweiLdpSessions(output: string): MplsLdpPeer[] {
  const peers = new Map<string, MplsLdpPeer>();
  let block: MplsLdpPeer | null = null;

  const flush = () => {
    if (block) peers.set(block.peerLdpId, { ...peers.get(block.peerLdpId), ...block });
    block = null;
  };

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^\s*\*{0,3}\s*Peer\s+(?:LDP\s+)?ID\s*:\s*(\S+)/i);
    if (header?.[1]) {
      flush();
      const existing = peers.get(header[1]);
      block = existing ?? {
        peerLdpId: header[1],
        state: 'UNKNOWN',
        statusText: null,
        localLdpId: null,
        role: null,
        name: null,
        sessionAgeSeconds: null,
        source: 'SSH',
      };
      continue;
    }

    if (block) {
      const pair = line.match(KEY_VALUE);
      if (pair?.[1]) {
        const label = labelOf(pair[1]);
        const value = cleanValue(pair[2]);
        if (label === 'session state' || label === 'status' || label === 'state') {
          block.statusText ??= value;
          block.state = ldpState(value);
        } else if (label === 'local ldp id') {
          block.localLdpId ??= value;
        } else if (label === 'ssnrole' || label === 'session role' || label === 'role') {
          block.role ??= value;
        } else if (label === 'ssnage' || label === 'session age') {
          block.sessionAgeSeconds ??= clockToSeconds(value);
        }
        continue;
      }
    }

    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2 || !PEER_ID.test(tokens[0] ?? '')) continue;
    const peerLdpId = tokens[0]!;
    const statusToken = tokens.slice(1).find((token) => LDP_STATE_TOKEN.test(token)) ?? null;
    const role = tokens.find((token) => /^(active|passive)$/i.test(token)) ?? null;
    const age = tokens.find((token) => CLOCK.test(token)) ?? null;
    const existing = peers.get(peerLdpId);
    peers.set(peerLdpId, {
      peerLdpId,
      state: ldpState(statusToken),
      statusText: statusToken,
      localLdpId: existing?.localLdpId ?? null,
      role: role ?? existing?.role ?? null,
      name: existing?.name ?? null,
      sessionAgeSeconds: clockToSeconds(age),
      source: 'SSH',
    });
  }

  flush();
  return [...peers.values()];
}

const L2VC_HEADER = /^\s*\*{0,3}\s*client\s+interface\s*:\s*(\S+?)(?:\s+is\s+(up|down))?\s*$/i;

export interface HuaweiL2vcSummary {
  total: number | null;
  up: number | null;
  down: number | null;
}

/** Linha de totais do `display mpls l2vc`: `Total LDP VC : 20  12 up  8 down`. */
export function parseHuaweiL2vcSummary(output: string): HuaweiL2vcSummary {
  const match = output.match(/Total\s+LDP\s+VC\s*:\s*(\d+)\s+(\d+)\s+up\s+(\d+)\s+down/i);
  return {
    total: match?.[1] ? Number(match[1]) : null,
    up: match?.[2] ? Number(match[2]) : null,
    down: match?.[3] ? Number(match[3]) : null,
  };
}

/**
 * `display mpls ldp remote-peer`: nome configurado do remote-peer, usado apenas
 * para rotular a sessao LDP. No S6730S o `LDP ID` impresso e o LOCAL, e o
 * `Remote Peer IP` e o que identifica o vizinho; o nome vem entre aspas.
 */
export function parseHuaweiLdpRemotePeers(output: string): ParsedLdpRemotePeer[] {
  const peers: ParsedLdpRemotePeer[] = [];
  let current: ParsedLdpRemotePeer | null = null;

  for (const line of output.split(/\r?\n/)) {
    for (const { label, value } of pairsOf(line)) {
      if (label === 'remote peer name' || label === 'peer name') {
        const name = unquote(value);
        current = name ? { name, ipAddress: null, localLdpId: null } : null;
        if (current) peers.push(current);
        continue;
      }
      if (!current) continue;
      if (label === 'remote peer ip' || label === 'peer ip address' || label === 'peer ip') {
        current.ipAddress ??= value;
      } else if (label === 'ldp id' || label === 'local ldp id') {
        current.localLdpId ??= value;
      }
    }
  }

  return peers;
}

/**
 * `display mpls l2vc`: um bloco por AC, com VC ID, destino, estado e labels.
 *
 * Formato real do S6730S usa DUAS chaves por linha e o estado no cabecalho:
 *
 *   *client interface : Vlanif100 is down
 *    AC status        : down
 *    session state    : up
 *    VC state         : down
 *    local VC label   : 1024     remote VC label : 1024
 *
 * O parser aceita tambem o formato de uma chave por linha.
 */
export function parseHuaweiL2vc(output: string): ParsedL2vc[] {
  const rows: ParsedL2vc[] = [];
  let current: ParsedL2vc | null = null;

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(L2VC_HEADER);
    if (header?.[1]) {
      const headerState = header[2]?.toLowerCase();
      current = {
        acInterfaceName: header[1],
        vcId: null,
        destination: null,
        state: 'UNKNOWN',
        acState: headerState === 'up' ? 'UP' : headerState === 'down' ? 'DOWN' : 'UNKNOWN',
        sessionState: 'UNKNOWN',
        vcType: null,
        mtu: null,
        localLabel: null,
        remoteLabel: null,
        tunnelPolicy: null,
      };
      rows.push(current);
      continue;
    }
    if (!current) continue;

    for (const { label, value } of pairsOf(line)) {
      switch (label) {
        case 'vc id':
          current.vcId ??= integer(value);
          break;
        case 'vc state': {
          const state = cliState(value);
          if (state !== 'UNKNOWN') current.state = state === 'UP' ? 'UP' : 'DOWN';
          break;
        }
        case 'ac status': {
          const state = cliState(value);
          if (state !== 'UNKNOWN') current.acState = state === 'UP' ? 'UP' : 'DOWN';
          break;
        }
        case 'session state': {
          const state = cliState(value);
          if (state !== 'UNKNOWN') current.sessionState = state === 'UP' ? 'UP' : 'DOWN';
          break;
        }
        case 'vc type':
          current.vcType ??= cliVcType(value);
          break;
        case 'destination':
          current.destination ??= value;
          break;
        case 'local vc label':
          current.localLabel ??= integer(value);
          break;
        case 'remote vc label':
          current.remoteLabel ??= integer(value);
          break;
        case 'local vc mtu':
          current.mtu ??= integer(value);
          break;
        case 'tunnel policy name':
        case 'tunnel policy':
          current.tunnelPolicy ??= value;
          break;
        default:
          break;
      }
    }
  }

  return rows;
}
