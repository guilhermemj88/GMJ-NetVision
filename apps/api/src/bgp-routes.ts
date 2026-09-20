import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  BgpDashboardDevice,
  BgpDashboardPeer,
  BgpDashboardResponse,
  BgpDashboardSummary,
  BgpHistoryPeriod,
} from '@gmj/shared';
import type { BgpRepository } from './infrastructure/bgp/bgp-repository';
import type { BgpDiscoveryService } from './infrastructure/bgp/bgp-discovery-service';
import type { HostRepository } from './infrastructure/persistence/host-repository';

export function summarizeBgpPeers(peers: BgpDashboardPeer[]): BgpDashboardSummary {
  const established = peers.filter((peer) => peer.established).length;
  const down = peers.length - established;
  const receivedPrefixes = peers
    .filter((peer) => peer.established && peer.receivedPrefixes !== null)
    .reduce((sum, peer) => sum + (peer.receivedPrefixes ?? 0), 0);
  return { peers: peers.length, established, down, receivedPrefixes };
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
  q: z.string().trim().max(160).optional(),
  deviceId: z.string().min(1).optional(),
});

const peerParams = z.object({ peerId: z.string().min(1) });
const hostParams = z.object({ hostId: z.string().min(1) });

export interface BgpRouteDependencies {
  bgp: BgpRepository;
  hosts?: HostRepository;
  discovery?: BgpDiscoveryService;
}

export function registerBgpRoutes(
  app: FastifyInstance,
  dependencies: BgpRouteDependencies,
): void {
  const { bgp, hosts, discovery } = dependencies;

  app.get('/api/bgp', async (request) => {
    const query = bgpQuerySchema.parse(request.query);
    const peers = await bgp.listDashboardPeers({
      scope: query.scope,
      state: query.state,
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

  if (hosts && discovery) {
    app.post('/api/hosts/:hostId/bgp/discover', async (request, reply) => {
      const { hostId } = hostParams.parse(request.params);
      const host = await hosts.getHost(hostId);
      if (!host) return reply.code(404).send({ message: 'Host not found' });
      if (!host.sshEnabled) {
        return reply.code(409).send({ message: 'SSH não está habilitado para este host' });
      }
      try {
        const peers = await discovery.discover(host);
        const matched = peers.filter((peer) => peer.correlationStatus === 'MATCHED').length;
        return {
          hostId,
          peersDiscovered: peers.length,
          matchedInterfaces: matched,
          unmatchedInterfaces: peers.length - matched,
          peers: peers.map((peer) => ({
            peerAddress: peer.peerAddress,
            remoteAs: peer.remoteAs === null ? null : peer.remoteAs.toString(),
            stateCode: peer.stateCode,
            state: peer.state,
            sessionUptimeSeconds: peer.sessionUptimeSeconds,
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
