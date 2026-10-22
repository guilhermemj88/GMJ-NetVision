import type { HostRecord } from '@gmj/shared';
import { parseHuaweiRouteLookup } from './huawei-bgp-ssh-parser';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import type { BgpRouteLookup } from './bgp-interface-correlation';
import type { BgpSshDiscoveryProvider, BgpSshDiscoveryReading } from './bgp-ssh-discovery';

/**
 * Adapter Huawei: mantém INTACTA a semântica existente do
 * `HuaweiBgpSshService` (mesmos comandos, mesmo parser, mesmo route lookup) e
 * apenas converte o resultado para o contrato vendor-neutral.
 *
 * `localAs` por peer continua `null`: o VRP expõe um único AS por contexto, que
 * segue persistido em `Device.bgpLocalAs` (`saveDeviceLocalAs`).
 */
export class HuaweiBgpDiscoveryProvider implements BgpSshDiscoveryProvider {
  constructor(private readonly ssh: HuaweiBgpSshService) {}

  async discover(device: HostRecord): Promise<BgpSshDiscoveryReading> {
    const discovery = await this.ssh.discover(device);
    return {
      peers: discovery.peers.map((peer) => {
        const command = discovery.routeCommands.get(peer.peerAddress);
        const routeLookup: BgpRouteLookup =
          command?.status === 'SUCCESS'
            ? {
                status: 'SUCCESS',
                lookup: parseHuaweiRouteLookup(command.output, peer.addressFamily),
              }
            : {
                status: 'COMMAND_FAILED',
                error:
                  command?.status === 'COMMAND_FAILED'
                    ? command.error
                    : 'Rota do peer não consultada',
              };
        return {
          peerAddress: peer.peerAddress,
          addressFamily: peer.addressFamily,
          remoteAs: peer.remoteAs,
          localAs: null,
          stateCode: peer.stateCode,
          state: peer.state,
          sessionUptimeSeconds: peer.sessionUptimeSeconds,
          cliReceivedPrefixes: peer.cliReceivedPrefixes,
          bgpPeerDescription: peer.bgpPeerDescription?.trim() || null,
          routeLookup,
        };
      }),
      localAs: discovery.localAs,
      localAsAmbiguous: discovery.localAsAmbiguous,
      ipv6Supported: discovery.ipv6Supported,
      // Huawei nunca teve (nem passa a ter) fallback de unidade lógica.
      logicalUnitFallback: false,
      warnings: discovery.warnings,
    };
  }
}
