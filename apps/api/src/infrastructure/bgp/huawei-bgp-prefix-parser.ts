import type { SnmpVarBind } from '../../domain/ports';
import { HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID } from './bgp-oids';
import { numericOidSuffix } from './bgp4-peer-parser';

export type HuaweiBgpPrefixAddressFamily = 'IPV4_UNICAST' | 'IPV6_UNICAST' | 'UNSUPPORTED';

export interface HuaweiBgpPrefixIndex {
  addressFamily: HuaweiBgpPrefixAddressFamily;
  addressBytes: number[];
  peerAddress: string | null;
}

export interface HuaweiBgpReceivedPrefixesReading {
  peerAddress: string;
  receivedPrefixes: number;
}

const IPV4_UNICAST_HEADER = [0, 1, 1, 1] as const;
const IPV6_UNICAST_HEADER = [0, 2, 1, 2] as const;
const COUNTER32_MAX = 0xffff_ffff;

function hasHeader(values: readonly number[], header: readonly number[]): boolean {
  return header.every((part, index) => values[index] === part);
}

function counter32(value: SnmpVarBind['value']): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= COUNTER32_MAX ? parsed : null;
}

/**
 * Decodes the validated Huawei index without assuming that the last four OID
 * components are always an IPv4 address. IPv6 is recognized for future support
 * but is deliberately not converted into a peer reading in the MVP.
 */
export function parseHuaweiBgpPrefixIndex(suffix: readonly number[]): HuaweiBgpPrefixIndex | null {
  if (suffix.length < 5 || suffix.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }
  const addressLength = suffix[4];
  if (addressLength === undefined || suffix.length !== 5 + addressLength) return null;
  const addressBytes = suffix.slice(5);
  if (addressBytes.some((octet) => octet > 255)) return null;

  if (addressLength === 4 && hasHeader(suffix, IPV4_UNICAST_HEADER)) {
    return {
      addressFamily: 'IPV4_UNICAST',
      addressBytes,
      peerAddress: addressBytes.join('.'),
    };
  }
  if (addressLength === 16 && hasHeader(suffix, IPV6_UNICAST_HEADER)) {
    return { addressFamily: 'IPV6_UNICAST', addressBytes, peerAddress: null };
  }
  return { addressFamily: 'UNSUPPORTED', addressBytes, peerAddress: null };
}

export function parseHuaweiBgpReceivedPrefixes(
  row: SnmpVarBind,
): HuaweiBgpReceivedPrefixesReading | null {
  const suffix = numericOidSuffix(row.oid, HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID);
  if (!suffix) return null;
  const index = parseHuaweiBgpPrefixIndex(suffix);
  if (!index || index.addressFamily !== 'IPV4_UNICAST' || !index.peerAddress) return null;
  const receivedPrefixes = counter32(row.value);
  return receivedPrefixes === null ? null : { peerAddress: index.peerAddress, receivedPrefixes };
}
