import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '@gmj/shared';
import { z } from 'zod';
import {
  VsiDiagnosticError,
  type VsiDiagnosticService,
} from './infrastructure/mpls/vsi-diagnostic-service';
/**
 * Gate de ativacao. Default FALSE: sem a flag a acao produtiva nao existe e nenhum SSH pode ocorrer.
 * Fica FORA da logica field-validated (precheck/runner/parsers/policy).
 */
export function vsiDiagnosticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VSI_DIAGNOSTIC_ENABLED ?? '').trim().toLowerCase() === 'true';
}
const params = z
  .object({ hostId: z.string().min(1).max(100), vsiId: z.string().min(1).max(100) })
  .strict();
export function registerVsiDiagnosticRoutes(
  app: FastifyInstance,
  service: VsiDiagnosticService,
  currentUser: (request: FastifyRequest) => Promise<AuthUser | null>,
) {
  if (!vsiDiagnosticEnabled()) {
    const disabled = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.code(503).send({
        message:
          'Diagnostico VSI desabilitado nesta instalacao (VSI_DIAGNOSTIC_ENABLED=false).',
        enabled: false,
      });
    app.post('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnose', disabled);
    app.get('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnostics/:diagnosticId', disabled);
    app.post('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnostics/:diagnosticId/cancel', disabled);
    return;
  }
  const authorize = async (request: FastifyRequest, write: boolean) => {
    const user = await currentUser(request);
    if (!user) throw new VsiDiagnosticError('Sessão operacional obrigatória', 401);
    if (write && !['ADMIN', 'OPERATOR'].includes(user.role))
      throw new VsiDiagnosticError('Execução exige ADMIN ou OPERATOR', 403);
    z.object({})
      .strict()
      .parse(request.query ?? {});
    return user;
  };
  app.post('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnose', async (request, reply) => {
    const user = await authorize(request, true);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    const { hostId, vsiId } = params.parse(request.params);
    return reply.code(202).send(await service.start(hostId, vsiId, user));
  });
  const jobParams = params.extend({ diagnosticId: z.uuid() });
  app.get('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnostics/:diagnosticId', async (request) => {
    await authorize(request, false);
    const { hostId, vsiId, diagnosticId } = jobParams.parse(request.params);
    return service.get(diagnosticId, hostId, vsiId);
  });
  app.post(
    '/api/hosts/:hostId/mpls/vsis/:vsiId/diagnostics/:diagnosticId/cancel',
    async (request) => {
      const user = await authorize(request, true);
      z.object({})
        .strict()
        .parse(request.body ?? {});
      const { hostId, vsiId, diagnosticId } = jobParams.parse(request.params);
      return service.cancel(diagnosticId, hostId, vsiId, user);
    },
  );
}
