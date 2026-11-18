import type {
  MplsConflict,
  MplsDiscoveryState,
  MplsL2vcCircuit,
  MplsLdpPeer,
  MplsPwState,
  MplsPwStatus,
  MplsSource,
  MplsStatus,
} from '@gmj/shared';
import {
  HUAWEI_VPLS_AC_COLUMNS,
  HUAWEI_VPLS_PW_COLUMNS,
  HUAWEI_VPLS_VSI_COLUMNS,
} from './huawei-vpls-oids';
import {
  aggregateMplsVsiStatus,
  type CollectedMplsAc,
  type CollectedMplsPw,
  type CollectedMplsVsi,
  type HuaweiVplsCollection,
} from './huawei-vpls-snmp';
import type { ParsedL2vc, ParsedVsi } from './huawei-vsi-ssh-parser';
import type { HuaweiVsiSshReading } from './huawei-vsi-ssh';

/**
 * Normalizacao SNMP + SSH da descoberta MPLS.
 *
 * Regra central: MIB vazia NAO e ausencia de servico. O estado final distingue
 * servico encontrado (UP/DOWN), nao encontrado, descoberta nao suportada,
 * coleta incompleta e informacoes conflitantes, sempre com as fontes que
 * responderam e com as duas evidencias quando elas divergem.
 */

export interface MplsDiscoveryInput {
  /** `null` quando a coleta SNMP falhou por completo. */
  snmp: HuaweiVplsCollection | null;
  /** `null` quando o SSH nao foi tentado ou nao respondeu. */
  ssh: HuaweiVsiSshReading | null;
}

export interface MplsDiscoveryResult {
  collection: HuaweiVplsCollection;
  discoveryState: MplsDiscoveryState;
  conflicts: MplsConflict[];
  ldpPeers: MplsLdpPeer[];
  l2vcCircuits: MplsL2vcCircuit[];
  sources: MplsSource[];
}

const ALL_VSI_COLUMNS = Object.values(HUAWEI_VPLS_VSI_COLUMNS) as number[];
const ALL_AC_COLUMNS = Object.values(HUAWEI_VPLS_AC_COLUMNS) as number[];
const ALL_PW_COLUMNS = Object.values(HUAWEI_VPLS_PW_COLUMNS) as number[];

function sshAcFrom(
  vsiName: string,
  interfaceName: string,
  l2vc: ParsedL2vc | undefined,
  fallbackState: 'UP' | 'DOWN' | 'UNKNOWN',
): CollectedMplsAc {
  const state = l2vc?.state ?? fallbackState;
  return {
    key: `${vsiName}|${interfaceName}`,
    vsiName,
    ifIndex: null,
    interfaceName,
    status: state === 'UP' ? 'UP' : state === 'DOWN' ? 'DOWN' : 'UNKNOWN',
    upStartTimeRaw: null,
    upSumTimeRaw: null,
    statusObserved: state !== 'UNKNOWN',
    source: 'SSH',
  };
}

function sshPwFrom(vsiName: string, peer: ParsedVsi['peers'][number]): CollectedMplsPw | null {
  // O modelo persistido indexa o PW por (VSI, link id, peer): sem link id nao
  // ha chave confiavel, e inventar um numero criaria um pseudowire fantasma.
  if (peer.linkId === null) return null;
  const status: MplsPwStatus =
    peer.state === 'UP' ? 'UP' : peer.state === 'DOWN' ? 'DOWN' : 'UNKNOWN';
  const state: MplsPwState =
    peer.state === 'UP' ? 'UP' : peer.state === 'DOWN' ? 'DOWN' : 'UNKNOWN';
  return {
    key: `${vsiName}|${peer.linkId}|${peer.remoteRouterId}`,
    vsiName,
    pwId: peer.linkId,
    remoteIp: peer.remoteRouterId,
    tunnelPolicy: peer.tunnelPolicy,
    pwType: 'UNKNOWN',
    inboundLabel: peer.localLabel,
    outboundLabel: peer.remoteLabel,
    status,
    state,
    workingState: 'UNKNOWN',
    upStartTime: null,
    upSumTime: null,
    statusObserved: peer.state !== 'UNKNOWN',
    source: 'SSH',
  };
}

function sshVsiFrom(parsed: ParsedVsi, l2vcs: ParsedL2vc[]): CollectedMplsVsi {
  const pws = parsed.peers
    .map((peer) => sshPwFrom(parsed.name, peer))
    .filter((pw): pw is CollectedMplsPw => pw !== null);
  const acs = parsed.acInterfaceNames.map((interfaceName) =>
    sshAcFrom(
      parsed.name,
      interfaceName,
      l2vcs.find((l2vc) => l2vc.acInterfaceName === interfaceName),
      pws.some((pw) => pw.status === 'DOWN') ? 'DOWN' : 'UNKNOWN',
    ),
  );
  const statusObserved = parsed.operationalStatus !== 'UNKNOWN';
  const base: CollectedMplsVsi = {
    name: parsed.name,
    signalingType: parsed.signalingType,
    rd: parsed.rd,
    vsiId: parsed.vsiId,
    status: 'UNKNOWN',
    operationalStatus: parsed.operationalStatus,
    adminStatus: parsed.adminStatus,
    mtu: parsed.mtu,
    vcType: parsed.vcType,
    tunnelPolicy: parsed.tunnelPolicy,
    description: parsed.description,
    peerDiscovery: parsed.peerDiscovery,
    statusObserved,
    statusComplete: statusObserved,
    acs,
    pws,
    source: 'SSH',
  };
  return { ...base, status: aggregateMplsVsiStatus(base, pws.length > 0 ? true : null) };
}

function l2vcCircuitFrom(parsed: ParsedL2vc): MplsL2vcCircuit {
  return {
    name: parsed.acInterfaceName,
    vcId: parsed.vcId,
    destination: parsed.destination,
    state: parsed.state,
    acState: parsed.acState,
    sessionState: parsed.sessionState,
    vcType: parsed.vcType,
    mtu: parsed.mtu,
    localLabel: parsed.localLabel,
    remoteLabel: parsed.remoteLabel,
    tunnelPolicy: parsed.tunnelPolicy,
    source: 'SSH',
  };
}

function knownStatus(status: string): boolean {
  return status !== 'UNKNOWN';
}

function collectConflict(
  conflicts: MplsConflict[],
  vsiName: string,
  field: string,
  snmpValue: string | number | null,
  sshValue: string | number | null,
): void {
  if (snmpValue === null || sshValue === null) return;
  if (String(snmpValue) === 'UNKNOWN' || String(sshValue) === 'UNKNOWN') return;
  if (String(snmpValue) === String(sshValue)) return;
  conflicts.push({
    vsiName,
    field,
    snmpValue: String(snmpValue),
    sshValue: String(sshValue),
  });
}

/**
 * SSH vence o conflito (e a leitura viva da CLI, a mesma que o operador usa) e
 * as duas evidencias ficam registradas em `conflicts`. A preferencia so vale
 * quando a leitura CLI e mais nova que a SNMP e trouxe valor DEFINITIVO: leitura
 * incompleta nunca substitui evidencia SNMP valida.
 */
function mergeVsi(
  snmp: CollectedMplsVsi | undefined,
  ssh: CollectedMplsVsi,
  conflicts: MplsConflict[],
  preferSsh: boolean,
): CollectedMplsVsi {
  if (!snmp) return ssh;

  if (preferSsh) {
    collectConflict(conflicts, ssh.name, 'status', snmp.status, ssh.status);
    collectConflict(conflicts, ssh.name, 'signalingType', snmp.signalingType, ssh.signalingType);
    collectConflict(conflicts, ssh.name, 'vsiId', snmp.vsiId, ssh.vsiId);
    collectConflict(conflicts, ssh.name, 'mtu', snmp.mtu, ssh.mtu);
    collectConflict(conflicts, ssh.name, 'vcType', snmp.vcType, ssh.vcType);
  }

  const merged: CollectedMplsVsi = {
    name: ssh.name,
    signalingType:
      preferSsh && ssh.signalingType !== 'UNKNOWN' ? ssh.signalingType : snmp.signalingType,
    rd: ssh.rd ?? snmp.rd,
    vsiId: ssh.vsiId ?? snmp.vsiId,
    operationalStatus: preferSsh
      ? ssh.operationalStatus !== 'UNKNOWN'
        ? ssh.operationalStatus
        : snmp.operationalStatus
      : snmp.operationalStatus,
    adminStatus:
      ssh.adminStatus !== 'UNKNOWN' ? ssh.adminStatus : snmp.adminStatus,
    mtu: ssh.mtu ?? snmp.mtu,
    vcType: preferSsh && ssh.vcType !== 'UNKNOWN' ? ssh.vcType : snmp.vcType,
    tunnelPolicy: ssh.tunnelPolicy ?? snmp.tunnelPolicy,
    description: ssh.description ?? snmp.description,
    peerDiscovery: ssh.peerDiscovery ?? snmp.peerDiscovery ?? null,
    statusObserved: ssh.statusObserved || snmp.statusObserved,
    statusComplete: ssh.statusComplete || snmp.statusComplete,
    // AC do SNMP traz ifIndex (correlacao com o inventario); os do SSH trazem o
    // nome da porta. Os dois ficam, desde que nao sejam a mesma interface.
    acs: mergeAcs(snmp.acs, ssh.acs),
    pws: ssh.pws.length ? ssh.pws : snmp.pws,
    status: 'UNKNOWN',
    source: ssh.source ?? 'SNMP',
  };
  if (preferSsh && ssh.pws.length) {
    merged.status = aggregateMplsVsiStatus(merged, true);
  } else {
    merged.status =
      preferSsh && ssh.status !== 'UNKNOWN' ? ssh.status : (snmp.status ?? ssh.status);
  }
  return merged;
}

function mergeAcs(snmpAcs: CollectedMplsAc[], sshAcs: CollectedMplsAc[]): CollectedMplsAc[] {
  const merged = [...snmpAcs];
  for (const ac of sshAcs) {
    const duplicate = merged.some(
      (existing) =>
        (ac.interfaceName && existing.interfaceName === ac.interfaceName) ||
        (ac.ifIndex !== null && existing.ifIndex === ac.ifIndex),
    );
    if (!duplicate) merged.push(ac);
  }
  return merged;
}

function stateForVsis(vsis: CollectedMplsVsi[], conflicts: MplsConflict[]): MplsDiscoveryState {
  if (conflicts.length) return 'CONFLICT';
  if (!vsis.length) return 'INCOMPLETE';
  const up = vsis.filter((vsi) => vsi.status === 'UP').length;
  // DEGRADED e servico encontrado com PW fora: conta como lado DOWN.
  const down = vsis.filter(
    (vsi) => vsi.status === 'DOWN' || vsi.status === 'ADMIN_DOWN' || vsi.status === 'DEGRADED',
  ).length;
  if (up && down) return 'FOUND_MIXED';
  if (up) return 'FOUND_UP';
  if (down) return 'FOUND_DOWN';
  return 'INCOMPLETE';
}

function stateWithoutVsis(
  input: MplsDiscoveryInput,
  l2vcCircuits: MplsL2vcCircuit[],
): MplsDiscoveryState {
  const snmpConclusive = input.snmp !== null && input.snmp.supported === false;
  const sshConclusive = input.ssh?.available === true;
  // `false` = o VRP recusou o comando; `null` = nao deu para saber.
  const sshUnsupported = input.ssh?.supported === false;

  // Sem VSI, mas com circuito L2VC lido: o servico existe (VPWS), nao e ausencia.
  if (l2vcCircuits.length) return 'FOUND_L2VC';
  // Sem VSI e sem NENHUMA leitura concluida: inconclusivo, nunca "inexistente".
  if (sshUnsupported && (snmpConclusive || input.snmp === null)) return 'UNSUPPORTED';
  if (sshConclusive) return 'NOT_FOUND';
  if (snmpConclusive) return 'INCOMPLETE';
  return 'INCOMPLETE';
}

export function mergeMplsDiscovery(input: MplsDiscoveryInput): MplsDiscoveryResult {
  const sources: MplsSource[] = [];
  if (input.snmp) sources.push('SNMP');
  if (input.ssh?.available) sources.push('SSH');

  // A CLI so prevalece quando e a leitura mais nova e trouxe estado observado.
  const preferSsh =
    input.ssh !== null &&
    (!input.snmp || input.ssh.collectedAt.getTime() >= input.snmp.collectedAt.getTime());

  const conflicts: MplsConflict[] = [];
  const sshVsis = input.ssh
    ? input.ssh.vsis.map((parsed) => sshVsiFrom(parsed, input.ssh!.l2vcs))
    : [];
  const sshByName = new Map(sshVsis.map((vsi) => [vsi.name, vsi]));
  const snmpVsis = input.snmp?.vsis ?? [];

  const merged: CollectedMplsVsi[] = [];
  for (const snmpVsi of snmpVsis) {
    const sshVsi = sshByName.get(snmpVsi.name);
    merged.push(sshVsi ? mergeVsi(snmpVsi, sshVsi, conflicts, preferSsh) : snmpVsi);
    if (sshVsi) sshByName.delete(snmpVsi.name);
  }
  for (const sshVsi of sshByName.values()) merged.push(sshVsi);

  const l2vcCircuits = input.ssh?.l2vcs.map(l2vcCircuitFrom) ?? [];
  const vsis = merged.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  const discoveryState = vsis.length
    ? stateForVsis(vsis, conflicts)
    : stateWithoutVsis(input, l2vcCircuits);

  const supported =
    vsis.length > 0 ||
    l2vcCircuits.length > 0 ||
    (discoveryState !== 'INCOMPLETE' && discoveryState !== 'UNSUPPORTED');
  const sshContributed = input.ssh?.available === true;
  const snmpErrors = input.snmp?.errors ?? [];
  const sshWarnings = input.ssh?.warnings ?? [];
  const errors = [...snmpErrors, ...sshWarnings];

  const collection: HuaweiVplsCollection = {
    supported,
    discoveryState,
    sources,
    ldpPeers: input.ssh ? input.ssh.ldpPeers : undefined,
    l2vcCircuits: input.ssh ? l2vcCircuits : undefined,
    conflicts: input.ssh ? conflicts : undefined,
    collectedAt: input.ssh?.available ? input.ssh.collectedAt : (input.snmp?.collectedAt ?? new Date()),
    errors,
    capabilities: {
      vsi: supported,
      ac: sshContributed ? true : (input.snmp?.capabilities.ac ?? false),
      pw: sshContributed ? true : (input.snmp?.capabilities.pw ?? false),
    },
    collectedColumns: {
      vsi: sshContributed ? ALL_VSI_COLUMNS : (input.snmp?.collectedColumns.vsi ?? []),
      ac: sshContributed ? ALL_AC_COLUMNS : (input.snmp?.collectedColumns.ac ?? []),
      pw: sshContributed ? ALL_PW_COLUMNS : (input.snmp?.collectedColumns.pw ?? []),
    },
    vsis,
  };

  return {
    collection,
    discoveryState,
    conflicts,
    ldpPeers: input.ssh?.ldpPeers ?? [],
    l2vcCircuits,
    sources,
  };
}

/** Rotulo humano do estado, usado em log/erro seguro (nunca em tela bruta). */
export function describeMplsDiscoveryState(state: MplsDiscoveryState): string {
  switch (state) {
    case 'FOUND_UP':
      return 'VSI encontrada UP';
    case 'FOUND_DOWN':
      return 'VSI encontrada DOWN';
    case 'FOUND_MIXED':
      return 'VSIs UP e DOWN';
    case 'FOUND_L2VC':
      return 'Circuito L2VC (VPWS) encontrado';
    case 'NOT_FOUND':
      return 'Nenhuma VSI encontrada';
    case 'INCOMPLETE':
      return 'Coleta incompleta';
    case 'UNSUPPORTED':
      return 'Descoberta não suportada';
    case 'CONFLICT':
      return 'Informações conflitantes';
    default:
      return 'Ainda não coletado';
  }
}

/** `true` quando o status agregado merece registro em histórico. */
export function isMplsStatusKnown(status: MplsStatus): boolean {
  return knownStatus(status);
}
