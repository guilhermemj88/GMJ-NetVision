import type { BgpDashboardPeer } from '@gmj/shared';
import type { BgpDiscoveryOutcome, DiscoveredBgpPeer } from '../bgp-discovery-service';

// Descoberta de mitigacao a partir dos peers BGP JA PERSISTIDOS.
//
// O discovery BGP ao vivo faz UM SSH POR PEER para correlacionar a interface
// (o BHE-VTA-F1A-BGP-01 tem 107 peers = minutos de SSH). Para a mitigacao isso e
// desperdicio: a correlacao peer->interface ja esta gravada em BgpPeer.interfaceId
// pelo ultimo discovery. Reusando esse dado, a analise cai de minutos para poucos
// segundos e o unico SSH que sobra e o dump de configuracao (2 comandos).
//
// Quando nao existe nada persistido, quem chama cai no caminho ao vivo.
export function persistedPeersToBgpOutcome(
  peers: readonly BgpDashboardPeer[],
): BgpDiscoveryOutcome | null {
  if (peers.length === 0) return null;

  const discovered: DiscoveredBgpPeer[] = peers.map((peer) => ({
    peerAddress: peer.peerAddress,
    addressFamily: peer.addressFamily,
    remoteAs: toBigInt(peer.remoteAs),
    stateCode: peer.stateCode,
    state: peer.state,
    sessionUptimeSeconds: null,
    cliReceivedPrefixes: toBigInt(peer.receivedPrefixes),
    bgpPeerDescription: peer.displayName ?? null,
    interfaceId: peer.interface?.id ?? null,
    interfaceName: peer.interface?.name ?? null,
    interfaceAlias: peer.interface?.alias ?? null,
    interfaceDescription: peer.interface?.description ?? null,
    displayName: peer.displayName,
    correlationStatus: peer.interface?.id ? 'MATCHED' : 'NO_ROUTE',
    correlationError: null,
  }));

  const withInterface = discovered.filter((peer) => peer.correlationStatus === 'MATCHED').length;
  return {
    peers: discovered,
    localAs: null,
    localAsAmbiguous: false,
    ipv6Supported: true,
    warnings: [
      withInterface === 0
        ? 'Nenhum peer persistido tem interface correlacionada; rode o discovery BGP em BGP > SESSÕES para correlacionar.'
        : 'Correlação peer → interface reutilizada do último discovery BGP (sem novo SSH por peer).',
    ],
  };
}

function toBigInt(value: string | number | null): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
