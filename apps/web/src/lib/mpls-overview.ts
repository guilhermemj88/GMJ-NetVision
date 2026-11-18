import {
  summarizeMpls,
  type MplsAc,
  type MplsCapabilities,
  type MplsConflict,
  type MplsDiscoveryState,
  type MplsHostOverview,
  type MplsL2vcCircuit,
  type MplsLdpPeer,
  type MplsPw,
  type MplsSource,
  type MplsSummary,
  type MplsVsi,
} from '@gmj/shared';

/**
 * P5 (2a auditoria): a Web publicada (RC13) conversa com APIs de releases
 * diferentes. Um build da API anterior ao MPLS/SSH nao devolve `ldpPeers`,
 * `l2vcCircuits`, `conflicts`, `sources` nem `discoveryState` — e o painel
 * quebrava em `undefined.length` antes mesmo de renderizar.
 *
 * A normalizacao transforma QUALQUER resposta em um `MplsHostOverview`
 * completo. Nada e inventado: campo ausente vira colecao vazia, contador zero
 * ou `null`, e o que a coleta nao reportou nao e apresentado como coletado.
 */

const DISCOVERY_STATES: readonly MplsDiscoveryState[] = [
  'UNKNOWN',
  'FOUND_UP',
  'FOUND_DOWN',
  'FOUND_MIXED',
  'FOUND_L2VC',
  'NOT_FOUND',
  'INCOMPLETE',
  'UNSUPPORTED',
  'CONFLICT',
];

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {};
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function flag(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function source(value: unknown): MplsSource {
  // Release sem descoberta SSH so coletava por SNMP: o rotulo antigo e honesto.
  return value === 'SSH' ? 'SSH' : 'SNMP';
}

function sources(value: unknown): MplsSource[] {
  return list<unknown>(value).filter((item): item is MplsSource => item === 'SNMP' || item === 'SSH');
}

function discoveryState(value: unknown, supported: boolean): MplsDiscoveryState {
  if (DISCOVERY_STATES.includes(value as MplsDiscoveryState)) {
    return value as MplsDiscoveryState;
  }
  return supported ? 'UNKNOWN' : 'UNSUPPORTED';
}

function summary(value: unknown, vsis: MplsVsi[]): MplsSummary {
  const raw = dict(value);
  if (Object.keys(raw).length === 0) return summarizeMpls(vsis);
  return {
    vsiTotal: num(raw.vsiTotal) ?? 0,
    vsiUp: num(raw.vsiUp) ?? 0,
    vsiDown: num(raw.vsiDown) ?? 0,
    vsiDegraded: num(raw.vsiDegraded) ?? 0,
    vsiAdminDown: num(raw.vsiAdminDown) ?? 0,
    vsiUnknown: num(raw.vsiUnknown) ?? 0,
    pwTotal: num(raw.pwTotal) ?? 0,
    pwUp: num(raw.pwUp) ?? 0,
    pwDown: num(raw.pwDown) ?? 0,
  };
}

function capabilities(value: unknown, vsis: MplsVsi[]): MplsCapabilities {
  const raw = dict(value);
  if (Object.keys(raw).length > 0) {
    return { vsi: flag(raw.vsi), ac: flag(raw.ac), pw: flag(raw.pw) };
  }
  // API antiga nao declarava capacidades: deriva do que veio na resposta.
  return {
    vsi: vsis.length > 0,
    ac: vsis.some((vsi) => vsi.acs.length > 0),
    pw: vsis.some((vsi) => vsi.pws.length > 0),
  };
}

function normalizaVsi(value: unknown): MplsVsi {
  const raw = dict(value);
  const acs = list<unknown>(raw.acs).map((item) => ({ ...dict(item) }) as unknown as MplsAc);
  const pws = list<unknown>(raw.pws).map((item) => ({ ...dict(item) }) as unknown as MplsPw);
  return {
    ...(raw as unknown as MplsVsi),
    id: text(raw.id) ?? '',
    hostId: text(raw.hostId) ?? '',
    name: text(raw.name) ?? '',
    signalingType: typeof raw.signalingType === 'string' ? raw.signalingType : '',
    rd: text(raw.rd),
    vsiId: num(raw.vsiId),
    status: (raw.status as MplsVsi['status']) ?? 'UNKNOWN',
    operationalStatus: (raw.operationalStatus as MplsVsi['operationalStatus']) ?? 'UNKNOWN',
    adminStatus: (raw.adminStatus as MplsVsi['adminStatus']) ?? 'UNKNOWN',
    mtu: num(raw.mtu),
    vcType: typeof raw.vcType === 'string' ? raw.vcType : '',
    tunnelPolicy: text(raw.tunnelPolicy),
    description: text(raw.description),
    memberDiscovery: text(raw.memberDiscovery),
    vlanId: num(raw.vlanId),
    localInterfaceId: text(raw.localInterfaceId),
    source: source(raw.source),
    lastSeenAt: text(raw.lastSeenAt) ?? '',
    createdAt: text(raw.createdAt) ?? '',
    updatedAt: text(raw.updatedAt) ?? '',
    acs,
    pws,
  };
}

export function normalizeMplsOverview(value: unknown): MplsHostOverview {
  const raw = dict(value);
  const supported = flag(raw.supported);
  const vsis = list<unknown>(raw.vsis).map(normalizaVsi);
  return {
    ...(raw as unknown as MplsHostOverview),
    supported,
    discoveryState: discoveryState(raw.discoveryState, supported),
    capabilities: capabilities(raw.capabilities, vsis),
    source: source(raw.source),
    sources: sources(raw.sources),
    ldpPeers: list<MplsLdpPeer>(raw.ldpPeers),
    l2vcCircuits: list<MplsL2vcCircuit>(raw.l2vcCircuits),
    conflicts: list<MplsConflict>(raw.conflicts),
    lastPollingAt: text(raw.lastPollingAt),
    lastSuccessAt: text(raw.lastSuccessAt),
    lastErrorSafe: text(raw.lastErrorSafe),
    summary: summary(raw.summary, vsis),
    vsis,
    ...(flag(raw.diagnosticEnabled) ? { diagnosticEnabled: true } : {}),
    ...(raw.diagnosticTrust === 'AVAILABLE' || raw.diagnosticTrust === 'UNAVAILABLE'
      ? { diagnosticTrust: raw.diagnosticTrust }
      : {}),
  };
}
