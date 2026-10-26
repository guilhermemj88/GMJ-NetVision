import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '@gmj/shared';
import { z } from 'zod';
import {
  VsiDiagnosticError,
  type VsiDiagnosticService,
} from './infrastructure/mpls/vsi-diagnostic-service';
import type { VsiDiagnosticApprovalStore } from './infrastructure/mpls/vsi-diagnostic-approval';
import { readVsiAccessProfiles } from './infrastructure/mpls/vsi-diagnostic-ssh';
/**
 * Gate de ativacao. Default FALSE: sem a flag a acao produtiva nao existe e nenhum SSH pode ocorrer.
 * Fica FORA da logica field-validated (precheck/runner/parsers/policy).
 */
export function vsiDiagnosticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VSI_DIAGNOSTIC_ENABLED ?? '').trim().toLowerCase() === 'true';
}
let trustProbe: { at: number; state: 'AVAILABLE' | 'UNAVAILABLE' } | null = null;
/**
 * Estado do trust para a UI. Somente leitura, com cache curto: o arquivo e
 * revalidado pelo loader real (modo, symlink, tamanho, schema).
 */
export async function vsiDiagnosticTrustState(
  now = Date.now(),
): Promise<'AVAILABLE' | 'UNAVAILABLE'> {
  if (trustProbe && now - trustProbe.at < 30_000) return trustProbe.state;
  let state: 'AVAILABLE' | 'UNAVAILABLE' = 'UNAVAILABLE';
  try {
    const profiles = await readVsiAccessProfiles(process.env.VSI_DIAGNOSTIC_ACCESS_FILE);
    state = profiles.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE';
  } catch {
    state = 'UNAVAILABLE';
  }
  trustProbe = { at: now, state };
  return state;
}
const params = z
  .object({ hostId: z.string().min(1).max(100), vsiId: z.string().min(1).max(100) })
  .strict();
export function registerVsiDiagnosticRoutes(
  app: FastifyInstance,
  service: VsiDiagnosticService,
  currentUser: (request: FastifyRequest) => Promise<AuthUser | null>,
  approvals: VsiDiagnosticApprovalStore,
) {
  /**
   * Estado do recurso para a UI. Registrada ANTES do gate: precisa responder tanto
   * com a feature ligada quanto desligada, e nunca toca service, runner ou socket.
   */
  app.get('/api/diagnostics/status', async (request, reply) => {
    const user = await currentUser(request);
    if (!user) throw new VsiDiagnosticError('Sessão operacional obrigatória', 401);
    z.object({})
      .strict()
      .parse(request.query ?? {});
    return reply.send({
      diagnosticEnabled: vsiDiagnosticEnabled(),
      diagnosticTrust: await vsiDiagnosticTrustState(),
    });
  });
  if (!vsiDiagnosticEnabled()) {
    const disabled = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.code(503).send({
        message:
          'Diagnostico VSI desabilitado nesta instalacao (VSI_DIAGNOSTIC_ENABLED=false).',
        enabled: false,
      });
    app.post('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnose', disabled);
    app.post('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnostic-approvals', disabled);
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
  app.post('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnostic-approvals', async (request, reply) => {
    const user = await authorize(request, true);
    if (user.role !== 'ADMIN')
      throw new VsiDiagnosticError('Criação de aprovação exige ADMIN', 403);
    const { hostId, vsiId } = params.parse(request.params);
    const body = z
      .object({ ttlSeconds: z.number().int().min(30).max(900).optional() })
      .strict()
      .parse(request.body ?? {});
    return reply
      .code(201)
      .send(approvals.create({ hostId, vsiId, createdBy: user.username, ttlSeconds: body.ttlSeconds }));
  });
  app.post('/api/hosts/:hostId/mpls/vsis/:vsiId/diagnose', async (request, reply) => {
    const user = await authorize(request, true);
    const body = z
      .object({ approvalId: z.string().min(1).max(64).optional() })
      .strict()
      .parse(request.body ?? {});
    const { hostId, vsiId } = params.parse(request.params);
    return reply.code(202).send(await service.start(hostId, vsiId, user, body.approvalId));
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
