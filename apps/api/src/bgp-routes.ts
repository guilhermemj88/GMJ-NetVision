import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AuthUser,
  BgpAdminAction,
  BgpAddressFamily,
  BgpDashboardDevice,
  BgpDashboardPeer,
  BgpDashboardResponse,
  BgpDashboardSummary,
  BgpHistoryPeriod,
} from '@gmj/shared';
import type { BgpRepository } from './infrastructure/bgp/bgp-repository';
import type { BgpDiscoveryService } from './infrastructure/bgp/bgp-discovery-service';
import type { BgpAdminService } from './infrastructure/bgp/bgp-admin-service';
import { BgpAdminActionError } from './infrastructure/bgp/bgp-admin-service';
import type { BgpAdvertisedRoutesService } from './infrastructure/bgp/bgp-advertised-routes-service';
import { BgpAdvertisedRoutesError } from './infrastructure/bgp/bgp-advertised-routes-service';
import type { HostRepository } from './infrastructure/persistence/host-repository';

export function summarizeBgpPeers(peers: BgpDashboardPeer[]): BgpDashboardSummary {
  const established = peers.filter((peer) => peer.established).length;
  const down = peers.length - established;
  const receivedPrefixes = peers
    .filter((peer) => peer.established && peer.receivedPrefixes !== null)
    .reduce((sum, peer) => sum + (peer.receivedPrefixes ?? 0), 0);
  const byFamily: Record<BgpAddressFamily, number> = { IPV4: 0, IPV6: 0 };
  for (const peer of peers) byFamily[peer.addressFamily] += 1;
  return { peers: peers.length, established, down, receivedPrefixes, byFamily };
}

export function groupBgpPeers(peers: BgpDashboardPeer[]): BgpDashboardDevice[] {
  const devices: BgpDashboardDevice[] = [];
  const byDevice = new Map<string, BgpDashboardDevice>();
  for (const peer of peers) {
    const existing = byDevice.get(peer.deviceId);
    if (existing) {
      existing.peers.push(peer);
      continue;
    }
    const device: BgpDashboardDevice = {
      id: peer.deviceId,
      hostname: peer.deviceHostname,
      displayName: peer.deviceDisplayName,
      bgpMonitoringEnabled: peer.bgpMonitoringEnabled,
      peers: [peer],
    };
    byDevice.set(peer.deviceId, device);
    devices.push(device);
  }
  return devices;
}

export function buildBgpDashboard(peers: BgpDashboardPeer[]): BgpDashboardResponse {
  return { summary: summarizeBgpPeers(peers), devices: groupBgpPeers(peers) };
}

const bgpQuerySchema = z.object({
  scope: z.enum(['monitored', 'all']).default('monitored'),
  state: z.enum(['all', 'up', 'down']).default('all'),
  family: z.enum(['all', 'IPV4', 'IPV6']).default('all'),
  q: z.string().trim().max(160).optional(),
  deviceId: z.string().min(1).optional(),
});

const peerParams = z.object({ peerId: z.string().min(1) });
const hostParams = z.object({ hostId: z.string().min(1) });
/** The frontend sends only the action: no CLI, address, ASN or SSH context. */
const adminStateSchema = z.object({ action: z.enum(['DISABLE', 'ENABLE']) }).strict();
/**
 * The advertised-routes collection carries no payload at all: the peer address
 * and the family are resolved from the persisted peer. A strict empty object
 * rejects any attempt to smuggle a peer address or CLI fragment in the body.
 */
const emptyBodySchema = z.object({}).strict();

export interface BgpRouteDependencies {
  bgp: BgpRepository;
  hosts?: HostRepository;
  discovery?: BgpDiscoveryService;
  admin?: BgpAdminService;
  advertisedRoutes?: BgpAdvertisedRoutesService;
  /**
   * Resolves the authenticated operator. The administrative endpoint demands an
   * ADMIN session even when the global auth hook does not cover this plugin.
   */
  currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
}

export function registerBgpRoutes(
  app: FastifyInstance,
  dependencies: BgpRouteDependencies,
): void {
  const { bgp, hosts, discovery, admin, advertisedRoutes, currentUser } = dependencies;

  app.get('/api/bgp', async (request) => {
    const query = bgpQuerySchema.parse(request.query);
    const peers = await bgp.listDashboardPeers({
      scope: query.scope,
      state: query.state,
      family: query.family,
      ...(query.q ? { q: query.q } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    });
    return buildBgpDashboard(peers);
  });

  app.get('/api/bgp/peers/:peerId', async (request, reply) => {
    const { peerId } = peerParams.parse(request.params);
    const peer = await bgp.getPeerDetail(peerId);
    return peer ?? reply.code(404).send({ message: 'BGP peer not found' });
  });

  app.get('/api/bgp/peers/:peerId/history', async (request, reply) => {
    const { peerId } = peerParams.parse(request.params);
    const { period } = z
      .object({ period: z.enum(['1h', '6h', '24h', '7d']).default('1h') })
      .parse(request.query);
    const history = await bgp.getPeerHistory(peerId, period as BgpHistoryPeriod);
    return history ?? reply.code(404).send({ message: 'BGP peer not found' });
  });

  app.get('/api/bgp/alerts', async (request) => {
    const { hours, scope } = z
      .object({
        hours: z.coerce.number().int().min(1).max(168).default(48),
        scope: z.enum(['monitored', 'all']).default('monitored'),
      })
      .parse(request.query);
    return bgp.listAlerts(scope, hours);
  });

  if (admin) {
    app.post('/api/bgp/peers/:peerId/admin-state', async (request, reply) => {
      const { peerId } = peerParams.parse(request.params);
      const { action } = adminStateSchema.parse(request.body);
      const user = (await currentUser?.(request)) ?? null;
      if (!user) return reply.code(401).send({ message: 'Não autenticado' });
      if (user.role !== 'ADMIN') {
        return reply
          .code(403)
          .send({ message: 'Apenas administradores podem executar esta ação' });
      }
      try {
        return await admin.execute({ peerId, action: action as BgpAdminAction, user });
      } catch (error) {
        if (error instanceof BgpAdminActionError) {
          return reply.code(error.statusCode).send({ message: error.message });
        }
        return reply.code(502).send({
          message: error instanceof Error ? error.message : 'Falha na ação administrativa',
        });
      }
    });
  }

  /**
   * On-demand advertised-routes collection. Read-only, so it is available to
   * any authenticated operator who can already see BGP — unlike the
   * administrative enable/disable action, which stays ADMIN-only.
   */
  if (advertisedRoutes) {
    app.post('/api/bgp/peers/:peerId/advertised-routes', async (request, reply) => {
      const { peerId } = peerParams.parse(request.params);
      const user = (await currentUser?.(request)) ?? null;
      if (!user) return reply.code(401).send({ message: 'Não autenticado' });
      try {
        emptyBodySchema.parse(request.body ?? {});
      } catch (error) {
        const detail =
          error instanceof z.ZodError
            ? 'A coleta de anúncios não aceita corpo: o peer é resolvido pelo peerId persistido.'
            : 'Corpo da requisição inválido.';
        return reply.code(400).send({ message: detail });
      }
      try {
        return await advertisedRoutes.execute(peerId);
      } catch (error) {
        if (error instanceof BgpAdvertisedRoutesError) {
          return reply.code(error.statusCode).send({ message: error.message });
        }
        return reply.code(502).send({
          message: error instanceof Error ? error.message : 'Falha ao consultar os anúncios do peer',
        });
      }
    });
  }

  if (hosts && discovery) {
    app.post('/api/hosts/:hostId/bgp/discover', async (request, reply) => {
      const { hostId } = hostParams.parse(request.params);
      const host = await hosts.getHost(hostId);
      if (!host) return reply.code(404).send({ message: 'Host not found' });
      if (!host.sshEnabled) {
        return reply.code(409).send({ message: 'SSH não está habilitado para este host' });
      }
      try {
        const outcome = await discovery.discover(host);
        const matched = outcome.peers.filter((peer) => peer.correlationStatus === 'MATCHED').length;
        return {
          hostId,
          peersDiscovered: outcome.peers.length,
          ipv4Peers: outcome.peers.filter((peer) => peer.addressFamily === 'IPV4').length,
          ipv6Peers: outcome.peers.filter((peer) => peer.addressFamily === 'IPV6').length,
          matchedInterfaces: matched,
          unmatchedInterfaces: outcome.peers.length - matched,
          localAs: outcome.localAs === null ? null : outcome.localAs.toString(),
          localAsAmbiguous: outcome.localAsAmbiguous,
          ipv6Supported: outcome.ipv6Supported,
          warnings: outcome.warnings,
          peers: outcome.peers.map((peer) => ({
            peerAddress: peer.peerAddress,
            addressFamily: peer.addressFamily,
            remoteAs: peer.remoteAs === null ? null : peer.remoteAs.toString(),
            stateCode: peer.stateCode,
            state: peer.state,
            sessionUptimeSeconds: peer.sessionUptimeSeconds,
            bgpPeerDescription: peer.bgpPeerDescription,
            interfaceId: peer.interfaceId,
            interfaceName: peer.interfaceName,
            displayName: peer.displayName,
            correlationStatus: peer.correlationStatus,
          })),
        };
      } catch (error) {
        return reply
          .code(502)
          .send({ message: error instanceof Error ? error.message : 'Falha no discovery BGP' });
      }
    });
  }
}
