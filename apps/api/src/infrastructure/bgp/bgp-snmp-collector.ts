import type { BgpAddressFamily } from '@gmj/shared';
import type { SnmpRequestOptions } from '../../domain/ports';
import type { BgpPeerState } from './bgp4-peer-parser';

/**
 * Resultado de UMA sessão BGP observada por SNMP, independente de fabricante.
 *
 * Campos opcionais existem porque nem toda MIB entrega tudo: a BGP4-MIB
 * tradicional (Huawei) só tem estado; a BGP4-V2-MIB-JUNIPER entrega também
 * remoteAs, localAs por peer, uptime e contadores por família.
 *
 * `null` significa SEMPRE "não observado" — nunca zero. Zero só quando o
 * equipamento devolveu zero.
 */
export interface CollectedBgpPeer {
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  stateCode: number;
  state: BgpPeerState;
  established: boolean;
  receivedPrefixes: number | null;
  remoteAs?: bigint | null;
  localAs?: bigint | null;
  sessionUptimeSeconds?: number | null;
  /** Origem de cada campo quando o coletor mistura fontes (auditoria). */
  provenance?: Readonly<Record<string, 'SNMP' | 'SSH'>>;
}

export interface BgpSnmpCollection {
  collectedAt: Date;
  peers: CollectedBgpPeer[];
  errors: string[];
}

/** Porta de coleta periódica: a aplicação escolhe a implementação pelo vendor. */
export interface BgpSnmpCollector {
  collect(host: string, options: SnmpRequestOptions): Promise<BgpSnmpCollection>;
}
