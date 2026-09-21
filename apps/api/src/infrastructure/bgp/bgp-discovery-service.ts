import type { HostRecord } from '@gmj/shared';
import type { BgpPeerState } from './bgp4-peer-parser';
import {
  correlateBgpPeerInterface,
  type BgpInterfaceCorrelationStatus,
} from './bgp-interface-correlation';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import type { BgpRepository } from './bgp-repository';

export interface DiscoveredBgpPeer {
  peerAddress: string;
  addressFamily: 'IPV4' | 'IPV6';
  remoteAs: bigint | null;
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

export class BgpDiscoveryService {
  constructor(
    private readonly ssh: HuaweiBgpSshService,
    private readonly repository: BgpRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async discover(device: HostRecord): Promise<BgpDiscoveryOutcome> {
    const discovery = await this.ssh.discover(device);
    const discoveredAt = this.now();

    // A local ASN is only persisted when the context exposed exactly one BGP
    // process; an inconclusive or ambiguous read never erases the stored value.
    if (discovery.localAs !== null) {
      await this.repository.saveDeviceLocalAs(device.id, discovery.localAs, discoveredAt);
    }

    const peers = discovery.peers.map((peer) => {
      const routeCommand = discovery.routeCommands.get(peer.peerAddress) ?? {
        status: 'COMMAND_FAILED' as const,
        error: 'SSH command failed',
      };
      const correlation = correlateBgpPeerInterface(
        device.id,
        peer.peerAddress,
        peer.addressFamily,
        routeCommand,
        device.interfaces,
      );
      const bgpPeerDescription = peer.bgpPeerDescription?.trim() || null;
      return {
        ...peer,
        ...correlation,
        bgpPeerDescription,
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
