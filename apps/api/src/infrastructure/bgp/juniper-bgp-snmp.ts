import type { SnmpClient, SnmpRequestOptions, SnmpVarBind } from '../../domain/ports';
import { bgpStateFromCode } from './bgp4-peer-parser';
import type { BgpSnmpCollection, BgpSnmpCollector, CollectedBgpPeer } from './bgp-snmp-collector';

/** BGP4-V2-MIB-JUNIPER (jnxBgpM2). Base auditada nos dois MX da Speedyway. */
export const JUNIPER_BGP_M2 = '1.3.6.1.4.1.2636.5.1.1.2';

/**
 * Peer table. Índice REAL observado (validado em Junos 19.2R1.8 e 19.4R3-S10.3):
 *   routingInstance . localAddrType . localAddr . remoteAddrType . remoteAddr
 * Os octetos do endereço entram no índice como números decimais (4 para IPv4,
 * 16 para IPv6), então o sufixo NUNCA pode ser lido como "últimos 4 números".
 */
export const JUNIPER_PEER_STATE_OID = `${JUNIPER_BGP_M2}.1.1.1.2`;
export const JUNIPER_PEER_LOCAL_AS_OID = `${JUNIPER_BGP_M2}.1.1.1.9`;
export const JUNIPER_PEER_REMOTE_ADDR_TYPE_OID = `${JUNIPER_BGP_M2}.1.1.1.10`;
export const JUNIPER_PEER_REMOTE_ADDR_OID = `${JUNIPER_BGP_M2}.1.1.1.11`;
export const JUNIPER_PEER_REMOTE_AS_OID = `${JUNIPER_BGP_M2}.1.1.1.13`;
export const JUNIPER_PEER_INDEX_OID = `${JUNIPER_BGP_M2}.1.1.1.14`;
export const JUNIPER_PEER_ROUTING_INSTANCE_OID = `${JUNIPER_BGP_M2}.1.1.1.15`;
export const JUNIPER_PEER_FSM_ESTABLISHED_TIME_OID = `${JUNIPER_BGP_M2}.4.1.1.1`;

/**
 * Prefix counters. Índice: peerIndex . afi . safi  (afi 1=IPv4, 2=IPv6; safi 1=unicast).
 * `jnxBgpM2PrefixInPrefixes` = prefixos RECEBIDOS do peer (comparado com a
 * coluna "Received" do `show bgp summary` nos dois MX).
 */
export const JUNIPER_PREFIX_IN_PREFIXES_OID = `${JUNIPER_BGP_M2}.6.2.1.7`;

export interface JuniperPeerIndex {
  routingInstance: number;
  localAddressType: number;
  localAddress: string;
  remoteAddressType: number;
  remoteAddress: string;
  /** Chave canônica da linha (sufixo do OID), usada para juntar colunas. */
  key: string;
}

const ADDRESS_BYTES: Readonly<Record<number, number>> = { 1: 4, 2: 16 };

/** Converte octetos em IPv6 textual (RFC 5952: minúsculas e maior run zerada). */
export function formatIpv6(bytes: readonly number[]): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
  }
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;
  groups.forEach((group, index) => {
    if (group === 0) {
      if (currentStart === -1) currentStart = index;
      currentLength += 1;
      if (currentLength > bestLength) {
        bestLength = currentLength;
        bestStart = currentStart;
      }
    } else {
      currentStart = -1;
      currentLength = 0;
    }
  });
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

export function addressFromBytes(type: number, bytes: readonly number[]): string | null {
  const expected = ADDRESS_BYTES[type];
  if (!expected || bytes.length !== expected) return null;
  if (expected === 4) {
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
    return bytes.join('.');
  }
  return formatIpv6(bytes);
}

/** Valor OCTET STRING do varbind em bytes. Nunca `String(buffer)` nem `Number(buffer)`. */
export function varbindBytes(value: SnmpVarBind['value']): number[] | null {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) {
    const bytes = value.map((item) => Number(item));
    return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^(?:[0-9a-fA-F]{2}[:-]){3,}[0-9a-fA-F]{2}$/.test(trimmed) || /^[0-9a-fA-F]{8,32}$/.test(trimmed)) {
      const hex = trimmed.replace(/[:-]/g, '');
      const bytes: number[] = [];
      for (let index = 0; index + 1 < hex.length; index += 2) bytes.push(parseInt(hex.slice(index, index + 2), 16));
      return bytes;
    }
  }
  return null;
}

export function numericOidSuffix(oid: string, baseOid: string): number[] | null {
  const normalized = oid.replace(/^\.+|\.+$/g, '');
  const base = baseOid.replace(/^\.+|\.+$/g, '');
  if (!normalized.startsWith(`${base}.`)) return null;
  const parts = normalized.slice(base.length + 1).split('.');
  const numbers = parts.map(Number);
  if (!parts.length || numbers.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return numbers;
}

/** Lê o índice da peer table; devolve null em sufixo malformado ou tipo desconhecido. */
export function parseJuniperPeerIndex(suffix: readonly number[] | null): JuniperPeerIndex | null {
  if (!suffix || suffix.length < 4) return null;
  const [routingInstance, localAddressType] = suffix;
  if (routingInstance === undefined || localAddressType === undefined) return null;
  const localLength = ADDRESS_BYTES[localAddressType];
  if (!localLength) return null;
  const remoteTypeIndex = 1 + 1 + localLength;
  const remoteAddressType = suffix[remoteTypeIndex];
  if (remoteAddressType === undefined) return null;
  const remoteLength = ADDRESS_BYTES[remoteAddressType];
  if (!remoteLength) return null;
  if (suffix.length !== remoteTypeIndex + 1 + remoteLength) return null;
  const localBytes = suffix.slice(2, 2 + localLength);
  const remoteBytes = suffix.slice(remoteTypeIndex + 1);
  const localAddress = addressFromBytes(localAddressType, localBytes);
  const remoteAddress = addressFromBytes(remoteAddressType, remoteBytes);
  if (!localAddress || !remoteAddress) return null;
  return {
    routingInstance,
    localAddressType,
    localAddress,
    remoteAddressType,
    remoteAddress,
    key: suffix.join('.'),
  };
}

function toInteger(value: SnmpVarBind['value']): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function toBigInt(value: SnmpVarBind['value'], maxBytes = 4): bigint | null {
  if (typeof value === 'bigint') return value;
  const direct = toInteger(value);
  if (direct !== null) return BigInt(direct);
  const bytes = varbindBytes(value);
  // ASN de 32 bits vem como OCTET STRING em algumas versões.
  if (!bytes || !bytes.length || bytes.length > maxBytes) return null;
  return bytes.reduce((total, byte) => (total << 8n) + BigInt(byte), 0n);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Falha SNMP sem detalhe').slice(0, 240);
}

type Column = Map<string, SnmpVarBind['value']>;

function indexColumn(rows: SnmpVarBind[], baseOid: string): Column {
  const column: Column = new Map();
  for (const row of rows) {
    const suffix = numericOidSuffix(row.oid, baseOid);
    if (!suffix) continue;
    column.set(suffix.join('.'), row.value);
  }
  return column;
}

/**
 * Coletor READ-ONLY da BGP4-V2-MIB-JUNIPER.
 *
 * Junta as colunas pelo índice REAL da MIB (nunca pela ordem do walk) e casa os
 * contadores de prefixo por `peerIndex` + AFI + SAFI. Falha de uma coluna
 * opcional não invalida o estado dos peers já lidos.
 */
export class JuniperBgpSnmpCollector implements BgpSnmpCollector {
  constructor(private readonly client: SnmpClient) {}

  async collect(host: string, options: SnmpRequestOptions): Promise<BgpSnmpCollection> {
    const collectedAt = new Date();
    const errors: string[] = [];
    const [stateRows, localAsResult, remoteAsResult, indexResult, uptimeResult, prefixResult] =
      await Promise.all([
        this.client.walk(host, JUNIPER_PEER_STATE_OID, options),
        this.optional(host, JUNIPER_PEER_LOCAL_AS_OID, options),
        this.optional(host, JUNIPER_PEER_REMOTE_AS_OID, options),
        this.optional(host, JUNIPER_PEER_INDEX_OID, options),
        this.optional(host, JUNIPER_PEER_FSM_ESTABLISHED_TIME_OID, options),
        this.optional(host, JUNIPER_PREFIX_IN_PREFIXES_OID, options),
      ]);

    for (const [label, result] of [
      ['localAs', localAsResult],
      ['remoteAs', remoteAsResult],
      ['peerIndex', indexResult],
      ['fsmEstablishedTime', uptimeResult],
      ['prefixInPrefixes', prefixResult],
    ] as const) {
      if (result.error) errors.push(`Falha na coluna ${label}: ${result.error}`);
    }

    const localAs = indexColumn(localAsResult.rows, JUNIPER_PEER_LOCAL_AS_OID);
    const remoteAs = indexColumn(remoteAsResult.rows, JUNIPER_PEER_REMOTE_AS_OID);
    const peerIndex = indexColumn(indexResult.rows, JUNIPER_PEER_INDEX_OID);
    const uptime = indexColumn(uptimeResult.rows, JUNIPER_PEER_FSM_ESTABLISHED_TIME_OID);
    const prefixes = this.prefixesByPeerIndex(prefixResult.rows);

    const peers: CollectedBgpPeer[] = [];
    for (const row of stateRows) {
      const suffix = numericOidSuffix(row.oid, JUNIPER_PEER_STATE_OID);
      const index = parseJuniperPeerIndex(suffix);
      if (!index) continue;
      const stateCode = toInteger(row.value);
      if (stateCode === null) continue;
      const state = bgpStateFromCode(stateCode);
      const established = stateCode === 6;
      const peerKey = index.key;
      const family = index.remoteAddressType === 2 ? 'IPV6' : 'IPV4';
      const indexValue = toInteger(peerIndex.get(peerKey) ?? '');
      const received =
        established && indexValue !== null
          ? (prefixes.get(`${indexValue}:${index.remoteAddressType === 2 ? 2 : 1}`) ?? null)
          : null;
      const uptimeSeconds = established ? toInteger(uptime.get(peerKey) ?? '') : null;
      peers.push({
        peerAddress: index.remoteAddress,
        addressFamily: family,
        stateCode,
        state,
        established,
        receivedPrefixes: received,
        remoteAs: toBigInt(remoteAs.get(peerKey) ?? ''),
        localAs: toBigInt(localAs.get(peerKey) ?? ''),
        sessionUptimeSeconds: uptimeSeconds,
        provenance: {
          peerAddress: 'SNMP',
          state: 'SNMP',
          remoteAs: 'SNMP',
          localAs: 'SNMP',
          receivedPrefixes: 'SNMP',
          sessionUptimeSeconds: 'SNMP',
        },
      });
    }
    return { collectedAt, peers, errors };
  }

  /** prefixIndex -> recebidos, com AFI explícito (1=IPv4, 2=IPv6). */
  private prefixesByPeerIndex(rows: SnmpVarBind[]): Map<string, number> {
    const counters = new Map<string, number>();
    for (const row of rows) {
      const suffix = numericOidSuffix(row.oid, JUNIPER_PREFIX_IN_PREFIXES_OID);
      // Índice real: peerIndex . afi . safi
      if (!suffix || suffix.length !== 3) continue;
      const [peerIndex, afi, safi] = suffix as [number, number, number];
      if (safi !== 1) continue;
      const value = toInteger(row.value);
      if (value === null) continue;
      counters.set(`${peerIndex}:${afi}`, value);
    }
    return counters;
  }

  private async optional(
    host: string,
    oid: string,
    options: SnmpRequestOptions,
  ): Promise<{ rows: SnmpVarBind[]; error: string | null }> {
    try {
      return { rows: await this.client.walk(host, oid, options), error: null };
    } catch (error) {
      return { rows: [], error: safeError(error) };
    }
  }
}
