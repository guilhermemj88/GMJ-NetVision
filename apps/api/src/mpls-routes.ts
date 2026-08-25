import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HostRepository } from './infrastructure/persistence/host-repository';
import type { MplsRepository } from './infrastructure/mpls/mpls-repository';

const hostParams = z.object({ hostId: z.string().min(1) });
const vsiParams = z.object({ hostId: z.string().min(1), vsiId: z.string().min(1) });

export function registerMplsRoutes(
  app: FastifyInstance,
  dependencies: { hosts: HostRepository; mpls: MplsRepository },
): void {
  const { hosts, mpls } = dependencies;

  app.get('/api/hosts/:hostId/mpls', async (request, reply) => {
    const { hostId } = hostParams.parse(request.params);
    if (!(await hosts.getHost(hostId))) return reply.code(404).send({ message: 'Host not found' });
    return mpls.getHostOverview(hostId);
  });

  app.get('/api/hosts/:hostId/mpls/vsis', async (request, reply) => {
    const { hostId } = hostParams.parse(request.params);
    if (!(await hosts.getHost(hostId))) return reply.code(404).send({ message: 'Host not found' });
    return mpls.listVsis(hostId);
  });

  app.get('/api/hosts/:hostId/mpls/vsis/:vsiId/pws', async (request, reply) => {
    const { hostId, vsiId } = vsiParams.parse(request.params);
    if (!(await hosts.getHost(hostId))) return reply.code(404).send({ message: 'Host not found' });
    const pws = await mpls.listPws(hostId, vsiId);
    return pws ?? reply.code(404).send({ message: 'VSI not found' });
  });

  app.get('/api/hosts/:hostId/mpls/events', async (request, reply) => {
    const { hostId } = hostParams.parse(request.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    if (!(await hosts.getHost(hostId))) return reply.code(404).send({ message: 'Host not found' });
    return mpls.listEvents(hostId, limit);
  });
}
