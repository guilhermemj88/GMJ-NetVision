import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adaptLegacyVsiDiagnostic, summarizeVsiServiceRun, type AuthUser, type VsiDiagnosticResult, type VsiServiceRunSummary } from '@gmj/shared';
import { z } from 'zod';
import { hostIdSchema, interfaceNameSchema, vsiNameSchema } from './infrastructure/mpls/vsi-mcp/contracts';
import { VSI_RUN_ID, type VsiServiceResultArchive } from './infrastructure/mpls/vsi-service/archive';
import { VSI_SERVICE_LIMITS, VsiServiceError, type VsiServiceDiagnosticService } from './infrastructure/mpls/vsi-service/service';

/**
 * Rotas DEV do diagnostico VSI/VPLS por servico (contrato `VsiServiceDiagnosis`).
 *
 *   GET  /api/vsi-service-diagnostics/status
 *   POST /api/vsi-service-diagnostics                         executa (motor VSI/MCP, um PE por aprovacao)
 *   GET  /api/vsi-service-diagnostics[?vsiName=]              lista de resultados guardados (resumo)
 *   GET  /api/vsi-service-diagnostics/:runId                  resultado guardado (memoria ou arquivo)
 *   GET  /api/vsi-service-diagnostics/legacy/:hostId/:vsiId/:diagnosticId   job do LEGADO convertido
 *
 * PERMISSOES: listar e abrir resultados detalhados (inclui a rota `legacy`, por identificador) e executar sao
 * restritos a OPERATOR e ADMIN. VIEWER, cookie invalido ou sem sessao nao recebem nome de equipamento nem conteudo
 * de resultado: sem sessao = 401; VIEWER = 403 ANTES de qualquer leitura, validacao de identificador ou 404/503
 * (assim o identificador nunca serve de oraculo de existencia). `/status` continua para qualquer sessao: nao traz
 * resultado nem nome de equipamento.
 *
 * Default DESLIGADO: so com VSI_SERVICE_DIAGNOSTIC_ENABLED=true. A execucao exige ainda
 * VSI_MCP_ENABLED=true (sem ele `service` e null e o POST responde 503). Nenhuma rota existente
 * muda. As rotas GET so LEEM resultados ja guardados (memoria desta instancia ou a pasta de
 * `VSI_SERVICE_RESULTS_DIR`): nenhuma delas executa diagnostico ou abre SSH.
 */
/** Papeis que podem listar/abrir resultados detalhados e executar. VIEWER fica so com o inventario. */
export const VSI_RESULT_ROLES: ReadonlyArray<AuthUser['role']> = ['OPERATOR', 'ADMIN'];
export const canViewVsiResults = (user: Pick<AuthUser, 'role'> | null): boolean => user !== null && VSI_RESULT_ROLES.includes(user.role);

export function vsiServiceDiagnosticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VSI_SERVICE_DIAGNOSTIC_ENABLED ?? '').trim().toLowerCase() === 'true';
}

const runBody = z
  .object({
    vsiName: vsiNameSchema,
    endpoints: z
      .array(
        z
          .object({
            hostId: hostIdSchema,
            approvalId: z.uuid().optional(),
            interfaces: z.array(interfaceNameSchema).min(1).max(8).optional(),
            vlanId: z.number().int().min(1).max(4094).optional(),
            carrierInterfaces: z.array(interfaceNameSchema).min(1).max(4).optional(),
            eTrunkIds: z.array(z.number().int().min(1).max(16)).min(1).max(4).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(VSI_SERVICE_LIMITS.requestedEndpoints),
    includeMac: z.boolean().optional(),
    homologation: z.boolean().optional(),
  })
  .strict();

export function registerVsiServiceDiagnosticRoutes(
  app: FastifyInstance,
  service: VsiServiceDiagnosticService | null,
  legacy: { get(diagnosticId: string, hostId: string, vsiId: string): VsiDiagnosticResult } | null,
  currentUser: (request: FastifyRequest) => Promise<AuthUser | null>,
  env: NodeJS.ProcessEnv = process.env,
  archive: VsiServiceResultArchive | null = null,
): void {
  const enabled = vsiServiceDiagnosticEnabled(env);
  const user = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> => {
    const u = await currentUser(request);
    if (!u) void reply.code(401).send({ message: 'Sessão operacional obrigatória' });
    return u;
  };

  // Restrito: 401 sem sessao; 403 para qualquer papel fora de OPERATOR/ADMIN. Corpo generico, sem nada do recurso.
  const restricted = async (request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> => {
    const u = await user(request, reply);
    if (!u) return null;
    if (!canViewVsiResults(u)) {
      void reply.code(403).send({ message: 'Resultados detalhados do diagnóstico VSI exigem OPERATOR ou ADMIN.', code: 'RESULTS_RESTRICTED' });
      return null;
    }
    return u;
  };

  app.get('/api/vsi-service-diagnostics/status', async (request, reply) => {
    const current = await user(request, reply);
    if (!current) return reply;
    return reply.send({ enabled, resultsAccess: canViewVsiResults(current), engineAvailable: enabled && service !== null, legacyAvailable: enabled && legacy !== null, archiveAvailable: enabled && archive !== null });
  });

  if (!enabled) {
    // Mesmo desligado, sem sessao a resposta e 401: quem nao esta logado nao descobre o estado do recurso.
    const disabled = async (request: FastifyRequest, reply: FastifyReply) =>
      !(await restricted(request, reply)) ? reply : reply.code(503).send({ message: 'Diagnóstico VSI por serviço desabilitado (VSI_SERVICE_DIAGNOSTIC_ENABLED!=true).', enabled: false });
    app.post('/api/vsi-service-diagnostics', disabled);
    app.get('/api/vsi-service-diagnostics', disabled);
    app.get('/api/vsi-service-diagnostics/:runId', disabled);
    app.get('/api/vsi-service-diagnostics/legacy/:hostId/:vsiId/:diagnosticId', disabled);
    return;
  }

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof VsiServiceError) return reply.code(error.httpStatus).send({ message: error.message, code: error.code });
    throw error;
  };

  app.post('/api/vsi-service-diagnostics', async (request, reply) => {
    const u = await user(request, reply);
    if (!u) return reply;
    if (!canViewVsiResults(u)) return reply.code(403).send({ message: 'Execução exige ADMIN ou OPERATOR' });
    if (!service) return reply.code(503).send({ message: 'Motor VSI/MCP desabilitado (VSI_MCP_ENABLED!=true).', enabled: false });
    const body = runBody.parse(request.body ?? {});
    try {
      return reply.send(await service.run(body, u));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get('/api/vsi-service-diagnostics/legacy/:hostId/:vsiId/:diagnosticId', async (request, reply) => {
    if (!(await restricted(request, reply))) return reply;
    if (!legacy) return reply.code(503).send({ message: 'Diagnóstico legado indisponível nesta instalação.' });
    const p = z.object({ hostId: z.string().min(1), vsiId: z.string().min(1), diagnosticId: z.uuid() }).strict().parse(request.params);
    // Mesmo resultado que a rota legada devolve, so convertido de formato: evidencias, probes e veredito intactos.
    return reply.send(adaptLegacyVsiDiagnostic(legacy.get(p.diagnosticId, p.hostId, p.vsiId)));
  });

  // SOMENTE LEITURA: lista o que ja esta guardado. Nao executa nada.
  app.get('/api/vsi-service-diagnostics', async (request, reply) => {
    if (!(await restricted(request, reply))) return reply;
    const { vsiName } = z.object({ vsiName: vsiNameSchema.optional() }).strict().parse(request.query ?? {});
    const seen = new Set<string>();
    const runs: VsiServiceRunSummary[] = [];
    for (const [list, storedIn] of [[service?.list() ?? [], 'MEMORY'], [archive?.list() ?? [], 'ARCHIVE']] as const)
      for (const d of list) {
        if (seen.has(d.runId) || (vsiName !== undefined && d.vsiName !== vsiName)) continue;
        seen.add(d.runId);
        runs.push(summarizeVsiServiceRun(d, storedIn));
      }
    runs.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return reply.send({ runs });
  });

  // SOMENTE LEITURA: devolve um resultado guardado (memoria desta instancia, depois arquivo).
  app.get('/api/vsi-service-diagnostics/:runId', async (request, reply) => {
    if (!(await restricted(request, reply))) return reply;
    const { runId } = z.object({ runId: z.string().regex(VSI_RUN_ID) }).strict().parse(request.params);
    if (service) {
      try {
        return reply.send(service.get(runId));
      } catch (error) {
        if (!(error instanceof VsiServiceError && error.code === 'RUN_NOT_FOUND')) return fail(reply, error);
      }
    }
    const stored = archive?.get(runId) ?? null;
    if (stored) return reply.send(stored);
    if (!service && !archive) return reply.code(503).send({ message: 'Motor VSI/MCP desabilitado e nenhum arquivo de resultados configurado.', enabled: false });
    return reply.code(404).send({ message: 'Resultado não encontrado.', code: 'RUN_NOT_FOUND' });
  });
}
