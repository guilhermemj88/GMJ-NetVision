import type { BgpAdvertisedRoutesResponse } from '@gmj/shared';
import { ipAddressFamily } from '@gmj/shared';
import type { BgpRepository } from './bgp-repository';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import { parseHuaweiAdvertisedRoutes } from './huawei-bgp-advertised-routes-parser';
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
  now?: () => Date;
}

/**
 * On-demand read of the routes a device announces to one peer.
 *
 * Everything the CLI needs is resolved from the persisted peer: the request
 * carries only the peer id, so no peer address, ASN or command fragment can be
 * injected from the frontend. The read is read-only, never enters
 * `system-view`/`bgp <asn>`, is not part of any polling loop and persists
 * nothing — the operator triggers a fresh SSH collection every time.
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
}
