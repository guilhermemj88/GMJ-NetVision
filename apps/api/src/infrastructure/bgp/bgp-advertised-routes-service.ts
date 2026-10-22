import type { BgpAdvertisedRoutesResponse, HostRecord } from '@gmj/shared';
import { ipAddressFamily } from '@gmj/shared';
import type { BgpRepository } from './bgp-repository';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import { parseHuaweiAdvertisedRoutes } from './huawei-bgp-advertised-routes-parser';
import type { JuniperJunosBgpSshProvider } from './juniper-junos-bgp-ssh';
import { bgpCapabilitiesFor } from './bgp-vendor';
import type { HostRepository } from '../persistence/host-repository';

export class BgpAdvertisedRoutesError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'BgpAdvertisedRoutesError';
  }
}

export interface BgpAdvertisedRoutesDependencies {
  bgp: BgpRepository;
  hosts: HostRepository;
  ssh: HuaweiBgpSshService;
  /** Provider Junos (somente leitura). Ausente = Juniper não suportado. */
  juniper?: JuniperJunosBgpSshProvider;
  now?: () => Date;
}

/**
 * Leitura sob demanda das rotas anunciadas a UM peer.
 *
 * Tudo o que o CLI precisa vem do peer persistido: a requisição carrega só o
 * id, então não há endereço/ASN/fragmento de comando vindo do frontend.
 *
 * - Huawei: `display bgp routing-table peer <PEER> advertised-routes`
 *   (AS local do processo, como antes).
 * - Juniper: `show route advertising-protocol bgp <PEER> | no-more`
 *   (SOMENTE LEITURA) usando o **AS local do peer** — um MX usa local-as
 *   diferente por grupo.
 *
 * Nada é persistido e o comando nunca entra em polling.
 */
export class BgpAdvertisedRoutesService {
  constructor(private readonly dependencies: BgpAdvertisedRoutesDependencies) {}

  async execute(peerId: string): Promise<BgpAdvertisedRoutesResponse> {
    const now = this.dependencies.now ?? (() => new Date());
    const peer = await this.dependencies.bgp.getPeerDetail(peerId);
    if (!peer) throw new BgpAdvertisedRoutesError('Peer BGP não encontrado', 404);

    const host = await this.dependencies.hosts.getHost(peer.deviceId);
    if (!host) throw new BgpAdvertisedRoutesError('Equipamento não encontrado', 404);

    // The stored address must be valid for the stored family; the request never
    // carries an address, so this also blocks corrupted rows.
    const family = ipAddressFamily(peer.peerAddress);
    if (family === null || family !== peer.addressFamily) {
      throw new BgpAdvertisedRoutesError(
        'Endereço do peer é inválido para a família persistida; execute o discovery novamente.',
        409,
      );
    }
    const capabilities = bgpCapabilitiesFor(host.vendor, host.model);
    // Plataforma não homologada mantém o caminho LEGADO (Huawei) — é o
    // comportamento já publicado e o mesmo critério usado no discovery/SNMP.
    if (capabilities.platform === 'JUNIPER_JUNOS') {
      return this.executeJuniper(peer, host, now);
    }
    if (!host.sshEnabled || !host.ssh?.host || !host.ssh.username) {
      throw new BgpAdvertisedRoutesError('SSH não está habilitado para este equipamento', 409);
    }

    const localAs = await this.dependencies.bgp.getDeviceLocalAs(host.id);
    if (localAs === null) {
      throw new BgpAdvertisedRoutesError(
        'ASN local do processo BGP ainda não foi identificado. Execute "Atualizar agora" para fazer o discovery SSH.',
        409,
      );
    }

    const reading = await this.dependencies.ssh.readAdvertisedRoutes(host, {
      peerAddress: peer.peerAddress,
      addressFamily: peer.addressFamily,
    });
    if (reading.status !== 'SUCCESS') {
      if (reading.status === 'UNSUPPORTED') {
        throw new BgpAdvertisedRoutesError(
          `Consulta de anúncios não suportada para sessões ${peer.addressFamily === 'IPV6' ? 'IPv6' : 'IPv4'} neste equipamento (${reading.errorSafe})`,
          409,
        );
      }
      throw new BgpAdvertisedRoutesError(reading.errorSafe, 502);
    }

    const parsed = parseHuaweiAdvertisedRoutes(reading.output, {
      localAs,
      addressFamily: peer.addressFamily,
    });

    return {
      peerId: peer.id,
      deviceId: peer.deviceId,
      peerAddress: peer.peerAddress,
      addressFamily: peer.addressFamily,
      localAs: localAs.toString(),
      fetchedAt: now().toISOString(),
      routes: parsed.routes,
      reportedTotal: parsed.reportedTotal,
      warnings: parsed.warnings,
    };
  }

  private async executeJuniper(
    peer: Awaited<ReturnType<BgpRepository['getPeerDetail']>>,
    host: HostRecord,
    now: () => Date,
  ): Promise<BgpAdvertisedRoutesResponse> {
    const provider = this.dependencies.juniper;
    if (!provider || !peer) {
      throw new BgpAdvertisedRoutesError(
        'Provider Junos indisponível para consulta de anúncios',
        409,
      );
    }
    const peerLocalAs = peer.localAs === null ? null : BigInt(peer.localAs);
    if (peerLocalAs === null) {
      throw new BgpAdvertisedRoutesError(
        'AS local deste peer ainda não foi coletado. Execute "Atualizar agora" (SNMP BGP4-V2 ou configuração Junos).',
        409,
      );
    }
    let reading;
    try {
      reading = await provider.readAdvertisedRoutes(host, peer.peerAddress, peerLocalAs);
    } catch (error) {
      throw new BgpAdvertisedRoutesError(
        error instanceof Error ? error.message : 'Falha ao consultar anúncios no equipamento',
        502,
      );
    }
    return {
      peerId: peer.id,
      deviceId: peer.deviceId,
      peerAddress: peer.peerAddress,
      addressFamily: peer.addressFamily,
      localAs: peerLocalAs.toString(),
      fetchedAt: now().toISOString(),
      routes: reading.routes,
      reportedTotal: reading.reportedTotal,
      warnings: reading.warnings,
    };
  }
}
