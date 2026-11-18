import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthUser } from '@gmj/shared';
import { z } from 'zod';
import type { VsiDiagnosticApprovalStore } from './infrastructure/mpls/vsi-diagnostic-approval';
import { VSI_MCP_TOOLS, approvalScope, hostIdSchema, vsiNameSchema, type VsiMcpToolName } from './infrastructure/mpls/vsi-mcp/contracts';
import { VsiMcpToolError, type VsiMcpTools } from './infrastructure/mpls/vsi-mcp/tools';
import { vsiMcpEnabled, vsiMcpServiceAccounts } from './infrastructure/mpls/vsi-mcp/access-profile';

/**
 * Rotas do diagnostico VSI/MPLS para MCP.
 *
 *   GET  /api/vsi-mcp/status              estado do recurso (sempre registrada)
 *   POST /api/vsi-mcp/approvals           ADMIN: cria aprovacao one-shot (host + VSI)
 *   POST /api/vsi-mcp/tools/:tool         executa uma das 8 ferramentas
 *
 * Default DESLIGADO (VSI_MCP_ENABLED != true): so /status responde; as demais
 * devolvem 503 e nenhum coletor e criado.
 */
export function registerVsiMcpRoutes(
  app: FastifyInstance,
  tools: VsiMcpTools | null,
  currentUser: (request: FastifyRequest) => Promise<AuthUser | null>,
  approvals: VsiDiagnosticApprovalStore,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const enabled = vsiMcpEnabled(env) && tools !== null;

  app.get('/api/vsi-mcp/status', async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ message: 'Sessão operacional obrigatória' });
    return reply.send({ enabled, tools: Object.keys(VSI_MCP_TOOLS) });
  });

  if (!enabled) {
    const disabled = async (_request: FastifyRequest, reply: import('fastify').FastifyReply) =>
      reply.code(503).send({ message: 'Diagnostico VSI por MCP desabilitado (VSI_MCP_ENABLED!=true).', enabled: false });
    app.post('/api/vsi-mcp/approvals', disabled);
    app.post('/api/vsi-mcp/tools/:tool', disabled);
    return;
  }

  app.post('/api/vsi-mcp/approvals', async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ message: 'Sessão operacional obrigatória' });
    if (user.role !== 'ADMIN') return reply.code(403).send({ message: 'Criação de aprovação exige ADMIN' });
    // Conta de SERVICO (ex.: MCP) nunca aprova: aprovar e executar sao funcoes separadas.
    if (vsiMcpServiceAccounts(env).has(user.username))
      return reply.code(403).send({ message: 'Conta de servico nao pode criar aprovacao' });
    const body = z
      .object({ hostId: hostIdSchema, vsiName: vsiNameSchema.optional(), ttlSeconds: z.number().int().min(30).max(900).optional() })
      .strict()
      .parse(request.body ?? {});
    return reply
      .code(201)
      .send(approvals.create({ hostId: body.hostId, vsiId: approvalScope(body.vsiName), createdBy: user.username, ttlSeconds: body.ttlSeconds }));
  });

  app.post('/api/vsi-mcp/tools/:tool', async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ message: 'Sessão operacional obrigatória' });
    const { tool } = z
      .object({ tool: z.enum(Object.keys(VSI_MCP_TOOLS) as [VsiMcpToolName, ...VsiMcpToolName[]]) })
      .strict()
      .parse(request.params);
    z.object({}).strict().parse(request.query ?? {});
    try {
      return reply.send(await tools!.call(tool, request.body, user));
    } catch (error) {
      if (error instanceof VsiMcpToolError)
        return reply.code(error.httpStatus).send({ message: error.message, code: error.code });
      throw error;
    }
  });
}
