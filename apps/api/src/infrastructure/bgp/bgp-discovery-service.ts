import type { HostRecord } from '@gmj/shared';
import type { BgpPeerState } from './bgp4-peer-parser';
import {
  correlateFromLookup,
  type BgpInterfaceCorrelationStatus,
  type BgpRouteLookup,
} from './bgp-interface-correlation';
import type { BgpSshDiscoveryProvider } from './bgp-ssh-discovery';
import type { BgpRepository } from './bgp-repository';

export interface DiscoveredBgpPeer {
  peerAddress: string;
  addressFamily: 'IPV4' | 'IPV6';
  remoteAs: bigint | null;
  /** AS local DESTA sessão. `null` quando o vendor não expõe por peer (Huawei). */
  localAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  cliReceivedPrefixes: bigint | null;
  bgpPeerDescription: string | null;
  interfaceId: string | null;
  interfaceName: string | null;
  interfaceAlias: string | null;
  interfaceDescription: string | null;
  displayName: string;
  correlationStatus: BgpInterfaceCorrelationStatus;
  correlationError: string | null;
}

export interface BgpDiscoveryOutcome {
  peers: DiscoveredBgpPeer[];
  /** Local ASN learned in this discovery, or null when it stayed unknown. */
  localAs: bigint | null;
  localAsAmbiguous: boolean;
  ipv6Supported: boolean;
  warnings: string[];
}

/**
 * Discovery BGP por SSH.
 *
 * Depende apenas de `BgpSshDiscoveryProvider`: Huawei e Juniper entregam os
 * peers e o resultado de rota JÁ interpretado pelo parser do fabricante; este
 * serviço só correlaciona (mesma regra de interface para ambos) e persiste.
 */
export class BgpDiscoveryService {
  constructor(
    private readonly provider: BgpSshDiscoveryProvider,
    private readonly repository: BgpRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async discover(device: HostRecord): Promise<BgpDiscoveryOutcome> {
    const discovery = await this.provider.discover(device);
    const discoveredAt = this.now();

    // A local ASN is only persisted when the context exposed exactly one BGP
    // process; an inconclusive or ambiguous read never erases the stored value.
    if (discovery.localAs !== null) {
      await this.repository.saveDeviceLocalAs(device.id, discovery.localAs, discoveredAt);
    }

    const peers = discovery.peers.map((peer) => {
      const lookup: BgpRouteLookup = peer.routeLookup;
      const correlation = correlateFromLookup(
        device.id,
        peer.peerAddress,
        lookup,
        device.interfaces,
        { allowLogicalUnitFallback: discovery.logicalUnitFallback },
      );
      const bgpPeerDescription = peer.bgpPeerDescription?.trim() || null;
      return {
        peerAddress: peer.peerAddress,
        addressFamily: peer.addressFamily,
        remoteAs: peer.remoteAs,
        localAs: peer.localAs,
        stateCode: peer.stateCode,
        state: peer.state,
        sessionUptimeSeconds: peer.sessionUptimeSeconds,
        cliReceivedPrefixes: peer.cliReceivedPrefixes,
        bgpPeerDescription,
        ...correlation,
        displayName: bgpPeerDescription || correlation.displayName,
      };
    });
    await this.repository.saveDiscovery(device.id, peers, discoveredAt);
    return {
      peers,
      localAs: discovery.localAs,
      localAsAmbiguous: discovery.localAsAmbiguous,
      ipv6Supported: discovery.ipv6Supported,
      warnings: discovery.warnings,
    };
  }
}
