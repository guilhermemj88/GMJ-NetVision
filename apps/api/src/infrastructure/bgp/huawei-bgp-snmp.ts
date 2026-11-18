import type { SnmpClient, SnmpRequestOptions, SnmpVarBind } from '../../domain/ports';
import { BGP4_PEER_STATE_OID, HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID } from './bgp-oids';
import { parseBgp4PeerState } from './bgp4-peer-parser';
import { parseHuaweiBgpReceivedPrefixes } from './huawei-bgp-prefix-parser';
import type { BgpSnmpCollection, BgpSnmpCollector, CollectedBgpPeer } from './bgp-snmp-collector';

export type { CollectedBgpPeer };
/** Nome histórico mantido para os chamadores existentes. */
export type HuaweiBgpCollection = BgpSnmpCollection;

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
 * Coletor Huawei: BGP4-MIB (estado) + HUAWEI-BGP-VPN-MIB (prefixos recebidos).
 *
 * Comportamento INALTERADO: BGP4-MIB é IPv4 e o contador só aparece para peers
 * ESTABLISHED. `remoteAs`/`localAs`/uptime continuam vindo do discovery SSH —
 * a BGP4-MIB implementada no VRP não os entrega de forma confiável.
 */
export class HuaweiBgpSnmpCollector implements BgpSnmpCollector {
  constructor(private readonly client: SnmpClient) {}

  async collect(host: string, options: SnmpRequestOptions): Promise<BgpSnmpCollection> {
    const collectedAt = new Date();
    const stateRowsPromise = this.client.walk(host, BGP4_PEER_STATE_OID, options);
    const prefixRowsPromise = this.client
      .walk(host, HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID, options)
      .then((rows) => ({ rows, error: null as string | null }))
      .catch((error: unknown) => ({ rows: [] as SnmpVarBind[], error: safeError(error) }));
    const [stateRows, prefixResult] = await Promise.all([stateRowsPromise, prefixRowsPromise]);
    const prefixesByPeer = prefixCounters(prefixResult.rows);
    const peers: CollectedBgpPeer[] = stateRows.flatMap((row) => {
      const state = parseBgp4PeerState(row);
      if (!state) return [];
      return [
        {
          ...state,
          addressFamily: 'IPV4' as const,
          remoteAs: null,
          localAs: null,
          sessionUptimeSeconds: null,
          receivedPrefixes: state.established
            ? (prefixesByPeer.get(state.peerAddress) ?? null)
            : null,
          provenance: { state: 'SNMP', receivedPrefixes: 'SNMP' },
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
