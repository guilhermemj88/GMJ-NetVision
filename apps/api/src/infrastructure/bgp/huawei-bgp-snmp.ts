import type { SnmpClient, SnmpRequestOptions, SnmpVarBind } from '../../domain/ports';
import { BGP4_PEER_STATE_OID, HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID } from './bgp-oids';
import { parseBgp4PeerState, type BgpPeerStateReading } from './bgp4-peer-parser';
import { parseHuaweiBgpReceivedPrefixes } from './huawei-bgp-prefix-parser';

export interface CollectedBgpPeer extends BgpPeerStateReading {
  receivedPrefixes: number | null;
}

export interface HuaweiBgpCollection {
  collectedAt: Date;
  peers: CollectedBgpPeer[];
  errors: string[];
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Falha SNMP sem detalhe').slice(0, 240);
}

function prefixCounters(rows: SnmpVarBind[]): Map<string, number> {
  const counters = new Map<string, number>();
  for (const row of rows) {
    const reading = parseHuaweiBgpReceivedPrefixes(row);
    if (reading) counters.set(reading.peerAddress, reading.receivedPrefixes);
  }
  return counters;
}

/**
 * Collects peer state and Huawei prefix counters as two table walks. BGP4-MIB
 * state is authoritative; a Huawei counter is exposed only for ESTABLISHED
 * peers. Failure of the optional Huawei walk does not discard valid states.
 */
export class HuaweiBgpSnmpCollector {
  constructor(private readonly client: SnmpClient) {}

  async collect(host: string, options: SnmpRequestOptions): Promise<HuaweiBgpCollection> {
    const collectedAt = new Date();
    const stateRowsPromise = this.client.walk(host, BGP4_PEER_STATE_OID, options);
    const prefixRowsPromise = this.client
      .walk(host, HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID, options)
      .then((rows) => ({ rows, error: null as string | null }))
      .catch((error: unknown) => ({ rows: [] as SnmpVarBind[], error: safeError(error) }));
    const [stateRows, prefixResult] = await Promise.all([stateRowsPromise, prefixRowsPromise]);
    const prefixesByPeer = prefixCounters(prefixResult.rows);
    const peers = stateRows.flatMap((row) => {
      const state = parseBgp4PeerState(row);
      if (!state) return [];
      return [
        {
          ...state,
          receivedPrefixes: state.established
            ? (prefixesByPeer.get(state.peerAddress) ?? null)
            : null,
        },
      ];
    });
    return {
      collectedAt,
      peers,
      errors: prefixResult.error
        ? [`Falha na coleta Huawei de prefixes: ${prefixResult.error}`]
        : [],
    };
  }
}
