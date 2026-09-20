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
  remoteAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  cliReceivedPrefixes: bigint | null;
  interfaceId: string | null;
  interfaceName: string | null;
  interfaceAlias: string | null;
  interfaceDescription: string | null;
  displayName: string;
  correlationStatus: BgpInterfaceCorrelationStatus;
  correlationError: string | null;
}

export class BgpDiscoveryService {
  constructor(
    private readonly ssh: HuaweiBgpSshService,
    private readonly repository: BgpRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async discover(device: HostRecord): Promise<DiscoveredBgpPeer[]> {
    const discovery = await this.ssh.discover(device);
    const peers = discovery.peers.map((peer) => {
      const routeCommand = discovery.routeCommands.get(peer.peerAddress) ?? {
        status: 'COMMAND_FAILED' as const,
        error: 'SSH command failed',
      };
      const correlation = correlateBgpPeerInterface(
        device.id,
        peer.peerAddress,
        routeCommand,
        device.interfaces,
      );
      return { ...peer, ...correlation };
    });
    await this.repository.saveDiscovery(device.id, peers, this.now());
    return peers;
  }
}
