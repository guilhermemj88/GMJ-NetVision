import type { HostRecord } from '@gmj/shared';
import type { BgpPeerState } from './bgp4-peer-parser';
import {
  correlateFromLookup,
  type BgpInterfaceCorrelationStatus,
  type BgpRouteLookup,
} from './bgp-interface-correlation';
import type { BgpSshDiscoveryProvider, BgpPeerConfigurationReading } from './bgp-ssh-discovery';
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

    // Só há o que enriquecer quando o resumo trouxe peers, e a leitura extra
    // nunca derruba o discovery: sem configuração os campos ficam como vieram.
    const peerConfiguration = discovery.peers.length
      ? await this.readPeerConfiguration(device)
      : null;

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
      // O resumo do VRP não tem descrição e nem sempre traz o AS confiável; a
      // configuração corrente completa os dois campos sem sobrescrever o que o
      // equipamento já expôs no comando por peer.
      const configured = peerConfiguration?.get(peer.peerAddress.toLowerCase());
      const configuredAs = configured?.remoteAs == null ? null : BigInt(configured.remoteAs);
      const bgpPeerDescription =
        peer.bgpPeerDescription?.trim() || configured?.description?.trim() || null;
      return {
        peerAddress: peer.peerAddress,
        addressFamily: peer.addressFamily,
        remoteAs: peer.remoteAs ?? configuredAs,
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

  /**
   * Leitura opcional da configuração por peer. Fabricante que não a implementa
   * (Junos) e falha de SSH devolvem `null`: o discovery segue com o resumo.
   */
  private async readPeerConfiguration(
    device: HostRecord,
  ): Promise<Map<string, BgpPeerConfigurationReading> | null> {
    if (!this.provider.readPeerConfiguration) return null;
    try {
      return await this.provider.readPeerConfiguration(device);
    } catch {
      return null;
    }
  }
}
