import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser, HostRecord } from '@gmj/shared';
import { isHuaweiVrpDevice } from './infrastructure/bgp/bgp-vendor';
import type { AutoAllProtection } from './infrastructure/platform/auto-all-protection';
import type { HostRepository } from './infrastructure/persistence/host-repository';
import type { MplsRepository } from './infrastructure/mpls/mpls-repository';
import { vsiDiagnosticEnabled, vsiDiagnosticTrustState } from './vsi-diagnostic-routes';

const hostParams = z.object({ hostId: z.string().min(1) });
const vsiParams = z.object({ hostId: z.string().min(1), vsiId: z.string().min(1) });
const sshFallbackBody = z.object({ enabled: z.boolean() });

export function registerMplsRoutes(
  app: FastifyInstance,
  dependencies: {
    hosts: HostRepository;
    mpls: MplsRepository;
    currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
    /**
     * A1-e: informa se o equipamento é protegido pelo AUTO-ALL (inclui F1A).
     * Habilitar o fallback CLI nesses equipamentos exige política explícita e
     * aprovação; a rota responde 409 e não altera nada.
     */
    autoAllProtection?: (host: HostRecord) => Promise<AutoAllProtection>;
  },
): void {
  const { hosts, mpls, currentUser, autoAllProtection } = dependencies;

  app.get('/api/hosts/:hostId/mpls', async (request, reply) => {
    const { hostId } = hostParams.parse(request.params);
    if (!(await hosts.getHost(hostId))) return reply.code(404).send({ message: 'Host not found' });
    const overview = await mpls.getHostOverview(hostId);
    return {
      ...overview,
      diagnosticEnabled: vsiDiagnosticEnabled(),
      diagnosticTrust: await vsiDiagnosticTrustState(),
    };
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

  /**
   * P6 (2a auditoria): caminho ADMINISTRATIVO para o opt-in do fallback CLI,
   * sem UPDATE manual no banco. Default continua `false`; habilitar exige
   * plataforma Huawei VRP comprovada (fail-closed).
   */
  app.get('/api/hosts/:hostId/mpls/ssh-fallback', async (request, reply) => {
    const { hostId } = hostParams.parse(request.params);
    const host = await hosts.getHost(hostId);
    if (!host) return reply.code(404).send({ message: 'Host not found' });
    const protection = await autoAllProtection?.(host);
    return {
      hostId,
      sshFallbackEnabled: (await mpls.isSshFallbackEnabled?.(hostId)) === true,
      configurable: typeof mpls.setSshFallbackEnabled === 'function',
      autoAllProtected: protection?.protected === true,
      protectionBy: protection?.protected ? protection.by : null,
    };
  });

  app.put('/api/hosts/:hostId/mpls/ssh-fallback', async (request, reply) => {
    const user = (await currentUser?.(request)) ?? null;
    if (!user) return reply.code(401).send({ message: 'Não autenticado' });
    const { hostId } = hostParams.parse(request.params);
    const body = sshFallbackBody.parse(request.body);
    const host = await hosts.getHost(hostId);
    if (!host) return reply.code(404).send({ message: 'Host not found' });

    // A1-e: toda tentativa identificada vira trilha (autorizada ou negada).
    const previousValue = (await mpls.isSshFallbackEnabled?.(hostId)) === true;
    const audit = (result: string, reason?: string): Promise<void> =>
      mpls.recordSshFallbackAudit
        ? mpls.recordSshFallbackAudit({
            hostId,
            actorId: user.id,
            actorUsername: user.username ?? null,
            previousValue,
            newValue: body.enabled,
            result,
            ...(reason ? { reason } : {}),
          })
        : Promise.resolve();

    if (user.role !== 'ADMIN') {
      await audit('DENIED_NOT_ADMIN', `papel ${user.role}`);
      return reply.code(403).send({ message: 'Somente ADMIN pode alterar o fallback CLI' });
    }
    if (body.enabled && !isHuaweiVrpDevice(host)) {
      await audit('DENIED_PLATFORM', 'plataforma não é Huawei VRP identificado');
      return reply.code(409).send({
        message:
          'Fallback CLI existe apenas para Huawei VRP identificado (fabricante/modelo). ' +
          'Corrija o cadastro do equipamento antes de habilitar.',
      });
    }
    if (body.enabled) {
      const protection = await autoAllProtection?.(host);
      if (protection?.protected) {
        await audit('DENIED_AUTO_ALL', protection.detail);
        return reply.code(409).send({
          code: 'AUTO_ALL_PROTECTED_DEVICE',
          message:
            'Equipamento protegido pelo AUTO-ALL: habilitar o fallback CLI MPLS exige ' +
            'política explícita e aprovação. Nada foi alterado.',
        });
      }
    }
    if (typeof mpls.setSshFallbackEnabled !== 'function' || typeof mpls.recordSshFallbackAudit !== 'function') {
      // Sem auditoria não há autorização: fail-closed.
      return reply.code(501).send({
        message: 'Repositório não suporta configurar o fallback CLI com trilha de auditoria',
      });
    }
    await audit('ALLOWED');
    await mpls.setSshFallbackEnabled(hostId, body.enabled);
    return { hostId, sshFallbackEnabled: body.enabled, previousValue };
  });
}
