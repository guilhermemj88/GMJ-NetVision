import type { BgpAddressFamily, HostRecord } from '@gmj/shared';
import type { BgpPeerState } from './bgp4-peer-parser';
import type { BgpRouteLookup } from './bgp-interface-correlation';

/**
 * Leitura de discovery BGP por SSH, independente de fabricante.
 *
 * Cada peer carrega o resultado JÁ interpretado da rota para o endereço
 * remoto, porque o comando e o formato variam por vendor (Huawei
 * `display ip routing-table`, Junos `show route`) enquanto o correlator é o
 * mesmo.
 */
export interface BgpSshPeerReading {
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  remoteAs: bigint | null;
  /** AS local DESTA sessão quando o equipamento permite saber (Juniper). */
  localAs: bigint | null;
  stateCode: number | null;
  state: BgpPeerState | null;
  sessionUptimeSeconds: number | null;
  cliReceivedPrefixes: bigint | null;
  bgpPeerDescription: string | null;
  routeLookup: BgpRouteLookup;
}

export interface BgpSshDiscoveryReading {
  peers: BgpSshPeerReading[];
  /** AS local do processo/contexto, quando existe um valor único. */
  localAs: bigint | null;
  localAsAmbiguous: boolean;
  ipv6Supported: boolean;
  /** Habilita o fallback de unidade lógica (`ae0.2800` → `ae0`) no correlator. */
  logicalUnitFallback: boolean;
  warnings: string[];
}

export interface BgpSshDiscoveryProvider {
  discover(device: HostRecord): Promise<BgpSshDiscoveryReading>;
}
