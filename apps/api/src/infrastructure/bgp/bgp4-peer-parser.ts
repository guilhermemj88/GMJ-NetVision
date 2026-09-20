import type { SnmpVarBind } from '../../domain/ports';
import { BGP4_PEER_STATE_OID } from './bgp-oids';

export type BgpPeerState =
  'IDLE' | 'CONNECT' | 'ACTIVE' | 'OPENSENT' | 'OPENCONFIRM' | 'ESTABLISHED' | 'UNKNOWN';

export interface BgpPeerStateReading {
  peerAddress: string;
  stateCode: number;
  state: BgpPeerState;
  established: boolean;
}

const STATE_BY_CODE: Readonly<Record<number, BgpPeerState>> = {
  1: 'IDLE',
  2: 'CONNECT',
  3: 'ACTIVE',
  4: 'OPENSENT',
  5: 'OPENCONFIRM',
  6: 'ESTABLISHED',
};

export function numericOidSuffix(oid: string, baseOid: string): number[] | null {
  const normalized = oid.replace(/^\.+|\.+$/g, '');
  const base = baseOid.replace(/^\.+|\.+$/g, '');
  if (!normalized.startsWith(`${base}.`)) return null;
  const parts = normalized
    .slice(base.length + 1)
    .split('.')
    .map(Number);
  return parts.length > 0 && parts.every((part) => Number.isInteger(part) && part >= 0)
    ? parts
    : null;
}

function nonNegativeInteger(value: SnmpVarBind['value']): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function bgpStateFromCode(stateCode: number): BgpPeerState {
  return STATE_BY_CODE[stateCode] ?? 'UNKNOWN';
}

export function parseBgp4PeerState(row: SnmpVarBind): BgpPeerStateReading | null {
  const suffix = numericOidSuffix(row.oid, BGP4_PEER_STATE_OID);
  if (!suffix || suffix.length !== 4 || suffix.some((octet) => octet > 255)) return null;
  const stateCode = nonNegativeInteger(row.value);
  if (stateCode === null) return null;
  return {
    peerAddress: suffix.join('.'),
    stateCode,
    state: bgpStateFromCode(stateCode),
    established: stateCode === 6,
  };
}
